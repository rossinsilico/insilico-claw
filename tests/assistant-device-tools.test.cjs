const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { loader } = require('./helpers/load-typescript.cjs');

function tools({ location, locationError, isIOS = true, relayReady = true, notifications = [],
  readNotifications = max => notifications.slice(0, max), dismiss = () => false } = {}) {
  const registered = new Map();
  const load = loader({ global: { isIOS } }, {
    '../native/calendar': {},
    '../native/calendar-permissions': { hasCalendarPermission: () => false },
    '../native/location': { getCurrentLocation: async () => {
      if (locationError) throw new Error(locationError);
      return location;
    } },
    '../native/media-controller': { mediaControllerBridge: { start: async () => {}, refresh: async () => {}, snapshot: () => ({}) } },
    '../native/spotify': { spotifyService: () => null },
    '../native/notification-icons': {
      ALL_NOTIFICATIONS: 0x7fffffff,
      isNotificationRelayReady: () => relayReady,
      notificationRelayMessage: () => 'Connect the iPhone notification relay.',
      readActiveNotifications: readNotifications,
      dismissNotification: dismiss,
    },
    '../ui/shell/shell': { shell: {} },
    './tool-registry': {},
    './health-tools': { registerHealthTools() {} },
  });
  load('app/assistant/system-tools.ts').registerSystemTools({
    registerSystemTool: (spec, handler) => registered.set(spec.name, { spec, handler }),
  });
  return registered;
}

test('location.current returns a real phone fix with source metadata and meaningful native errors', async () => {
  const fix = { latitude: 40.7, longitude: -74, accuracyMeters: 12, timestampMs: 1770000000000 };
  const success = await tools({ location: fix }).get('location.current').handler({});
  assert.equal(success.ok, true);
  assert.deepEqual(JSON.parse(success.content), { ...fix, source: 'phone-gps' });

  const denied = await tools({ locationError: 'Location permission denied' }).get('location.current').handler({});
  assert.equal(denied.ok, false);
  assert.match(denied.error, /phone location.*Location permission denied/i);
});

test('iOS notification tools advertise relay state and only hide Faceclaw local records', async () => {
  let hidden = '';
  const notification = { key: 'ancs:1:2', appName: 'Messages', title: 'New message', text: 'Hello' };
  const ready = tools({ notifications: [notification], dismiss: key => { hidden = key; return true; } });
  assert.match(ready.get('notifications.dismiss').spec.description, /does not dismiss.*iPhone Notification Center/i);
  const listed = await ready.get('notifications.list').handler({ max: 5 });
  assert.match(listed.content, /New message/);
  const dismissed = await ready.get('notifications.dismiss').handler({ key: notification.key });
  assert.equal(hidden, notification.key);
  assert.equal(dismissed.content, 'Hidden from Faceclaw on the glasses.');

  const unavailable = tools({ relayReady: false });
  const result = await unavailable.get('notifications.list').handler({});
  assert.equal(result.ok, false);
  assert.equal(result.error, 'Connect the iPhone notification relay.');
});

test('one registered notification dismiss invocation hides all 25 explicitly listed keys', async () => {
  const keys = Array.from({ length: 25 }, (_, i) => `ancs:synthetic:${i}`);
  const remaining = new Set([...keys, 'ancs:unrequested']);
  const registered = tools({ dismiss: key => remaining.delete(key), readNotifications: () => [...remaining] });
  const result = await registered.get('notifications.dismiss').handler({ keys });
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(result.content), {
    action: 'hidden_from_faceclaw', requested: 25, completed: 25, notFound: [], remaining: 1,
  });
  assert.deepEqual([...remaining], ['ancs:unrequested']);
});

