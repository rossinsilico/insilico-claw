const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

// Run the actual live ingest, seed and file-backend modules with NativeScript
// files and the Java communicator replaced at their platform boundaries.
function liveEnvironment({ ringProtocol, ios = false } = {}) {
  const files = new Map();
  const ringIdentity = { selected: "AA:BB:CC:DD:EE:FF", captured: "AA:BB:CC:DD:EE:FF" };
  const cache = new Map();
  const faults = { append: null, remove: null, write: null };
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = today.getTime();
  let consumed = false;
  const record = {
    cmdHi: 1,
    anchorUnixSeconds: (start + today.getTimezoneOffset() * 60000) / 1000,
    receivedAtMs: start + 3600000,
    groups: [{ hourIndex: 0, min: 40, max: 50, avg: 45 }],
  };
  const records = [record];
  const communicator = {
    takeRingHealthBatch: () => ios ? { watermark: 1, ringId: ringIdentity.captured, records: consumed ? [] : records } : ({
      getWatermark: () => 1,
      getRecords: () => ({ size: () => consumed ? 0 : records.length, get: (index) => records[index] }),
    }),
    clearRingHealthRecordsBelow: () => { consumed = true; return 1; },
  };
  const native = {
    ApplicationSettings: {
      getString: (key, fallback) => key === "deviceAddress.ring" ? ringIdentity.selected : fallback,
    },
    File: {
      exists: (name) => files.has(name),
      fromPath: (name) => ({
        readTextSync: () => files.get(name),
        appendTextSync: (text, onError) => {
          if (faults.append) return onError(faults.append);
          files.set(name, (files.get(name) ?? "") + text);
        },
        writeTextSync: (text, onError) => {
          if (faults.write) return onError(faults.write);
          files.set(name, text);
        },
        removeSync: (onError) => {
          if (faults.remove) return onError(faults.remove);
          files.delete(name);
        },
      }),
    },
    knownFolders: { ios: { library: () => ({ getFolder: name => ({
      path: `/Library/${name}`,
      getEntitiesSync: () => [...files.keys()].map((name) => ({ path: name, name: path.basename(name) })),
    }) }) }, documents: () => ({ getFolder: () => ({
      path: "/health",
      getEntitiesSync: () => [...files.keys()].map((name) => ({ path: name, name: path.basename(name) })),
    }) }) },
  };
  function load(filename) {
    if (!filename.endsWith(".ts")) filename += ".ts";
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} };
    cache.set(filename, module);
    const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    vm.runInNewContext(code, {
      module, exports: module.exports, Date,
      require: (name) => name === "@nativescript/core" ? native
        : name.endsWith("faceclaw-communicator.ios") ? { FaceclawCommunicatorBridge: {
          getActive: () => communicator,
          decodeRingHealthJournal: (text, after) => ringProtocol?.decodeFrameJournal(text, after) ?? [],
        } } : load(path.resolve(path.dirname(filename), name)),
      console: { log() {}, warn() {} },
      com: ios ? undefined : { faceclaw: { app: { FaceclawBleCommunicator: { getActive: () => communicator }, RingProtocol: ringProtocol } } },
      global: { isIOS: ios },
    }, { filename });
    return module.exports;
  }
  return {
    files, faults, start, record, records, ringIdentity, consumed: () => consumed,
    redeliver: () => { consumed = false; },
    load: (name) => load(path.join(__dirname, "../app/health", name)),
  };
}

test("iOS uses its active native bridge and preserves ring-reported UTC anchors", () => {
  const env = liveEnvironment({ ios: true });
  env.record.anchorUnixSeconds = env.start / 1000;
  const result = env.load("health-live").syncLiveRecords();
  assert.equal(result.samplesWritten, 1);
  assert.equal(env.consumed(), true);
  const samples = env.load("health-store-files").healthStore().samplesInRange(env.start, env.start + 3600000);
  assert.equal(samples.length, 1);
  assert.equal(samples[0].startMs, env.start);
  assert.equal(samples[0].avg, 45);
  assert.deepEqual(JSON.parse(JSON.stringify(samples[0].provenance)), {
    kind: "r1-live", ringId: "AA:BB:CC:DD:EE:FF", receivedAtMs: env.start + 3600000,
    dateSource: "ring-anchor", exportRevision: 1,
  });
  assert.ok([...env.files.keys()].every(name => name.startsWith('/Library/Application Support/health/')));
});

