const test = require('node:test')
const assert = require('node:assert/strict')
const { loader } = require('./helpers/load-typescript.cjs')
const flush = () => new Promise(resolve => setImmediate(resolve))

test('health destinations are credential-free canonical model identities and reject unsafe endpoints', () => {
  const { healthDestinationForModel } = loader({ URL }, {})('app/assistant/health-destination.ts')
  assert.equal(healthDestinationForModel({ provider: 'local', model: 'apple-foundation-model' }), 'local:apple-foundation-model')
  assert.equal(healthDestinationForModel({ provider: 'openai', model: 'gpt-5.6-luna' }), 'openai:gpt-5.6-luna')
  assert.equal(healthDestinationForModel({ provider: 'hermes', model: 'hermes-agent', baseUrl: 'https://agent.test' }), null)
  assert.equal(healthDestinationForModel({ provider: 'openai-compatible', model: 'private model', baseUrl: 'HTTPS://Example.COM/v1/?key=secret#fragment' }),
    'openai-compatible:private%20model@https://example.com/v1')
  assert.equal(healthDestinationForModel({ provider: 'openai-compatible', model: 'm', baseUrl: 'https://user:secret@example.com/v1' }), null)
  assert.equal(healthDestinationForModel({ provider: 'openai-compatible', model: 'm', baseUrl: 'file:///tmp/model' }), null)
  assert.equal(healthDestinationForModel({ provider: 'openai-compatible', model: 'm', baseUrl: 'not a URL' }), null)
  assert.equal(healthDestinationForModel({ provider: 'invented', model: 'm', baseUrl: 'https://example.com' }), null)
})

test('tool registry supplies trusted context, aborts timed-out work, and keeps one-argument tools working', async () => {
  let timeout, context, legacyArgs, abortParent
  const parentSignal = { aborted: false,
    addEventListener: (_type, listener) => { abortParent = () => { parentSignal.aborted = true; listener() } },
    removeEventListener() {} }
  const { ToolRegistry } = loader({
    Promise, setTimeout: fn => { timeout = fn; return 1 }, clearTimeout() {},
  }, {})('app/assistant/tool-registry.ts')
  const registry = new ToolRegistry()
  registry.registerSystemTool({ name: 'health.apple_summary', description: 'Health', inputSchema: {}, timeoutMs: 5 },
    (_args, received) => { context = received; return new Promise(() => {}) })
  registry.registerSystemTool({ name: 'timer.set', description: 'Timer', inputSchema: {} },
    args => { legacyArgs = args; return { ok: true, content: 'set' } })

  const pending = registry.callTool('health.apple_summary', { healthDestination: 'attacker', baseUrl: 'https://evil.test' },
    { healthDestination: 'local:apple-foundation-model', signal: parentSignal })
  assert.equal(context.healthDestination, 'local:apple-foundation-model')
  assert.equal(context.signal.aborted, false)
  abortParent(); assert.equal(context.signal.aborted, true)
  timeout()
  const result = await pending
  assert.equal(result.ok, false); assert.match(result.error, /timed out/)
  assert.equal(context.signal.aborted, true)

  assert.equal((await registry.callTool('timer.set', { seconds: 60 })).ok, true)
  assert.deepEqual(legacyArgs, { seconds: 60 })
})

test('direct backend passes only turn-owned health identity and aborts the tool signal on cancellation', async () => {
  let stream, toolOptions
  const { DirectAssistantBackend } = loader({ setTimeout, clearTimeout }, {
    '../native/openai': { streamOpenAiResponse: options => { stream = options; return { cancel() {} } } },
    '../native/anthropic': {}, '../native/local-llm': {}, '../native/hermes': {}, '../native/openai-chat': {},
  })('app/assistant/direct-backend.ts')
  const backend = new DirectAssistantBackend()
  const turn = backend.runTurn({
    provider: 'openai', apiKey: 'secret', model: 'gpt', system: 'test', messages: [],
    buildTools: () => [], resolveToolName: name => name,
    registry: { callTool: (_name, _args, options) => { toolOptions = options; return new Promise(() => {}) } },
    callbacks: { onTextDelta() {}, onToolActivity() {}, onTurnDone() {}, onError() {} },
  })
  stream.onDone({ text: '', stopReason: 'tool_use', content: [{ type: 'tool_use', id: '1', name: 'health.apple_summary',
    input: { healthDestination: 'openai:attacker', baseUrl: 'https://evil.test' } }] })
  await flush()
  assert.equal(toolOptions.healthDestination, 'openai:gpt')
  assert.equal(toolOptions.signal.aborted, false)
  turn.cancel()
  assert.equal(toolOptions.signal.aborted, true)
})

test('successful health use persists its destination and blocks replay after model or endpoint changes', () => {
  const turns = [], errors = []
  class Backend {
    runTurn(options) {
      turns.push(options)
      options.onToolResult('health.apple_summary', { ok: true, content: 'private summary' })
      options.callbacks.onTurnDone({ stopReason: 'end_turn' })
      return { cancel() {} }
    }
  }
  const load = loader({ URL }, {
    './direct-backend': { DirectAssistantBackend: Backend },
    './bridge-client': { assistantBridge: { sendUtterance: () => ({ cancel() {} }) } },
    './tool-registry': { toolRegistry: { listTools: () => [] } },
    '../prompts': { ASSISTANT_SYSTEM_PROMPT_BASE: 'test', buildAssistantSystemPrompt: () => 'test', describeAssistantContext: () => '' },
  })
  const { AssistantSession } = load('app/assistant/session.ts')
  const config = (model, baseUrl) => ({ kind: 'direct', llm: { provider: 'openai-compatible', model, baseUrl, apiKey: 'secret' } })
  const callbacks = { onTextDelta() {}, onToolActivity() {}, onTurnDone() {}, onError: message => errors.push(message) }
  const session = new AssistantSession(config('model-a', 'https://one.example/v1?credential=secret'), { listTools: () => [] })
  session.sendUtterance('Read my health', {}, callbacks)
  const saved = JSON.parse(JSON.stringify(session.history()))
  assert.equal(saved.healthDestination, 'openai-compatible:model-a@https://one.example/v1')
  assert.doesNotMatch(saved.healthDestination, /credential|secret/)

  session.configure(config('model-b', 'https://one.example/v1'))
  session.sendUtterance('Continue', {}, callbacks)
  assert.equal(turns.length, 1); assert.match(errors.at(-1), /original assistant|new conversation/i)

  const restored = new AssistantSession(config('model-a', 'https://two.example/v1'), { listTools: () => [] }, saved)
  restored.sendUtterance('Continue', {}, callbacks)
  assert.equal(turns.length, 1); assert.match(errors.at(-1), /original assistant|new conversation/i)

  const original = new AssistantSession(config('model-a', 'https://one.example/v1'), { listTools: () => [] }, saved)
  original.sendUtterance('Continue safely', {}, callbacks)
  assert.equal(turns.length, 2)
})