test('notification batch validates every key before making any local change', async () => {
  for (const args of [
    {}, { key: '' }, { key: ' ' }, { keys: [] }, { keys: 'a' }, { keys: ['a', ''] }, { keys: ['a', ' '] },
    { keys: ['a', 42] }, { keys: ['a', null] }, { keys: ['a', 'a'] },
    { keys: ['a', ' a '] }, { key: 'a', keys: ['b'] }, { key: 42 },
    { keys: Array.from({ length: 129 }, (_, i) => String(i)) }, { keys: ['a'], all: true },
  ]) {
    const remaining = new Set(['a', 'b']);
    const result = await tools({ dismiss: key => remaining.delete(key) }).get('notifications.dismiss').handler(args);
    assert.equal(result.ok, false, JSON.stringify(args));
    assert.deepEqual([...remaining], ['a', 'b']);
  }
});

test('notification batch reports missing keys without retrying or expanding its targets', async () => {
  const remaining = new Set(['a', 'c', 'unrequested']);
  const result = await tools({ dismiss: key => remaining.delete(key), readNotifications: () => [...remaining] }).get('notifications.dismiss').handler({ keys: ['a', 'missing', 'c'] });
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(result.content), {
    action: 'hidden_from_faceclaw', requested: 3, completed: 2, notFound: ['missing'], remaining: 1,
  });
  assert.deepEqual([...remaining], ['unrequested']);
});

test('notification batch preserves the relay gate at the full iOS cache limit', async () => {
  const keys = Array.from({ length: 128 }, (_, i) => `synthetic:${i}`);
  const remaining = new Set(keys);
  const denied = await tools({ relayReady: false, dismiss: key => remaining.delete(key) }).get('notifications.dismiss').handler({ keys });
  assert.equal(denied.ok, false);
  assert.equal(remaining.size, 128);
  const accepted = await tools({ dismiss: key => remaining.delete(key) }).get('notifications.dismiss').handler({ keys });
  assert.equal(accepted.ok, true);
  assert.equal(JSON.parse(accepted.content).completed, 128);
  assert.equal(remaining.size, 0);
});

test('notification arguments survive the native Codex schema boundary before local dispatch', {
  skip: !process.env.OPENCLAW_PLUGIN_SDK_ROOT && 'Set OPENCLAW_PLUGIN_SDK_ROOT to the installed dist/plugin-sdk directory',
}, async () => {
  const sdk = name => import(pathToFileURL(path.join(process.env.OPENCLAW_PLUGIN_SDK_ROOT, `${name}.js`)).href);
  const { normalizeOpenAIStrictCompatSchema } = await sdk('provider-tools');
  const { projectRuntimeToolInputSchema } = await sdk('agent-harness-runtime');
  const { validateJsonSchemaValue } = await sdk('json-schema-runtime');
  for (const args of [{ key: 'synthetic:single' }, { keys: Array.from({ length: 50 }, (_, i) => `synthetic:${i}`) },
    { keys: Array.from({ length: 128 }, (_, i) => `synthetic:${i}`) }]) {
    const requested = args.keys ?? [args.key];
    const remaining = new Set([...requested, 'unrequested']);
    const { spec, handler } = tools({ dismiss: key => remaining.delete(key) }).get('notifications.dismiss');
    const projected = projectRuntimeToolInputSchema(normalizeOpenAIStrictCompatSchema(spec.inputSchema), 'notifications_dismiss.inputSchema');
    assert.deepEqual(projected.violations, []);
    const validation = validateJsonSchemaValue({ schema: projected.schema, value: JSON.parse(JSON.stringify(args)) });
    assert.equal(validation.ok, true, JSON.stringify(validation.errors));
    const result = await handler(args);
    assert.equal(result.ok, true);
    assert.deepEqual([...remaining], ['unrequested']);
  }
  for (const args of [{}, { key: 'a', keys: ['b'] }, { keys: [] }, { keys: ['a'], all: true }]) {
    const remaining = new Set(['a', 'b']);
    const { spec, handler } = tools({ dismiss: key => remaining.delete(key) }).get('notifications.dismiss');
    const projected = projectRuntimeToolInputSchema(normalizeOpenAIStrictCompatSchema(spec.inputSchema), 'notifications_dismiss.inputSchema');
    const validation = validateJsonSchemaValue({ schema: projected.schema, value: args });
    if (validation.ok) assert.equal((await handler(args)).ok, false);
    assert.deepEqual([...remaining], ['a', 'b']);
  }
});

