const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

function harness() {
  let now = 0, routed = 0;
  let display = '5s';
  const muted = new Set();
  class Stack {
    constructor(base) { this.layers = [base]; }
    push(layer) { this.layers.push(layer); }
    remove(layer) { const index = this.layers.indexOf(layer); if (index < 1) return false; this.layers.splice(index, 1); layer.onRemoved?.(); return true; }
    topMatches(predicate) { return this.layers.length > 1 && predicate(this.layers.at(-1)); }
    paintUndimmed() { return []; }
    paint() { return []; }
    isAtBase() { return this.layers.length === 1; }
    clearToBase() { while (!this.isAtBase()) this.remove(this.layers.at(-1)); }
  }
  class ModalLayer {
    constructor(content, _actions, hooks) { this.content = content; this.hooks = hooks; }
    onRemoved() { this.hooks.removed?.(); }
  }
  const active = [{ key: 'one', packageName: 'mail' }, { key: 'two', packageName: 'mail' }];
  const load = loader({ Date: class extends Date { static now() { return now; } }, global: { isIOS: false }, setTimeout: () => 1, clearTimeout() {} }, {
    '../../graphics/shell-scene': { encodeShellScene: () => new Uint8Array() },
    '../../graphics/image': { GrayImage: class {} }, '../../graphics/plane': { singlePlane: () => [] }, '../../graphics/ui-fonts': {},
    '../../g2/events': {}, '../input-monitor': { acceptInput: () => true }, '../gestures': {},
    '../layers': { LayerStack: Stack, noopLayerActions: {} }, '../menu': { MenuLayer: class {} }, './voice-input': {},
    './keyboard-input': {}, './voice-activity': { voiceActivity: { setActive() {} } }, './assistant': {},
    './assistant-question': {}, '../../assistant/session': {}, '../../assistant/models': {}, '../../assistant/conversations': {}, '../../native/settings-store': {},
    '../notifications': { ALL_NOTIFICATIONS: {}, readActiveNotifications: () => active, SingleNotificationLayer: class { constructor(key) { this.key = key; this.confirming = false; } outlivesNotification() { return this.confirming; } } },
    '../dashboard-settings': { newNotificationDisplaySetting: { get: () => display }, newNotificationDisplayTimeoutMs: () => 5000, shouldPopUpNewNotification: id => display !== 'off' && !muted.has(id) }, './ambient-cards': {},
    './chrome-layer': { ShellChromeLayer: class {} }, './modal-layer': { ShellModalLayer: ModalLayer },
    '../../native/notification-icons': { readActiveNotifications: () => active }, './tool-debug-layer': {}, './in-process-window': {}, './brightness-picker-layer': {}, '../../assistant/tool-registry': {},
    './geometry': { screenWidth: () => 640, screenHeight: () => 480, uiDepth: () => 0 },
  });
  const { shell } = load('app/ui/shell/shell.ts');
  shell.screenOn = true;
  shell.config = { ...shell.config, supportsTimedNotificationVisuals: () => true, requestShellRender() {} };
  shell.syncInputFocus = () => {};
  shell.routeInput = async () => { routed++; return { shell: true, window: false }; };
  return { shell, active, muted, setDisplay(value) { display = value; }, setNow(value) { now = value; }, routed: () => routed };
}

test('muting an app retires its visible and queued interruptions without changing the notification inventory', () => {
  const h = harness();
  h.shell.openNotificationModal('one', false);
  h.shell.openNotificationModal('two', false);
  h.muted.add('mail');
  h.shell.paintScene();
  assert.equal(h.shell.notificationModals.currentModal(), null);
  assert.equal(h.shell.stack.layers.length, 1);
  assert.equal(h.active.length, 2);
});

test('a mute-change click cannot activate the next allowed notification', async () => {
  const h = harness(); h.active[1].packageName = 'calendar';
  h.shell.openNotificationModal('one', false); h.shell.openNotificationModal('two', false);
  h.muted.add('mail');
  await h.shell.receiveInput({ type: 'click' });
  assert.equal(h.routed(), 0);
  assert.equal(h.shell.notificationModals.currentModal().content.key, 'two');
  await h.shell.receiveInput({ type: 'click' });
  assert.equal(h.routed(), 1);
});

