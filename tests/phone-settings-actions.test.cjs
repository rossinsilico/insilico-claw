const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

function harness(options = {}) {
  const calls = [], dialogs = [], records = options.records ?? [];
  const navigations = [];
  let url = 'https://one.example/v1', key = 'key-one', model = '';
  let glassesGeneration = 1;
  const actions = [...(options.actions ?? [])];
  const Dialogs = {
    action: async request => { dialogs.push(request); const next = actions.shift(); return typeof next === 'function' ? next(request) : next ?? 'Cancel'; },
    prompt: async request => { dialogs.push(request); return options.prompt ? options.prompt(request) : { result: false, text: '' }; }, confirm: async () => false,
    alert: async request => { dialogs.push(request); },
  };
  const settings = {
    assistantOpenAiCompatibleUrlSetting: { get: () => url },
    assistantOpenAiCompatibleKeySetting: { get: () => key },
    assistantOpenAiCompatibleModelSetting: { get: () => model, set: value => { model = value; calls.push(['model', value]); } },
  };
  const remoteTokens = {
    list: () => records.map(record => ({ ...record, permissions: [...record.permissions] })),
    permissions: (id, permissions) => calls.push(['permissions', id, permissions]),
    revoke: id => calls.push(['revoke', id]), create() { throw new Error('not used'); },
  };
  const load = loader({}, {
    '@nativescript/core': { Dialogs, Frame: { topmost: () => ({ navigate: entry => navigations.push(entry) }) }, knownFolders: {} },
    '../graphics/installed-fonts': { listInstalledFonts: () => [] },
    '../ui/font-picker': { FONT_SIZE_CHOICES: [] },
    '../graphics/ui-fonts': { fontSelectionLabel: () => '', getUiFontSelection: () => ({}), setUiFontSelection() {}, uiFontSizeAllowed: () => true },
    '../native/notification-sources': {
      readNotificationSources: () => options.sources ?? [],
      setNotificationSourceEnabled: (source, enabled) => calls.push(['notification', source.packageName, enabled]),
    },
    '../native/openai-chat-models': { discoverOpenAiCompatibleModels: options.discover ?? (async () => []) },
    '../native/head-up-settings': {
      headUpAngleValue: () => `${options.angle ?? 30}°`,
      headUpSettingsGeneration: () => glassesGeneration,
      refreshHeadUpAngle: options.refreshAngle ?? (async () => options.angle ?? 30),
      setHeadUpAngle: async (angle, expected) => {
        assert.equal(expected, glassesGeneration);
        calls.push(['head-up-angle', angle]);
      },
    },
    '../native/remote-input': { copyRemoteToken() {}, remoteInterfaces: () => [] },
    '../remote/listeners': { isTunnelInterface: () => false },
    '../remote/protocol': { PERMISSIONS: ['input', 'text', 'assistant'] },
    '../remote/service': { remoteInputStatus: () => '', remoteTokens, remoteInterfaceSelection: () => '', selectRemoteInterface() {} },
    '../ui/dashboard-settings': settings,
  });
  return { ...load('app/phone-ui/phone-settings-actions.ios.ts'), calls, dialogs, navigations,
    setEndpoint(nextUrl, nextKey = key) { url = nextUrl; key = nextKey; }, model: () => model,
    replaceGlasses() { glassesGeneration++; } };
}

const noActions = { openDevices: async () => {}, openAdvanced() {} };

test('head-up angle starts with device readback and saves valid whole-degree boundaries', async () => {
  for (const angle of [0, 60]) {
    const h = harness({ angle: 25, prompt: async request => {
      assert.equal(request.defaultText, '25'); return { result: true, text: String(angle) };
    } });
    assert.equal(await h.runPhoneSettingsAction({ label: 'Angle', phone: { kind: 'head-up-angle' } }, noActions), true);
    assert.deepEqual(h.calls, [['head-up-angle', angle]]);
  }
});

test('head-up angle never writes a cancelled, invalid or expired phone choice', async () => {
  for (const text of ['', '-1', '61', '1.5', 'NaN']) {
    const h = harness({ prompt: async () => ({ result: true, text }) });
    assert.equal(await h.runPhoneSettingsAction({ label: 'Angle', phone: { kind: 'head-up-angle' } }, noActions), false);
    assert.deepEqual(h.calls, []);
  }
  for (const close of ['connection', 'surface']) {
    let h;
    h = harness({ prompt: async () => {
      if (close === 'connection') h.replaceGlasses(); else h.cancelPhoneSettingsActions();
      return { result: true, text: '40' };
    } });
    assert.equal(await h.runPhoneSettingsAction({ label: 'Angle', phone: { kind: 'head-up-angle' } }, noActions), false);
    assert.deepEqual(h.calls, []);
  }
});

