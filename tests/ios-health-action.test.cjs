const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

function openHealth(ios) {
  let options, pulls = 0;
  const timers = [];
  const { createHealthAppWindow } = loader({
    global: { isIOS: ios },
    setInterval: callback => { timers.push(callback); return timers.length; }, clearInterval() {},
  }, {
    '../../graphics/ui-fonts': {}, '../../graphics/image': {},
    '../../ui/shell/in-process-window': {
      YieldAtRootLayer: class { constructor(layer) { this.layer = layer; } },
      createInProcessWindow: value => { options = value; return { requestRender() {} }; },
    },
    '../../health/health-derive': { dailySummary() {}, dailyHypnogram() {}, rollupSeries() {} },
    '../../health/health-glance': { GLANCE_PAGES: ['overview'], drawGlancePage() {} },
    '../../health/health-store-files': { healthStore: () => ({ samplesInRange: () => [], sleepSessions: () => [] }) },
    '../../health/health-live': { syncLiveRecords() {}, requestFreshPull: () => pulls++ },
    '../../health/health-seed': { isFixtureData: () => false, seedFixturesIfNeeded() {} },
    '../../health/health-types': { DAY_MS: 86400000, SAMPLE_METRICS: [], startOfLocalDay: value => value },
  })('app/apps/health/health-app.ts');
  createHealthAppWindow({ actions: {}, onClosed() {} });
  return { options, timers, pulls: () => pulls };
}

test('opening or refreshing iOS Health never pulls R1 history; only its explicit menu action does', () => {
  const env = openHealth(true);
  assert.equal(env.pulls(), 0);
  env.timers.forEach(tick => tick());
  assert.equal(env.pulls(), 0);
  const sync = env.options.menuItems().find(item => item.label === 'Sync ring now');
  assert.ok(sync);
  let closed = 0;
  sync.onSelect({ stack: { pop: () => closed++ } });
  assert.equal(env.pulls(), 1);
  assert.equal(closed, 1);
});

test('Android Health retains its existing on-open pull', () => {
  assert.equal(openHealth(false).pulls(), 1);
});