test("iOS store failure retains the native batch for a retry", () => {
  const env = liveEnvironment({ ios: true });
  env.record.anchorUnixSeconds = env.start / 1000;
  env.faults.append = new Error("disk full");
  assert.throws(() => env.load("health-live").syncLiveRecords(), /disk full/);
  assert.equal(env.consumed(), false);
  env.faults.append = null;
  assert.equal(env.load("health-live").syncLiveRecords().samplesWritten, 1);
  assert.equal(env.consumed(), true);
});

test('iOS pending batches retain their captured ring identity after selected device changes', () => {
  const env = liveEnvironment({ ios: true });
  env.record.anchorUnixSeconds = env.start / 1000;
  env.ringIdentity.selected = '11:22:33:44:55:66';
  env.load('health-live').syncLiveRecords();
  const sample = env.load('health-store-files').healthStore().samplesInRange(env.start, env.start + 3600000)[0];
  assert.equal(sample.provenance.ringId, 'AA:BB:CC:DD:EE:FF');
});

test('iOS restart replay recovers captured identity without borrowing the selected ring', () => {
  let recovered;
  const env = liveEnvironment({ ios: true, ringProtocol: { decodeFrameJournal: () => [recovered] } });
  recovered = { ...env.record, tagRaw: (env.start + 60_000) / 1000, current: 72,
    ringId: 'AA:BB:CC:DD:EE:FF' };
  env.records.length = 0;
  env.ringIdentity.selected = '11:22:33:44:55:66';
  env.files.set('/Library/Application Support/health/ring-frames.jsonl', '{}');
  env.load('health-live').syncLiveRecords();
  const point = env.load('health-store-files').healthStore().readingsInRange(env.start, env.start + 3600000)[0];
  assert.equal(point.provenance.ringId, 'AA:BB:CC:DD:EE:FF');
});

test("iOS preserves a valid ring-latest point even when the historical page anchor is unknown", () => {
  const env = liveEnvironment({ ios: true });
  const at = env.start + 30 * 60_000;
  env.record.anchorUnixSeconds = -1;
  env.record.tagRaw = at / 1000;
  env.record.current = 72;

  const result = env.load("health-live").syncLiveRecords();
  assert.equal(result.samplesWritten, 1);
  const store = env.load("health-store-files").healthStore();
  assert.equal(store.samplesInRange(env.start, env.start + 3600000).length, 0);
  const reading = store.readingsInRange(env.start, env.start + 3600000)[0];
  assert.equal(reading.startMs, at);
  assert.equal(reading.avg, 72);
  assert.deepEqual(JSON.parse(JSON.stringify(reading.provenance)), {
    kind: "r1-live", ringId: "AA:BB:CC:DD:EE:FF", receivedAtMs: env.start + 3600000,
    dateSource: "ring-latest", exportRevision: 1,
  });
});

test("iOS preserves native latest heart rate oxygen and filtered RMSSD statistics", () => {
  const env = liveEnvironment({ ios: true });
  const at = env.start + 30 * 60_000;
  Object.assign(env.record, { anchorUnixSeconds: -1, tagRaw: at / 1000, current: 72 });
  env.records.push({ ...env.record, cmdHi: 2, current: 98 });
  env.records.push({ ...env.record, cmdHi: 4, current: 47 });

  assert.equal(env.load("health-live").syncLiveRecords().samplesWritten, 3);
  const readings = env.load("health-store-files").healthStore()
    .readingsInRange(env.start, env.start + 3600000);
  assert.deepEqual(Array.from(readings, ({ metric, avg }) => [metric, avg]), [
    ["heartRate", 72], ["spo2", 98], ["hrv", 47],
  ]);
});

test("repeated latest points across pages dedupe and conflicting values do not overwrite", () => {
  const env = liveEnvironment({ ios: true });
  const at = env.start + 30 * 60_000;
  Object.assign(env.record, { anchorUnixSeconds: -1, tagRaw: at / 1000, current: 72 });
  env.records.push({ ...env.record, anchorUnixSeconds: env.start / 1000, current: 72 });
  env.records.push({ ...env.record, anchorUnixSeconds: env.start / 1000, current: 73 });

  const result = env.load("health-live").syncLiveRecords();
  assert.equal(result.samplesWritten, 2, "one point plus one anchored aggregate");
  const store = env.load("health-store-files").healthStore();
  assert.equal(store.readingsInRange(env.start, env.start + 3600000).length, 1);
  assert.equal(store.readingsInRange(env.start, env.start + 3600000)[0].avg, 72);
  const shard = [...env.files.entries()].find(([name]) => name.includes("samples-"))[1];
  assert.equal(shard.split("\n").filter(Boolean).length, 2, "repeat latest point grew storage");
});

