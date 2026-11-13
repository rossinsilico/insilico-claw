const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

function questionLayer(prompt, size = { width: 220, height: 112 }) {
  const drawn = [];
  const font = {
    lineHeight: 12,
    measureText: (text) => text.length * 6,
    getGlyph: (codePoint) => ({ dwidthX: codePoint ? 6 : 0 }),
  };
  class Image {
    constructor(width = 220, height = 112) { this.width = width; this.height = height; }
    fillRect() {}
    drawRect() {}
    drawText(_font, _x, _y, text) { drawn.push(text); }
  }
  const load = loader({ setTimeout, clearTimeout }, {
    '../../graphics/image': { GrayImage: Image },
    '../../graphics/ui-fonts': { getDefaultSmallFont: () => font },
  });
  const { AssistantQuestionLayer } = load('app/ui/shell/assistant-question.ts');
  let answer;
  let resolves = 0;
  const removed = [];
  const layer = new AssistantQuestionLayer(prompt, (value) => {
    answer = value;
    resolves++;
  });
  const ctx = {
    stack: {
      getBaseSize: () => size,
      remove: (value) => { removed.push(value); value.onRemoved?.(); return true; },
    },
    actions: { requestRender() {} },
  };
  const paint = () => { drawn.length = 0; layer.paint(ctx); return [...drawn]; };
  const input = (type) => layer.handleInput({ type }, ctx);
  return { layer, paint, input, answer: () => answer, resolves: () => resolves, removed };
}

function prompt(overrides = {}) {
  return {
    id: 'question-1',
    expiresAtMs: Date.now() + 60_000,
    signal: { aborted: false, addEventListener() {}, removeEventListener() {} },
    questions: [{
      questionId: 'recipient',
      header: 'Confirm recipient',
      question: 'Send the exact message to Jordan at the saved mobile number?',
      options: [
        { label: 'Jordan mobile', value: '+15551234567', description: 'Send the message exactly as shown.' },
        { label: 'Cancel this send', description: 'Leave the pending operation unanswered.' },
      ],
    }],
    ...overrides,
  };
}

test('short question stays above the choices with one page per option', () => {
  const h = questionLayer(prompt({ questions: [{
    questionId: 'color', question: 'Red or Blue?', options: [{ label: 'Red' }, { label: 'Blue' }],
  }] }), { width: 360, height: 220 });
  try {
  const first = h.paint().join(' ');
  assert.match(first, /Red or Blue\?/);
  assert.match(first, /Page 1\/2/);
  assert.match(first, /Choice 1 of 2 Red/);
  assert.equal(h.answer(), undefined, 'showing the first choice does not select it');
  h.input('scroll-down');
  h.input('click');
  assert.equal(h.answer(), undefined, 'new choice still requires its repaint');
  const second = h.paint().join(' ');
  assert.match(second, /Red or Blue\?/);
  assert.match(second, /Page 2\/2/);
  assert.match(second, /Choice 2 of 2 Blue/);
  h.input('click');
  assert.equal(JSON.stringify(h.answer()), '{"color":[1]}');
  } finally { h.input('double-click'); }
});

test('question text is paged before complete choices and only a visible choice can answer', () => {
  const h = questionLayer(prompt());
  const seen = [];
  seen.push(...h.paint());
  h.input('click');
  assert.equal(h.answer(), undefined, 'the question page has no default approval');
  for (let i = 0; i < 20 && h.answer() === undefined; i++) {
    h.input('scroll-down');
    const page = h.paint();
    seen.push(...page);
    if (page.some((line) => line.includes('click choose'))) h.input('click');
  }
  assert.equal(JSON.stringify(h.answer()), '{"recipient":[0]}');
  assert.equal(h.resolves(), 1);
  const visibleText = seen.join(' ').replace(/\s+/g, ' ');
  assert.match(visibleText, /Send the exact message to/);
  assert.match(visibleText, /Jordan at the saved mobile number/);
  assert.match(visibleText, /Jordan mobile/);
  assert.match(visibleText, /\+15551234567/);
  assert.match(visibleText, /Send the message exactly as/);
  assert.match(visibleText, /shown\./);
});

