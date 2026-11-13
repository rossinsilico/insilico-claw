const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

test('Android icon cache fetches aligned package metadata only on a fresh blocking refresh', () => {
  let iconFetches = 0;
  let inventoryFetches = 0;
  class GrayImage {
    constructor(width, height) { this.width = width; this.height = height; this.pixels = new Uint8Array(width * height); }
    clone() { const copy = new GrayImage(this.width, this.height); copy.pixels.set(this.pixels); return copy; }
  }
  class ArrayList {
    values = [];
    add(value) { this.values.push(value); }
    size() { return this.values.length; }
    get(index) { return this.values[index]; }
  }
  const service = {
    getActiveNotificationIconGrays(size, _max, keys) {
      iconFetches++;
      keys.add('second'); keys.add('first');
      return new Uint8Array(size * size * 2).fill(200);
    },
    getActiveNotificationsJson() {
      inventoryFetches++;
      return JSON.stringify([
        { key: 'first', packageName: 'app.first' },
        { key: 'second', packageName: 'app.second' },
      ]);
    },
    dismissNotification() { return true; },
  };
  const load = loader({
    global: { isAndroid: true },
    com: { faceclaw: { app: { FaceclawMediaNotificationListenerService: service } } },
    java: { util: { ArrayList } },
  }, {
    '../graphics/image': { GrayImage },
    './frame-timings': { logCurrent() {}, spanCurrent: (_name, run) => run() },
    './notification-sources': { rememberNotificationSources() {} },
    './image-files': { PHOTO_TONE: 0, grayImageFromPacket: () => null },
  });
  const icons = load('app/native/notification-icons.ts');

  const initiallyStale = icons.readActiveNotificationIcons(2, true);
  assert.deepEqual([
    initiallyStale.icons.length,
    Array.from(initiallyStale.keys),
    Array.from(initiallyStale.packageNames),
    initiallyStale.stale,
  ], [0, [], [], true]);
  assert.deepEqual([iconFetches, inventoryFetches], [0, 0]);

  const fresh = icons.readActiveNotificationIcons(2, false);
  assert.deepEqual([...fresh.keys], ['second', 'first']);
  assert.deepEqual([...fresh.packageNames], ['app.second', 'app.first']);
  assert.deepEqual([iconFetches, inventoryFetches], [1, 1]);

  assert.deepEqual([...icons.readActiveNotificationIcons(1, false).packageNames], ['app.second']);
  assert.deepEqual([iconFetches, inventoryFetches], [1, 1]);

  icons.dismissNotification('first');
  const stale = icons.readActiveNotificationIcons(2, true);
  assert.deepEqual([...stale.packageNames], ['app.second', 'app.first']);
  assert.equal(stale.stale, true);
  assert.deepEqual([iconFetches, inventoryFetches], [1, 1]);
});