test("iOS rejects missing epoch future and invalid latest readings", () => {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const cases = [
    { cmdHi: 1, tagRaw: undefined, current: 72 },
    { cmdHi: 1, tagRaw: 0, current: 72 },
    { cmdHi: 1, tagRaw: (Date.UTC(1999, 0, 1) / 1000), current: 72 },
    { cmdHi: 1, tagRaw: nowSeconds + 60, current: 72 },
    { cmdHi: 1, tagRaw: nowSeconds, current: 19 },
    { cmdHi: 1, tagRaw: nowSeconds, current: 301 },
    { cmdHi: 2, tagRaw: nowSeconds, current: 0 },
    { cmdHi: 2, tagRaw: nowSeconds, current: 101 },
    { cmdHi: 4, tagRaw: nowSeconds, current: 0 },
    { cmdHi: 4, tagRaw: nowSeconds, current: 65536 },
  ];
  for (const fields of cases) {
    const env = liveEnvironment({ ios: true });
    env.record.anchorUnixSeconds = -1;
    env.record.receivedAtMs = Date.now();
    Object.assign(env.record, fields);
    env.load("health-live").syncLiveRecords();
    assert.equal(env.load("health-store-files").healthStore()
      .readingsInRange(0, Date.now() + 1000).length, 0, JSON.stringify(fields));
  }
});

test("journal replay never attributes its latest field to the currently paired ring", () => {
  const at = Date.UTC(2026, 10, 11, 12);
  const env = liveEnvironment({ ios: true, ringProtocol: {
    decodeFrameJournal: () => [{
      ...env.record, anchorUnixSeconds: -1, tagRaw: at / 1000, current: 72, receivedAtMs: at + 1000,
    }],
  } });
  env.record.cmdHi = 99;
  env.files.set('/Library/Application Support/health/ring-frames.jsonl', 'durable page');
  env.load("health-live").syncLiveRecords();
  assert.equal(env.load("health-store-files").healthStore().readingsInRange(at, at + 1).length, 0);
});

test("a failed latest-point append retains the native batch for retry", () => {
  const env = liveEnvironment({ ios: true });
  const at = env.start + 30 * 60_000;
  Object.assign(env.record, { anchorUnixSeconds: -1, tagRaw: at / 1000, current: 72 });
  env.faults.append = new Error("disk full");
  assert.throws(() => env.load("health-live").syncLiveRecords(), /disk full/);
  assert.equal(env.consumed(), false);
  env.faults.append = null;
  assert.equal(env.load("health-live").syncLiveRecords().samplesWritten, 1);
  assert.equal(env.consumed(), true);
});

test("iOS does not turn unverified activity or sleep fields into dated health samples", () => {
  for (const cmdHi of [5, 6]) {
    const env = liveEnvironment({ ios: true });
    env.record.cmdHi = cmdHi;
    const result = env.load("health-live").syncLiveRecords();
    assert.equal(result.samplesWritten, 0);
    assert.equal(result.sleepWritten, 0);
    assert.equal(env.load("health-seed").hasLiveData(), false);
  }
});

test("iOS stores strictly dated activity buckets as separate cumulative streams", () => {
  const env = liveEnvironment({ ios: true });
  env.record.cmdHi = 5;
  env.record.anchorUnixSeconds = env.start / 1000;
  env.record.buckets = [{ index: 2, steps: 120, calorieLike2: 4.9, calorieLike3: 15.9 }];
  const result = env.load("health-live").syncLiveRecords();
  assert.equal(result.samplesWritten, 3);
  const held = env.load("health-store-files").healthStore()
    .samplesInRange(env.start, env.start + 3600000);
  assert.deepEqual(Array.from(held, ({ metric, total, provenance }) =>
    [metric, total, provenance?.dateSource]), [
    ["steps", 120, "ring-anchor"], ["activeCalories", 4, "ring-anchor"],
    ["calories", 15, "ring-anchor"],
  ]);
});