test('a click cannot select a newly scrolled choice until that page is painted', () => {
  const h = questionLayer(prompt({ questions: [{
    questionId: 'send', question: 'Send once?', options: [{ label: 'Cancel' }, { label: 'Send once' }],
  }] }));
  h.paint();
  h.input('scroll-down');
  assert.match(h.paint().join(' '), /Cancel/);
  h.input('scroll-down');
  h.input('click');
  assert.equal(h.answer(), undefined, 'click before repaint cannot select the unseen second choice');
  assert.match(h.paint().join(' '), /Send once/);
  h.input('click');
  assert.equal(JSON.stringify(h.answer()), '{"send":[1]}');
});

test('multiple queued scrolls cannot select their destination before one paint', () => {
  const h = questionLayer(prompt({ questions: [{
    questionId: 'send', question: 'Send once?', options: [{ label: 'Cancel' }, { label: 'Send once' }],
  }] }));
  h.paint();
  h.input('scroll-down');
  h.input('scroll-down');
  h.input('click');
  assert.equal(h.answer(), undefined);
  assert.match(h.paint().join(' '), /Send once/);
  h.input('click');
  assert.equal(JSON.stringify(h.answer()), '{"send":[1]}');
});

test('multiple single-choice questions resolve once; dismiss and unsupported multi-select fail closed', () => {
  const two = questionLayer(prompt({ questions: [
    { questionId: 'recipient', question: 'Which recipient?', options: [{ label: 'Jordan' }] },
    { questionId: 'message', question: 'Which exact message?', options: [{ label: 'Dinner at seven' }] },
  ] }));
  for (let question = 0; question < 2; question++) {
    for (let i = 0; i < 10; i++) {
      two.input('scroll-down');
      if (two.paint().some((line) => line.includes('Choice 1 of 1'))) { two.input('click'); break; }
    }
  }
  two.input('click');
  assert.equal(JSON.stringify(two.answer()), '{"recipient":[0],"message":[0]}');
  assert.equal(two.resolves(), 1, 'duplicate input cannot resolve twice');

  const dismissed = questionLayer(prompt());
  dismissed.input('double-click');
  assert.equal(dismissed.answer(), null);
  assert.equal(dismissed.resolves(), 1);

  const unsupported = questionLayer(prompt({ questions: [{
    questionId: 'many', question: 'Pick many', multiSelect: true, options: [{ label: 'One' }],
  }] }));
  assert.equal(unsupported.answer(), null);
  assert.equal(unsupported.resolves(), 1);
});

test('expiry and transport cancellation close questions unanswered', async () => {
  const expiring = questionLayer(prompt({ expiresAtMs: Date.now() + 5 }));
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(expiring.answer(), null);
  assert.equal(expiring.resolves(), 1);

  const controller = new AbortController();
  const cancelled = questionLayer(prompt({ signal: controller.signal }));
  controller.abort();
  assert.equal(cancelled.answer(), null);
  assert.equal(cancelled.resolves(), 1);
});

test('session forwards questions but drops answers after cancellation', async () => {
  const turns = [];
  const load = loader({}, {
    '../prompts': { ASSISTANT_SYSTEM_PROMPT_BASE: '', buildAssistantSystemPrompt: () => '', describeAssistantContext: () => '' },
    './bridge-client': { assistantBridge: {} },
    './direct-backend': { DirectAssistantBackend: class { runTurn(options) {
      turns.push(options);
      return { cancel() {} };
    } } },
    './tool-registry': { toolRegistry: { listTools: () => [] } },
  });
  const { AssistantSession } = load('app/assistant/session.ts');
  const session = new AssistantSession({ kind: 'direct', llm: {
    selection: 'test', provider: 'openai', model: 'test', apiKey: '',
  } });
  let finishQuestion;
  const callbacks = {
    onTextDelta() {}, onToolActivity() {}, onTurnDone() {}, onError() {},
    onQuestion: () => new Promise((resolve) => { finishQuestion = resolve; }),
  };
  session.sendUtterance('send it', {}, callbacks);
  const pending = turns[0].callbacks.onQuestion(prompt());
  session.cancel();
  finishQuestion({ recipient: [0] });
  assert.equal(await pending, null);
});