test('turning popups off closes a covered phone notification immediately', () => {
  const h = harness(); h.shell.openNotificationModal('one', false);
  const overlay = {}; h.shell.stack.push(overlay);
  h.setDisplay('off'); h.shell.paintScene();
  assert.equal(h.shell.notificationModals.currentModal(), null);
  assert.deepEqual(h.shell.stack.layers, [h.shell.stack.layers[0], overlay]);
});

test('the shell admission gate rejects muted and missing phone notifications', () => {
  const h = harness(); h.muted.add('mail');
  h.shell.openNotificationModal('one', false); h.shell.openNotificationModal('missing', false);
  assert.equal(h.shell.notificationModals.currentModal(), null);
  assert.equal(h.shell.stack.layers.length, 1);
});

test('a local hide confirmation remains usable after the original notification disappears', () => {
  const h = harness(); h.shell.openNotificationModal('one', false);
  const popup = h.shell.notificationModals.currentModal(); popup.content.confirming = true;
  h.active.length = 0; h.shell.paintScene();
  assert.equal(h.shell.notificationModals.currentModal(), popup);
  popup.content.confirming = false; h.shell.paintScene();
  assert.equal(h.shell.notificationModals.currentModal(), null);
});

test('an app-owned alert retains its own lifecycle when phone popups are disabled', () => {
  const h = harness(); h.setDisplay('off');
  h.shell.postAppNotification({ key: 'app-alert', createLayer: () => ({}) });
  const popup = h.shell.notificationModals.currentModal();
  h.shell.paintScene();
  assert.equal(h.shell.notificationModals.currentModal(), popup);
});

test('a relay quiet-state update retires the visible popup and skips quiet queued notifications', () => {
  const h = harness();
  h.shell.openNotificationModal('one', false); h.shell.openNotificationModal('two', false);
  h.active[0].suppressPopup = true; h.active[1].suppressPopup = true;
  h.shell.paintScene();
  assert.equal(h.shell.notificationModals.currentModal(), null);
  assert.equal(h.active.length, 2);
});

test('first input after suspension removes expired popup and cannot activate its queued successor', async () => {
  const h = harness();
  h.shell.openNotificationModal('one', false);
  h.shell.openNotificationModal('two', false);
  h.setNow(6000);
  await h.shell.receiveInput({ type: 'click' });
  assert.equal(h.routed(), 0);
  assert.equal(h.shell.stack.layers.length, 2);
  assert.equal(h.shell.stack.layers.at(-1).content.key, 'two');
  assert.equal(h.shell.notificationModals.currentModal().timeout.presentation().startedAt, 6000);
  await h.shell.receiveInput({ type: 'click' });
  assert.equal(h.routed(), 1);
});

test('paint and wake reconcile suspended expiry before stale modal can reappear', () => {
  for (const method of ['paintScene', 'paintSurface', 'wake']) {
    const h = harness();
    h.shell.openNotificationModal('one', false);
    h.setNow(6000);
    h.shell[method]('sidebar');
    assert.equal(h.shell.stack.layers.length, 1, method);
    assert.equal(h.shell.notificationModals.currentModal(), null);
  }
});

test('covered popup stays static, then resumes a fresh retained timeout', () => {
  const h = harness();
  h.shell.openNotificationModal('one', false);
  const popup = h.shell.notificationModals.currentModal();
  h.setNow(4000);
  const overlay = {};
  h.shell.stack.push(overlay);
  h.shell.paintScene();
  assert.equal(popup.modal.hooks.expiration(), null);
  h.setNow(10000);
  h.shell.stack.remove(overlay);
  h.shell.paintScene();
  assert.equal(popup.modal.hooks.expiration().startedAt, 10000);
  h.setNow(15000);
  h.shell.paintScene();
  assert.equal(h.shell.notificationModals.currentModal(), null);
});

test('withdrawn queued notification is skipped after current expiry', () => {
  const h = harness();
  h.shell.openNotificationModal('one', false);
  h.shell.openNotificationModal('two', false);
  h.active.splice(1, 1);
  h.setNow(6000);
  h.shell.paintScene();
  assert.equal(h.shell.notificationModals.currentModal(), null);
  assert.equal(h.shell.stack.layers.length, 1);
});
