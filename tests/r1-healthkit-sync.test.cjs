const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

function environment() {
  const files = new Map(), writes = [], settings = new Map();
  const now = Date.now(), at = now - 60_000;
  const sample = { metric: 'heartRate', startMs: at, spanMs: 0, min: 72, max: 72, avg: 72, total: 72,
    provenance: { kind: 'r1-live', ringId: 'AA:BB:CC:DD:EE:FF', dateSource: 'ring-latest', receivedAtMs: now - 1000, exportRevision: 1 } };
  const state = { writes, files, settings, samples: [sample], ingests: 0, ended: [],
    ingestError: null, writeError: null, receiptError: null, beforeWrite: null, expires: null };
  function load() {
    const native = {
      File: { exists: name => files.has(name), fromPath: name => ({
        readTextSync: () => files.get(name),
        writeTextSync: (text, onError) => {
          if (state.receiptError) return onError(state.receiptError);
          files.set(name, text);
        },
      }) },
    };
    const dependencies = {
      '@nativescript/core': native,
      '../native/settings-store': {
        getBooleanSetting: (key, fallback) => settings.get(key) ?? fallback,
        setBooleanSetting: (key, value) => settings.set(key, value),
      },
      '../native/apple-health': {
        isAppleHealthAvailable: () => true,
        writeR1HealthSamples: async records => {
          writes.push(JSON.parse(JSON.stringify(records)));
          if (state.beforeWrite) await state.beforeWrite(records);
          if (state.writeError) throw state.writeError;
          return { submittedCount: records.length };
        },
      },
      './health-store-files': { healthFolder: () => ({ path: '/health' }),
        checkedFileOperation: operation => { let error; operation(e => { error = e; }); if (error) throw error; },
        healthStore: () => ({ readingsInRange: () => state.samples, samplesInRange: () => [], sleepSessions: () => [] }) },
      './health-live': { syncLiveRecords: () => { state.ingests++; if (state.ingestError) throw state.ingestError; } },
      './health-seed': { hasLiveData: () => true, isFixtureData: () => false },
    };
    return loader({ Date, console: { warn() {} },
      UIApplication: { sharedApplication: {
        beginBackgroundTaskWithNameExpirationHandler: (_name, expire) => { state.expires = expire; return 1; },
        endBackgroundTask: id => state.ended.push(id),
      } }, UIBackgroundTaskInvalid: -1,
    }, dependencies)('app/health/healthkit-sync.ios.ts');
  }
  state.load = load;
  state.api = state.load();
  state.enable = () => state.api.setAutomaticR1HealthSyncEnabled(true);
  return state;
}

test('ring transfer ingestion is durable even when automatic Apple Health export is off', async () => {
  const env = environment();
  await env.api.syncAutomaticR1Health();
  assert.equal(env.ingests, 1);
  assert.equal(env.writes.length, 0);
  assert.deepEqual(env.ended, [1]);
});

test('drain completion distinguishes skipped export from all eligible receipts being durable',async()=>{
  const env=environment();
  assert.equal(await env.api.syncAutomaticR1Health(),false);
  env.enable();assert.equal(await env.api.syncAutomaticR1Health(),true);
  env.api.setAutomaticR1HealthSyncEnabled(false);
  assert.equal(await env.api.syncAutomaticR1Health(),false);
});

test('automatic export saves only new revisions and restores receipts after restart', async () => {
  const env = environment(); env.enable();
  await env.api.syncAutomaticR1Health();
  await env.api.syncAutomaticR1Health();
  assert.equal(env.writes.length, 1);
  env.api = env.load();
  await env.api.syncAutomaticR1Health();
  assert.equal(env.writes.length, 1);
  env.samples[0].provenance.exportRevision = 2;
  await env.api.syncAutomaticR1Health();
  assert.equal(env.writes.length, 2);
  assert.equal(env.writes[1][0].syncVersion, 2);
});

test('store failures prevent export and a later trigger retries without losing records', async () => {
  const env = environment(); env.enable(); env.ingestError = new Error('disk full');
  await assert.rejects(env.api.syncAutomaticR1Health(), /disk full/);
  assert.equal(env.writes.length, 0);
  env.ingestError = null;
  await env.api.syncAutomaticR1Health();
  assert.equal(env.writes.length, 1);
});

test('failed HealthKit saves and failed receipt writes remain safe to retry', async () => {
  const env = environment(); env.enable(); env.writeError = new Error('HealthKit unavailable');
  await assert.rejects(env.api.syncAutomaticR1Health(), /unavailable/);
  env.writeError = null; env.receiptError = new Error('receipt disk full');
  await assert.rejects(env.api.syncAutomaticR1Health(), /receipt disk full/);
  env.receiptError = null;
  await env.api.syncAutomaticR1Health();
  assert.equal(env.writes.length, 3);
  assert.equal(env.writes[0][0].syncIdentifier, env.writes[2][0].syncIdentifier);
  assert.equal(env.writes[0][0].syncVersion, env.writes[2][0].syncVersion);
});

test('concurrent triggers coalesce and expiration stops later batches', async () => {
  const env = environment(); env.enable();
  env.samples = Array.from({ length: 1001 }, (_, i) => ({ ...env.samples[0], startMs: env.samples[0].startMs - i,
    provenance: { ...env.samples[0].provenance } }));
  let release;
  env.beforeWrite = () => new Promise(resolve => { release = resolve; });
  const first = env.api.syncAutomaticR1Health();
  const second = env.api.syncAutomaticR1Health();
  assert.equal(env.writes.length, 1);
  assert.equal(env.writes[0].length, 1000);
  env.expires(); release();
  assert.deepEqual(await Promise.all([first, second]),[false,false]);
  assert.equal(env.writes.length, 1);
  assert.deepEqual(env.ended, [1]);
  env.beforeWrite = null;
  await env.api.syncAutomaticR1Health();
  assert.equal(env.writes[1].length, 1);
});

test('turning automatic sync off stops further batches without discarding local records', async () => {
  const env = environment(); env.enable();
  env.samples = Array.from({ length: 1001 }, (_, i) => ({ ...env.samples[0], startMs: env.samples[0].startMs - i }));
  env.beforeWrite = () => env.api.setAutomaticR1HealthSyncEnabled(false);
  await env.api.syncAutomaticR1Health();
  assert.equal(env.writes.length, 1);
  assert.equal(env.samples.length, 1001);
});

test('a denied metric does not block permitted metrics and becomes eligible after access is granted', async () => {
  const env = environment(); env.enable();
  env.samples.unshift({ ...env.samples[0], metric: 'spo2', min: 98, max: 98, avg: 98, total: 98 });
  env.beforeWrite = records => { if (records.some(record => record.type === 'oxygenSaturation')) throw new Error('oxygen write not authorized'); };
  await assert.rejects(env.api.syncAutomaticR1Health(), /not authorized/);
  assert.equal(env.writes.length, 2);
  assert.deepEqual(env.writes[1].map(record => record.type), ['heartRate']);
  env.beforeWrite = null;
  await env.api.syncAutomaticR1Health();
  assert.equal(env.writes.length, 3);
  assert.deepEqual(env.writes[2].map(record => record.type), ['oxygenSaturation']);
  await env.api.syncAutomaticR1Health();
  assert.equal(env.writes.length, 3);
});