test('shell presents a question layer for assistant turns without an assistant overlay', async () => {
  class Stack {
    constructor(base) { this.layers = [base]; }
    setActions() {}
    push(layer) { this.layers.push(layer); }
    remove(layer) { const index = this.layers.indexOf(layer); if (index < 1) return false; this.layers.splice(index, 1); layer.onRemoved?.(); return true; }
    topMatches(predicate) { return this.layers.length > 1 && predicate(this.layers.at(-1)); }
  }
  class QuestionLayer {
    constructor(value, resolve) {
      this.value = value;
      this.resolve = resolve;
      if (QuestionLayer.resolveSynchronously) resolve(null);
    }
    onRemoved() { this.resolve(null); }
  }
  class ModalLayer {
    constructor(content, _actions, hooks) { this.content = content; this.hooks = hooks; }
    onRemoved() { this.hooks.removed?.(); }
  }
  let turnCallbacks;
  const session = {
    isTurnActive: () => false,
    sendUtterance: (_text, _ctx, callbacks) => { turnCallbacks = callbacks; },
  };
  const settings = { assistantSkipConfirmationSetting: { get: () => false } };
  const load = loader({ global: { isIOS: false } }, {
    '../../graphics/shell-scene': { encodeShellScene: () => new Uint8Array() },
    '../../graphics/image': { GrayImage: class {} }, '../../graphics/plane': {}, '../../graphics/ui-fonts': {},
    '../../g2/events': {}, '../input-monitor': { acceptInput: () => true }, '../gestures': {},
    '../layers': { LayerStack: Stack, noopLayerActions: {} }, '../menu': { MenuLayer: class {} }, './voice-input': {},
    './keyboard-input': {}, './voice-activity': { voiceActivity: { setActive() {} } }, './assistant': {},
    './assistant-question': { AssistantQuestionLayer: QuestionLayer, isSupportedAssistantQuestionPrompt: () => true }, '../../assistant/session': {},
    '../../assistant/models': {}, '../../assistant/conversations': {}, '../../native/settings-store': {},
    '../notifications': {}, '../dashboard-settings': settings, './ambient-cards': {},
    './chrome-layer': { ShellChromeLayer: class {} }, './modal-layer': { ShellModalLayer: ModalLayer },
    './notification-modal-queue': { NotificationModalQueue: class {} }, './notification-popup-timeout': {},
    '../../native/notification-icons': {}, './tool-debug-layer': {}, './in-process-window': {},
    './brightness-picker-layer': {}, '../../assistant/tool-registry': {}, './geometry': {
      screenWidth: () => 640, screenHeight: () => 480, uiDepth: () => 0,
    },
  });
  const { shell } = load('app/ui/shell/shell.ts');
  shell.ensureAssistantSession = () => session;
  shell.sendToAssistant('send it', false);
  const pending = turnCallbacks.onQuestion(prompt());
  assert.ok(shell.stack.topMatches((layer) => layer instanceof ModalLayer && layer.content instanceof QuestionLayer));
  const modal = shell.stack.layers.at(-1);
  modal.content.resolve({ recipient: [1] });
  assert.equal(JSON.stringify(await pending), '{"recipient":[1]}');
  assert.equal(shell.stack.layers.length, 1, 'answer removes the bounded modal wrapper');
  const cancelled = turnCallbacks.onQuestion(prompt());
  shell.stack.remove(shell.stack.layers.at(-1));
  assert.equal(await cancelled, null, 'removing the modal cancels its pending question');
  QuestionLayer.resolveSynchronously = true;
  assert.equal(await turnCallbacks.onQuestion(prompt()), null);
  assert.equal(shell.stack.layers.length, 1, 'a synchronously expired layer is not pushed');
});