test("iOS activity updates buckets rather than adding repeated cumulative values", () => {
  const env = liveEnvironment({ ios: true });
  env.record.cmdHi = 5;
  env.record.anchorUnixSeconds = env.start / 1000;
  env.record.buckets = [{ index: 0, steps: 100, calorieLike2: 3, calorieLike3: 12 }];
  assert.equal(env.load("health-live").syncLiveRecords().samplesWritten, 3);
  env.redeliver();
  env.record.buckets[0] = { index: 0, steps: 120, calorieLike2: 4, calorieLike3: 15 };
  assert.equal(env.load("health-live").syncLiveRecords().samplesWritten, 3);
  const held = env.load("health-store-files").healthStore()
    .samplesInRange(env.start, env.start + 600000);
  assert.deepEqual(Array.from(held, ({ metric, total }) => [metric, total]), [
    ["steps", 120], ["activeCalories", 4], ["calories", 15],
  ]);
});

test("iOS keeps completed activity rows when the page also contains current and future rows", () => {
  const env = liveEnvironment({ ios: true });
  env.record.cmdHi = 5;
  env.record.anchorUnixSeconds = env.start / 1000;
  env.record.receivedAtMs = env.start + 15 * 60_000;
  env.record.buckets = [
    { index: 0, steps: 100, calorieLike2: 3, calorieLike3: 12 },
    { index: 1, steps: 20, calorieLike2: 1, calorieLike3: 2 },
    { index: 5, steps: 10, calorieLike2: 1, calorieLike3: 1 },
  ];
  assert.equal(env.load("health-live").syncLiveRecords().samplesWritten, 3);
  const held = env.load("health-store-files").healthStore()
    .samplesInRange(env.start, env.start + 3600000);
  assert.deepEqual(Array.from(held, ({ metric, total }) => [metric, total]), [
    ["steps", 100], ["activeCalories", 3], ["calories", 12],
  ]);
});

test("iOS accepts a bounded activity anchor recorded in another phone timezone", () => {
  const env = liveEnvironment({ ios: true });
  const recordedMidnight = Date.UTC(2026, 5, 1, 7);
  env.record.cmdHi = 5;
  env.record.anchorUnixSeconds = recordedMidnight / 1000;
  env.record.receivedAtMs = recordedMidnight + 3600000;
  env.record.buckets = [{ index: 0, steps: 80, calorieLike2: 2, calorieLike3: 10 }];
  assert.equal(env.load("health-live").syncLiveRecords().samplesWritten, 3);
  assert.equal(env.load("health-store-files").healthStore()
    .samplesInRange(recordedMidnight, recordedMidnight + 600000).length, 3);
});

test("iOS rejects invalid activity anchors indexes values and future buckets", () => {
  const variants = [
    { anchorUnixSeconds: Date.UTC(2019, 0, 1) / 1000, index: 0, steps: 1, active: 1, total: 1 },
    { index: -1, steps: 1, active: 1, total: 1 },
    { index: 144, steps: 1, active: 1, total: 1 },
    { index: 0.5, steps: 1, active: 1, total: 1 },
    { index: 0, steps: -1, active: 1, total: 1 },
    { index: 0, steps: 1, active: -1, total: 1 },
    { index: 0, steps: 1, active: 1, total: 65536 },
    { anchorUnixSeconds: (Date.now() + 3600000) / 1000, index: 0, steps: 1, active: 1, total: 1 },
  ];
  for (const variant of variants) {
    const env = liveEnvironment({ ios: true });
    env.record.cmdHi = 5;
    env.record.receivedAtMs = Date.now();
    env.record.anchorUnixSeconds = variant.anchorUnixSeconds ?? env.start / 1000;
    env.record.buckets = [{
      index: variant.index, steps: variant.steps,
      calorieLike2: variant.active, calorieLike3: variant.total,
    }];
    assert.equal(env.load("health-live").syncLiveRecords().samplesWritten, 0);
  }
});

