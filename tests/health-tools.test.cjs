const test = require('node:test')
const assert = require('node:assert/strict')
const { loader } = require('./helpers/load-typescript.cjs')

function harness() {
  let allowed = '', reads = 0, finish
  const tools = new Map()
  const load = loader({}, {
    '../native/apple-health': { isAppleHealthAvailable: () => true,
      readAppleHealthSummary: () => { reads++; return new Promise(resolve => { finish = resolve }) } },
    '../native/settings-store': { getStringSetting: () => allowed, setStringSetting: (_key, value) => { allowed = value } },
  })
  load('app/assistant/health-tools.ts').registerHealthTools({ registerSystemTool: (spec, handler) => tools.set(spec.name, { spec, handler }) })
  return { tool: tools.get('health.apple_summary'), consent: load('app/assistant/health-access.ts'),
    reads: () => reads, finish: value => finish(value) }
}

test('health tools require phone consent for the trusted destination and reject argument overrides', async () => {
  const h = harness()
  assert.equal(h.tool.spec.proactive, undefined)
  assert.equal((await h.tool.handler({ day: 'today' }, { healthDestination: 'openai:a' })).ok, false)
  h.consent.setHealthSharingDestination('openai:a')
  assert.equal((await h.tool.handler({ day: 'today', healthDestination: 'openai:a' }, { healthDestination: 'openai:b' })).ok, false)
  assert.equal((await h.tool.handler({ day: 'today' }, { healthDestination: 'openai:b' })).ok, false)
  assert.equal(h.reads(), 0)
  const pending = h.tool.handler({ day: 'today' }, { healthDestination: 'openai:a' })
  h.finish({ source: 'apple-health', metrics: { steps: null } })
  assert.equal(JSON.parse((await pending).content).metrics.steps, null)
})

test('revocation or turn cancellation while HealthKit runs discards the result', async () => {
  for (const cancel of [false, true]) {
    const h = harness(), signal = { aborted: false }
    h.consent.setHealthSharingDestination('openai:a')
    const pending = h.tool.handler({ day: 'yesterday' }, { healthDestination: 'openai:a', signal })
    if (cancel) signal.aborted = true
    else h.consent.setHealthSharingDestination(null)
    h.finish({ private: 'must not leave phone' })
    const result = await pending
    assert.equal(result.ok, false)
    assert.equal(result.content, undefined)
  }
})