test('one explicit iOS batch hides the full ANCS cache without sending phone actions', async t => {
  const { AncsClient } = loader({ setTimeout, clearTimeout })('app/g2/ancs-client.ts');
  const le = n => [n & 255, n >>> 8 & 255, n >>> 16 & 255, n >>> 24];
  const attr = (id, text) => { const bytes = [...Buffer.from(text)]; return [id, bytes.length, 0, ...bytes]; };
  for (const count of [60, 128]) {
    let sequence = 0, writes = 0;
    const client = new AncsClient(async () => { writes++; }, () => {});
    t.after(() => client.stop());
    const feed = (kind, bytes) => {
      const seq = sequence++;
      client.receive(Uint8Array.from([65, 78, 1, kind, ...le(123), seq & 255, seq >> 8, 3, ...bytes]));
    };
    client.start(123); feed(0, [0]); feed(0, [1]);
    for (let uid = 1; uid <= count; uid++) {
      feed(1, [0, 4, 1, 1, ...le(uid)]); feed(3, []);
      feed(2, [0, ...le(uid), ...attr(0, 'com.synthetic.app'), ...attr(1, 'Synthetic'), ...attr(3, 'Fixture')]);
      feed(3, []);
      feed(2, [0, ...le(uid), ...attr(2, ''), ...attr(4, ''), ...attr(5, ''), ...attr(6, ''), ...attr(7, '')]);
      feed(3, []);
    }
    const registered = tools({ readNotifications: max => client.read(max), dismiss: key => client.dismiss(key) });
    const partial = await registered.get('notifications.list').handler({ max: 50 });
    assert.deepEqual(JSON.parse(partial.content.split('\n')[0]), { listed: 50, total: count, hasMore: true });
    const listed = await registered.get('notifications.list').handler({ max: 128 });
    assert.deepEqual(JSON.parse(listed.content.split('\n')[0]), { listed: count, total: count, hasMore: false });
    const keys = [...listed.content.matchAll(/\(key: ([^)]+)\)/g)].map(match => match[1]);
    const writesBeforeHide = writes;
    const result = await registered.get('notifications.dismiss').handler({ keys });
    assert.deepEqual(JSON.parse(result.content), {
      action: 'hidden_from_faceclaw', requested: count, completed: count, notFound: [], remaining: 0,
    });
    assert.equal(client.read(50).length, 0, 'The picker reads this same live cache');
    assert.equal(writes, writesBeforeHide, 'Local hide must not send any ANCS action');
    const empty = await registered.get('notifications.list').handler({ max: 128 });
    assert.deepEqual(JSON.parse(empty.content.split('\n')[0]), { listed: 0, total: 0, hasMore: false });
  }
});

test('Android retains default ten, maximum fifty, and single-key dismissal', async () => {
  const remaining = new Set(Array.from({ length: 60 }, (_, i) => `synthetic:${i}`));
  const registered = tools({ isIOS: false, relayReady: false, dismiss: key => remaining.delete(key),
    readNotifications: max => [...remaining].slice(0, max).map(key => ({ key, appName: 'Synthetic' })) });
  const list = registered.get('notifications.list').handler;
  assert.deepEqual(JSON.parse((await list({})).content.split('\n')[0]), { listed: 10, total: 60, hasMore: true });
  assert.deepEqual(JSON.parse((await list({ max: 128 })).content.split('\n')[0]), { listed: 50, total: 60, hasMore: true });
  const dismiss = registered.get('notifications.dismiss').handler;
  assert.equal((await dismiss({ keys: [...remaining].slice(0, 51) })).ok, false);
  assert.equal(remaining.size, 60);
  assert.equal((await dismiss({ key: 'synthetic:0' })).content, 'Dismissed.');
  const result = await dismiss({ keys: [...remaining].slice(0, 50) });
  assert.deepEqual(JSON.parse(result.content), { action: 'dismissed', requested: 50, completed: 50, notFound: [], remaining: 9 });
  assert.equal(remaining.size, 9);
});
