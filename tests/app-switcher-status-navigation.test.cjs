const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

function harness() {
  let includeStatus = false;
  let position = 'bottom';
  let closes = 0;
  const settingListeners = [];
  const statusItems = [{ kind: 'notification', key: 'notice' }];
  class Stack {
    constructor(base) { this.layers = [base]; }
    push(layer) { this.layers.push(layer); }
    popThrough(layer) { this.layers.splice(this.layers.indexOf(layer)); }
    isAtBase() { return this.layers.length === 1; }
    setActions() {}
    paintUndimmed() { return []; }
    paint() { return []; }
  }
  class Chrome {
    statusItems() { return statusItems; }
    statusItemAt() { return statusItems[0]; }
  }
  const fallbackSetting = { get: () => '', set() {} };
  const settings = new Proxy({
    appSwitcherIncludeStatusBarSetting: { get: () => includeStatus },
    wakeToLastAppSetting: { get: () => false },
    onAnySettingChanged: listener => { settingListeners.push(listener); return () => {}; },
    batteryIndicatorSettingsKey: () => '',
  }, { get: (target, property) => property in target ? target[property] : fallbackSetting });
  const load = loader({ global: { isIOS: false }, setTimeout: () => 1, clearTimeout() {} }, {
    '../../graphics/shell-scene': { encodeShellScene: () => new Uint8Array() },
    '../../graphics/image': { GrayImage: class {} }, '../../graphics/plane': { singlePlane: () => [] },
    '../../graphics/ui-fonts': {}, '../../g2/events': {}, '../input-monitor': { acceptInput: () => true },
    '../gestures': { isDirectionalInput: () => false, isWatchInput: () => false },
    '../layers': { LayerStack: Stack, noopLayerActions: {} }, '../menu': { MenuLayer: class {} },
    './voice-input': {}, './keyboard-input': {}, './voice-activity': { voiceActivity: { setActive() {} } },
    './assistant': {}, './assistant-question': {}, '../../assistant/session': {}, '../../assistant/models': {},
    '../../assistant/conversations': {}, '../../assistant/health-destination': {}, '../../native/settings-store': {},
    '../notifications': { SingleNotificationLayer: class { constructor(key) { this.key = key; } } },
    '../dashboard-settings': settings, './ambient-cards': { onAmbientCardsChanged() {} },
    './chrome-layer': {
      ShellChromeLayer: Chrome,
      sameStatusItem: (left, right) => !!left && !!right && left.kind === right.kind && left.key === right.key,
    },
    './modal-layer': { ShellModalLayer: class {} },
    './notification-modal-queue': { NotificationModalQueue: class { currentModal() { return null; } } },
    './notification-popup-timeout': { NotificationPopupTimeout: class {} },
    '../../native/notification-icons': { ALL_NOTIFICATIONS: {}, readActiveNotifications: () => [] },
    './tool-debug-layer': {}, './in-process-window': {}, './brightness-picker-layer': {},
    '../../assistant/tool-registry': { toolRegistry: {} },
    './geometry': {
      switcherPosition: () => position, uiDepth: () => 0,
      screenWidth: () => 640, screenHeight: () => 480,
    },
  });
  const { shell } = load('app/ui/shell/shell.ts');
  shell.configure({ actions: {}, getScreenTimeoutMs: () => null, requestShellRender() {}, onScreenStateChanged() {},
    openNotificationsWindow: () => {
      const window = appWindow('notifications', true);
      const stack = new Stack({});
      shell.registerWindow(window);
      return { window: { window, stack }, opened: true };
    } });
  function appWindow(id, transient = false) {
    return { appId: id, windowId: id, title: id, surfaceId: id, closeable: transient,
      requestRender() {}, setForeground() {}, close: () => { closes++; } };
  }
  return {
    shell,
    addApps: (...ids) => ids.forEach(id => shell.registerWindow(appWindow(id))),
    move: delta => shell.moveSelection(delta),
    touch: () => shell.focusStatusItemAt(10, 10),
    selected: () => shell.foregroundWindow()?.windowId ?? null,
    selectedStatus: () => shell.selectedStatus,
    setIncludeStatus(value) { includeStatus = value; for (const listener of settingListeners) listener(); },
    setIncludeStatusWithoutRefresh: value => { includeStatus = value; },
    setPosition: value => { position = value; },
    closes: () => closes,
  };
}

test('enabled navigation visits a bottom status item after the last app', () => {
  const h = harness();
  h.addApps('one', 'two');
  h.setIncludeStatus(true);
  h.move(1);
  h.move(1);
  assert.equal(h.selectedStatus().item.key, 'notice');
  assert.equal(h.selected(), 'notifications');
});

test('opt-out wraps through apps without entering status items for every app count', () => {
  for (const ids of [[], ['one'], ['one', 'two', 'three']]) {
    const h = harness();
    h.addApps(...ids);
    h.setIncludeStatus(false);
    h.move(-1);
    assert.equal(h.selectedStatus(), null);
    assert.equal(h.selected(), ids.at(-1) ?? null);
    h.move(1);
    assert.equal(h.selected(), ids[0] ?? null);
  }
});

test('non-bottom switchers keep their existing app-only navigation', () => {
  for (const position of ['left', 'right', 'popup']) {
    const h = harness();
    h.addApps('one', 'two');
    h.setPosition(position);
    h.move(1);
    h.move(1);
    assert.equal(h.selected(), 'one');
    assert.equal(h.selectedStatus(), null);
  }
});

test('turning status navigation off immediately exits and closes a transient status-only window', () => {
  const h = harness();
  h.setIncludeStatus(true);
  h.move(1);
  assert.equal(h.selected(), 'notifications');
  assert.equal(h.selectedStatus().transient, true);
  h.setIncludeStatus(false);
  assert.equal(h.selectedStatus(), null);
  assert.equal(h.selected(), null);
  assert.equal(h.closes(), 1);
});

test('render reconciliation also retires stale status selection if a settings refresh was missed', () => {
  const h = harness();
  h.setIncludeStatus(true);
  h.move(1);
  h.setIncludeStatusWithoutRefresh(false);
  h.shell.paintScene();
  assert.equal(h.selectedStatus(), null);
  assert.equal(h.selected(), null);
  assert.equal(h.closes(), 1);
});

test('default-Off mirror touch opens a status item and survives repaint', () => {
  const h = harness();
  assert.equal(h.touch(), true);
  assert.equal(h.selectedStatus().origin, 'touch');
  h.shell.paintScene();
  assert.equal(h.selectedStatus().item.key, 'notice');
  assert.equal(h.selected(), 'notifications');
  assert.equal(h.closes(), 0);
});

test('touching the same scroll-selected item preserves it when Off, then scrolling returns to apps', () => {
  const h = harness();
  h.addApps('one');
  h.setIncludeStatus(true);
  h.move(1);
  assert.equal(h.selectedStatus().origin, 'scroll');
  assert.equal(h.touch(), true);
  assert.equal(h.selectedStatus().origin, 'touch');
  h.setIncludeStatus(false);
  assert.equal(h.selectedStatus().origin, 'touch');
  h.move(1);
  assert.equal(h.selectedStatus(), null);
  assert.equal(h.selected(), 'one');
  assert.equal(h.closes(), 1);
});