test("iOS stores only internally consistent UTC sleep and retains raw temperature", () => {
  const env = liveEnvironment({ ios: true });
  const startTs = Math.floor((env.start - 3600000) / 1000);
  Object.assign(env.record, {
    cmdHi: 6, recordState: 1, startTs, endTs: startTs + 3600,
    totalTime: 3000, wakeTime: 600, remTime: 600, lightTime: 1800, deepTime: 600,
    segments: [
      { stage: 0, halfMinutes: 20 }, { stage: 1, halfMinutes: 20 },
      { stage: 2, halfMinutes: 60 }, { stage: 3, halfMinutes: 20 },
    ], temperatureRaw: 312, utcOffsetMinutes: -300, receivedAtMs: env.start,
  });
  assert.equal(env.load("health-live").syncLiveRecords().sleepWritten, 1);
  const sleep = env.load("health-store-files").healthStore().sleepSessions()[0];
  assert.equal(sleep.startMs, startTs * 1000);
  assert.equal(sleep.endMs, (startTs + 3600) * 1000);
  assert.equal(sleep.temperatureRaw, 312);
  assert.equal(sleep.utcOffsetMinutes, -300);
  assert.equal(sleep.provenance.dateSource, "ring-sleep");
});

test("iOS keeps a verified sleep batch when durable storage fails", () => {
  const env = liveEnvironment({ ios: true });
  const startTs = Math.floor((env.start - 3600000) / 1000);
  Object.assign(env.record, {
    cmdHi: 6, recordState: 1, startTs, endTs: startTs + 3600,
    totalTime: 3000, wakeTime: 600, remTime: 600, lightTime: 1800, deepTime: 600,
    segments: [
      { stage: 0, halfMinutes: 20 }, { stage: 1, halfMinutes: 20 },
      { stage: 2, halfMinutes: 60 }, { stage: 3, halfMinutes: 20 },
    ], temperatureRaw: 0, utcOffsetMinutes: -300, receivedAtMs: env.start,
  });
  env.faults.append = new Error("disk full");
  assert.throws(() => env.load("health-live").syncLiveRecords(), /disk full/);
  assert.equal(env.consumed(), false);
  env.faults.append = null;
  assert.equal(env.load("health-live").syncLiveRecords().sleepWritten, 1);
  assert.equal(env.consumed(), true);
  assert.equal(env.load("health-store-files").healthStore().sleepSessions()[0].temperatureRaw, null);
});

test("iOS rejects mismatched sleep durations stages dates and future sessions", () => {
  const base = {
    cmdHi: 6, recordState: 1,
    startTs: Math.floor(Date.UTC(2026, 0, 1) / 1000),
    endTs: Math.floor(Date.UTC(2026, 0, 1, 1) / 1000),
    totalTime: 3000, wakeTime: 600, remTime: 600, lightTime: 1800, deepTime: 600,
    segments: [
      { stage: 0, halfMinutes: 20 }, { stage: 1, halfMinutes: 20 },
      { stage: 2, halfMinutes: 60 }, { stage: 3, halfMinutes: 20 },
    ], temperatureRaw: 0, utcOffsetMinutes: 0,
    receivedAtMs: Date.UTC(2026, 0, 1, 2),
  };
  const variants = [
    { startTs: Math.floor(Date.UTC(2019, 0, 1) / 1000) },
    { endTs: Math.floor(Date.UTC(2026, 0, 1, 3) / 1000) },
    { totalTime: 2999 }, { remTime: 599 },
    { segments: [{ stage: 4, halfMinutes: 120 }] },
    { segments: [{ stage: 2, halfMinutes: 119 }] },
    { temperatureRaw: 65536 }, { utcOffsetMinutes: 900 },
  ];
  for (const variant of variants) {
    const env = liveEnvironment({ ios: true });
    Object.assign(env.record, base, variant);
    const result = env.load("health-live").syncLiveRecords();
    assert.equal(result.sleepWritten, 0, JSON.stringify(variant));
  }
});

test("journal replay keeps activity and sleep origin unknown", () => {
  const startTs = Math.floor(new Date(2026, 0, 1).getTime() / 1000);
  const replayed = [
    { cmdHi: 5, anchorUnixSeconds: startTs, receivedAtMs: (startTs + 3600) * 1000,
      buckets: [{ index: 0, steps: 10, calorieLike2: 1, calorieLike3: 2 }] },
    { cmdHi: 6, recordState: 1, startTs, endTs: startTs + 3600,
      totalTime: 3000, wakeTime: 600, remTime: 600, lightTime: 1800, deepTime: 600,
      segments: [{ stage: 0, halfMinutes: 20 }, { stage: 1, halfMinutes: 20 },
        { stage: 2, halfMinutes: 60 }, { stage: 3, halfMinutes: 20 }],
      temperatureRaw: 0, utcOffsetMinutes: 0, receivedAtMs: (startTs + 3600) * 1000 },
  ];
  const env = liveEnvironment({ ios: true, ringProtocol: { decodeFrameJournal: () => replayed } });
  env.record.cmdHi = 99;
  env.files.set('/Library/Application Support/health/ring-frames.jsonl', 'durable pages');
  env.load("health-live").syncLiveRecords();
  assert.ok(env.load("health-store-files").healthStore()
    .samplesInRange(startTs * 1000, (startTs + 3600) * 1000).every(sample => !sample.provenance));
  const sleep = env.load("health-store-files").healthStore().sleepSessions()[0];
  assert.equal(sleep.provenance, undefined);
  assert.equal(sleep.temperatureRaw, null, "zero is the device's unavailable sentinel");
});