test('remote token choices retain unique backing identities despite duplicate or reserved names', async () => {
  const records = [
    { id: 'token-one', name: 'Create input token', permissions: ['input'] },
    { id: 'token-two', name: 'Create input token', permissions: ['input'] },
  ];
  const h = harness({ records, actions: [
    request => {
      assert.equal(new Set(request.actions).size, request.actions.length);
      return request.actions.find(label => label.includes('token-two'));
    },
    request => request.actions.find(label => label.includes('Text to foreground')),
  ] });
  assert.equal(await h.runPhoneSettingsAction({ label: 'Input tokens', phone: { kind: 'remote-input' } }, noActions), true);
  assert.equal(JSON.stringify(h.calls[0]), JSON.stringify(['permissions', 'token-two', ['input', 'text']]));
});

test('notification filter opens a page without mutating a source', async () => {
  const h = harness({ sources: [{ packageName: 'com.mail', appName: 'Mail', showOnGlasses: true, showStatusIcon: true }] });
  assert.equal(h.phoneSettingsValue({ label: 'Notification filter', phone: { kind: 'notification-filter' } }), '1 app');
  assert.equal(await h.runPhoneSettingsAction({ label: 'Notification filter', phone: { kind: 'notification-filter' } }, noActions), false);
  assert.equal(JSON.stringify(h.navigations), JSON.stringify([{ moduleName: 'phone-ui/notification-settings-page' }]));
  assert.deepEqual(h.calls, []);
});

test('model discovery rejects results and choices after the endpoint changes or a newer discovery starts', async () => {
  let resolveFirst;
  const first = new Promise(resolve => { resolveFirst = resolve; });
  let request = 0;
  const h = harness({ discover: async () => ++request === 1 ? first : [{ id: 'new', name: 'New', supportsTools: true, offline: false, deprecated: false, beta: false }],
    actions: [request => request.actions.find(label => label.includes('New'))] });
  const stale = h.runPhoneSettingsAction({ label: 'Discover models', phone: { kind: 'model-discovery' } }, noActions);
  h.setEndpoint('https://two.example/v1', 'key-two');
  const current = h.runPhoneSettingsAction({ label: 'Discover models', phone: { kind: 'model-discovery' } }, noActions);
  resolveFirst([{ id: 'old', name: 'Old', supportsTools: true, offline: false, deprecated: false, beta: false }]);
  assert.equal(await stale, false);
  assert.equal(await current, true);
  assert.equal(h.model(), 'new');
  assert.deepEqual(h.calls, [['model', 'new']]);
  assert.equal(h.dialogs.filter(dialog => dialog.title === 'Discover models').length, 1);
});

test('model discovery rechecks its endpoint after the user chooses a fetched model', async () => {
  let h;
  h = harness({ discover: async () => [{ id: 'old', name: 'Old', supportsTools: true, offline: false, deprecated: false, beta: false }],
    actions: [request => { h.setEndpoint('https://changed.example/v1'); return request.actions.find(label => label.startsWith('Old')); }] });
  assert.equal(await h.runPhoneSettingsAction({ label: 'Discover models', phone: { kind: 'model-discovery' } }, noActions), false);
  assert.equal(h.model(), '');
});

test('closing the phone settings surface invalidates pending model discovery', async () => {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const h = harness({ discover: async () => pending, actions: [request => request.actions[0]] });
  const discovery = h.runPhoneSettingsAction({ label: 'Discover models', phone: { kind: 'model-discovery' } }, noActions);
  h.cancelPhoneSettingsActions();
  resolve([{ id: 'late', name: 'Late', supportsTools: true, offline: false, deprecated: false, beta: false }]);
  assert.equal(await discovery, false);
  assert.equal(h.dialogs.length, 0);
  assert.equal(h.model(), '');
});

test('model discovery exposes capability annotations, offline toggle, and forced refresh', async () => {
  const requests = [];
  const models = [
    { id: 'online', name: 'Online', supportsTools: true, offline: false, deprecated: false, beta: true },
    { id: 'offline', name: 'Offline', supportsTools: false, offline: true, deprecated: true, beta: false },
  ];
  const h = harness({ discover: async options => { requests.push(options); return models; }, actions: [
    request => { assert.ok(request.actions.includes('Show offline (1)')); return 'Show offline (1)'; },
    request => {
      assert.ok(request.actions.some(label => /Offline.*no tools.*offline.*deprecated/.test(label)));
      return 'Refresh models';
    },
    request => request.actions.find(label => label.startsWith('Online')),
  ] });
  assert.equal(await h.runPhoneSettingsAction({ label: 'Discover models', phone: { kind: 'model-discovery' } }, noActions), true);
  assert.equal(h.model(), 'online');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].forceRefresh, undefined);
  assert.equal(requests[1].forceRefresh, true);
});