test("iOS replays acknowledged pages even when the receive-time cursor is ahead after clock rollback", () => {
  const afterValues = [];
  let saved;
  const env = liveEnvironment({ ios: true, ringProtocol: {
    decodeFrameJournal: (_text, after) => { afterValues.push(after); return saved.receivedAtMs > after ? [saved] : []; },
  } });
  env.record.anchorUnixSeconds = env.start / 1000;
  saved = { ...env.record, receivedAtMs: 900, groups: [{ hourIndex: 1, avg: 55, min: 50, max: 60 }] };
  env.files.set('/Library/Application Support/health/ring-frames.jsonl', 'durable page');
  env.files.set('/Library/Application Support/health/journal-replay.json', JSON.stringify({ version: 2, throughReceivedAtMs: 1000 }));
  env.load('health-live').syncLiveRecords();
  env.load('health-live').syncLiveRecords();
  assert.deepEqual(afterValues, [0]);
  assert.equal(env.load('health-store-files').healthStore().samplesInRange(env.start, env.start + 86400000).length, 2);
  const replayed = env.load('health-store-files').healthStore()
    .samplesInRange(env.start, env.start + 86400000).find(sample => sample.avg === 55);
  assert.equal(replayed.provenance, undefined, "journal replay is not attributed to the currently paired ring");
});

test("Android live records remain origin-unknown", () => {
  const env = liveEnvironment();
  env.load("health-live").syncLiveRecords();
  const held = env.load("health-store-files").healthStore()
    .samplesInRange(env.start - 86400000, env.start + 86400000)[0];
  assert.equal(held.provenance, undefined);
});

test("first live sync removes fixture samples, sleep and rollups from memory and disk", () => {
  const env = liveEnvironment();
  const seed = env.load("health-seed");
  const store = env.load("health-store-files").healthStore();
  assert.equal(seed.seedFixturesIfNeeded(2), true);
  assert.ok(store.sleepSessions().length > 0);
  assert.ok(store.samplesInRange(env.start, env.start + 86400000).length > 1);

  env.load("health-live").syncLiveRecords();
  assert.equal(seed.isFixtureData(), false);
  assert.equal(env.consumed(), true);
  assert.equal(store.sleepSessions().length, 0);
  const samples = store.samplesInRange(env.start, env.start + 86400000);
  assert.equal(samples.length, 1);
  assert.equal(samples[0].avg, 45);
  const rollups = JSON.parse(env.files.get("/health/rollups.json"));
  assert.equal(Object.keys(rollups.days).length, 1);
  const day = Object.values(rollups.days)[0];
  assert.deepEqual(Object.keys(day), ["heartRate"]);
  assert.equal(day.heartRate.count, 1);
});

test("a failed fixture purge retains the badge and ring batch until retry succeeds", () => {
  const env = liveEnvironment();
  const seed = env.load("health-seed");
  seed.seedFixturesIfNeeded(2);
  const live = env.load("health-live");
  env.faults.remove = new Error("delete failed");
  assert.throws(() => live.syncLiveRecords(), /delete failed/);
  assert.equal(env.consumed(), false);
  assert.equal(seed.isFixtureData(), true);
  env.faults.remove = null;
  live.syncLiveRecords();
  assert.equal(env.consumed(), true);
  assert.equal(seed.isFixtureData(), false);
});

test("NativeScript append callback failures retain the batch and retry persists it", () => {
  const env = liveEnvironment();
  const live = env.load("health-live");
  env.faults.append = { message: "disk full" };
  assert.throws(() => live.syncLiveRecords(), /disk full/);
  assert.equal(env.consumed(), false);
  assert.equal([...env.files.keys()].filter((name) => name.includes("samples-")).length, 0);
  env.faults.append = null;
  assert.equal(live.syncLiveRecords().samplesWritten, 1);
  assert.equal(env.consumed(), true);
  assert.equal([...env.files.keys()].filter((name) => name.includes("samples-")).length, 1);
});

test("NativeScript rollup write callback failures propagate without consuming the batch", () => {
  const env = liveEnvironment();
  env.faults.write = { message: "write failed" };
  assert.throws(() => env.load("health-live").syncLiveRecords(), /write failed/);
  assert.equal(env.consumed(), false);
  env.faults.write = null;
  assert.equal(env.load("health-live").syncLiveRecords().samplesWritten, 0);
  assert.equal(env.consumed(), true);
  assert.equal(env.files.has("/health/rollups.json"), true);
  assert.equal(env.load("health-seed").hasLiveData(), true);
  assert.equal(env.load("health-seed").seedFixturesIfNeeded(), false);
});

test("a failed fixture append stays labelled and is purged before live ingest", () => {
  const env = liveEnvironment();
  const seed = env.load("health-seed");
  env.faults.append = new Error("disk full");
  assert.equal(seed.seedFixturesIfNeeded(2), false);
  assert.equal(seed.isFixtureData(), true);
  env.faults.append = null;
  env.load("health-live").syncLiveRecords();
  assert.equal(seed.isFixtureData(), false);
  assert.equal(env.load("health-store-files").healthStore().sleepSessions().length, 0);
});

test("journaled pages are replayed once, before the live batch, and again after a decoder upgrade", () => {
  const calls = [];
  let journalRecords = [];
  const ringProtocol = {
    decodeFrameJournal: (text, after) => {
      calls.push({ text, after });
      const list = journalRecords.filter((r) => r.receivedAtMs > after);
      return { size: () => list.length, get: (i) => list[i] };
    },
  };
  const env = liveEnvironment({ ringProtocol });
  const seed = env.load("health-seed");
  seed.seedFixturesIfNeeded(2);
  env.files.set("/health/ring-frames.jsonl", "journal text");
  // A page the ring sent an hour earlier, never decoded at the time.
  journalRecords = [{ ...env.record, groups: [{ hourIndex: 1, min: 50, max: 60, avg: 55 }], receivedAtMs: 1000 }];
  const live = env.load("health-live");
  const store = env.load("health-store-files").healthStore();

  live.syncLiveRecords();
  assert.deepEqual(calls.map((c) => [c.text, c.after]), [["journal text", 0]]);
  assert.equal(seed.isFixtureData(), false);
  // A wide range: on a DST-change day the fixture record's hour 0 falls before local midnight.
  const avgs = Array.from(store.samplesInRange(env.start - 86400000, env.start + 2 * 86400000), (s) => s.avg).sort();
  assert.deepEqual(avgs, [45, 55]);
  assert.deepEqual(JSON.parse(env.files.get("/health/journal-replay.json")),
    { version: 2, throughReceivedAtMs: 1000 });

  // Once per process.
  live.syncLiveRecords();
  assert.equal(calls.length, 1);

  // The next process resumes after the cursor...
  const next = liveEnvironment({ ringProtocol });
  for (const [name, text] of env.files) next.files.set(name, text);
  next.load("health-live").syncLiveRecords();
  assert.equal(calls.at(-1).after, 1000);

  // ...unless the cursor came from an older decoder, which may have skipped pages.
  const upgraded = liveEnvironment({ ringProtocol });
  for (const [name, text] of env.files) upgraded.files.set(name, text);
  upgraded.files.set("/health/journal-replay.json", JSON.stringify({ version: 1, throughReceivedAtMs: 1000 }));
  upgraded.load("health-live").syncLiveRecords();
  assert.equal(calls.at(-1).after, 0);
});

test("a failed journal replay is retried on the next sync and never blocks the live batch", () => {
  let failures = 1;
  const ringProtocol = {
    decodeFrameJournal: () => {
      if (failures-- > 0) throw new Error("decode blew up");
      return { size: () => 0, get: () => null };
    },
  };
  const env = liveEnvironment({ ringProtocol });
  env.files.set("/health/ring-frames.jsonl", "journal text");
  const live = env.load("health-live");
  assert.equal(live.syncLiveRecords().samplesWritten, 1);
  assert.equal(env.consumed(), true);
  live.syncLiveRecords();
  assert.equal(failures, -1, "replay was not retried");
});
