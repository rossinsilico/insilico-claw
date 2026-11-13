const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

function loadExport() {
  const filename = path.join(__dirname, "../app/health/healthkit-export.ts");
  const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports,
    require: name => name === "./health-types" ? { HOUR_MS: HOUR } : require(name),
  }, { filename });
  return module.exports;
}

const HOUR = 3_600_000;
const start = Date.UTC(2026, 10, 10, 12);
const now = start + 4 * HOUR;

function sample(metric, overrides = {}) {
  return {
    metric, startMs: start, spanMs: 0, min: 72, max: 72, avg: 72, total: 72,
    provenance: {
      kind: "r1-live", ringId: "AA:BB:CC:DD:EE:FF", receivedAtMs: start + HOUR,
      dateSource: "ring-latest", exportRevision: 1,
    },
    ...overrides,
  };
}

test("exports captured latest readings at their original measurement time", () => {
  const { buildR1HealthKitExport } = loadExport();
  const result = buildR1HealthKitExport([
    sample("heartRate"),
    sample("spo2", { min: 97, max: 97, avg: 97, total: 97,
      provenance: { ...sample("spo2").provenance, exportRevision: 3 } }),
  ], { nowMs: now, startMs: start, endMs: now });

  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    samples: [
      { type: "heartRate", value: 72, startMs: start, endMs: start,
        syncIdentifier: `faceclaw-r1|AA:BB:CC:DD:EE:FF|heartRate|point|${start}`,
        syncVersion: 1 },
      { type: "oxygenSaturation", value: 0.97, startMs: start, endMs: start,
        syncIdentifier: `faceclaw-r1|AA:BB:CC:DD:EE:FF|spo2|point|${start}`,
        syncVersion: 3 },
    ],
    excluded: 0,
  });
});

test("rejects unknown origins, unsupported metrics, invalid measurements, and unsafe dates", () => {
  const { buildR1HealthKitExport } = loadExport();
  const invalid = [
    sample("heartRate", { provenance: undefined }),
    sample("hrv"),
    sample("steps"),
    sample("heartRate", { avg: 301, max: 301 }),
    sample("spo2", { min: 95, avg: 101, max: 101 }),
    sample("heartRate", { min: 80, avg: 70, max: 90 }),
    sample("heartRate", { spanMs: HOUR / 2 }),
    sample("heartRate", { spanMs: HOUR, provenance: { ...sample("heartRate").provenance, dateSource: "ring-anchor" } }),
    sample("heartRate", { min: 60, max: 90 }),
    sample("heartRate", { startMs: 0 }),
    sample("heartRate", { startMs: now, provenance: { ...sample("heartRate").provenance, receivedAtMs: now + HOUR } }),
    sample("heartRate", { provenance: { ...sample("heartRate").provenance, ringId: "" } }),
    sample("heartRate", { provenance: { ...sample("heartRate").provenance, exportRevision: 0 } }),
    sample("heartRate", { provenance: { ...sample("heartRate").provenance, receivedAtMs: start - 1 } }),
    sample("heartRate", { provenance: { ...sample("heartRate").provenance, receivedAtMs: now + 1 } }),
    sample("heartRate", { provenance: { ...sample("heartRate").provenance, receivedAtMs: Number.NaN } }),
  ];
  const result = buildR1HealthKitExport(invalid, { nowMs: now, startMs: start, endMs: now });
  assert.equal(result.samples.length, 0);
  assert.equal(result.excluded, invalid.length);
});

test("uses a half-open measurement-time window and stable identity across receipt updates", () => {
  const { buildR1HealthKitExport } = loadExport();
  const before = sample("heartRate", { startMs: start - HOUR,
    provenance: { ...sample("heartRate").provenance, receivedAtMs: start } });
  const endingAfter = sample("spo2", { startMs: now, min: 97, avg: 97, max: 97,
    provenance: { ...sample("spo2").provenance, receivedAtMs: now } });
  const result = buildR1HealthKitExport([before, endingAfter], { nowMs: now + HOUR, startMs: start, endMs: now });
  assert.equal(result.samples.length, 0);
  assert.equal(result.excluded, 2);
  const first = buildR1HealthKitExport([sample("heartRate")], { nowMs: now, startMs: start, endMs: now }).samples[0];
  const later = buildR1HealthKitExport([sample("heartRate", { provenance: { ...sample("heartRate").provenance, receivedAtMs: now } })],
    { nowMs: now, startMs: start, endMs: now }).samples[0];
  assert.equal(first.startMs, start);
  assert.equal(first.endMs, start);
  assert.equal(later.syncIdentifier, first.syncIdentifier);
});

test("an invalid export window excludes every sample", () => {
  const { buildR1HealthKitExport } = loadExport();
  for (const options of [
    { nowMs: Number.NaN, startMs: start, endMs: now },
    { nowMs: now, startMs: now, endMs: start },
  ]) {
    const result = buildR1HealthKitExport([sample("heartRate")], options);
    assert.equal(result.samples.length, 0);
    assert.equal(result.excluded, 1);
  }
});

test("exports genuine ten-minute steps and active kcal without relabelling total calories", () => {
  const { buildR1HealthKitExport } = loadExport();
  const activity = (metric, value) => sample(metric, { spanMs: 600_000, min: value, max: value, avg: value, total: value,
    provenance: { ...sample(metric).provenance, dateSource: 'ring-anchor' } });
  const result = buildR1HealthKitExport([activity('steps', 123), activity('activeCalories', 12), activity('calories', 24)],
    { nowMs: now, startMs: start, endMs: now });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { samples: [
    { type: 'stepCount', value: 123, startMs: start, endMs: start + 600_000,
      syncIdentifier: `faceclaw-r1|AA:BB:CC:DD:EE:FF|steps|bucket|${start}`, syncVersion: 1 },
    { type: 'activeEnergyBurned', value: 12, startMs: start, endMs: start + 600_000,
      syncIdentifier: `faceclaw-r1|AA:BB:CC:DD:EE:FF|activeCalories|bucket|${start}`, syncVersion: 1 },
  ], excluded: 1 });
});

test("maps complete source-validated sleep runs without inventing time or exporting corrected sessions", () => {
  const { buildR1SleepHealthKitExport } = loadExport();
  const session = { dayStartMs: start, startMs: start, endMs: start + 180_000, timeResolved: true,
    totalSec: 150, wakeSec: 30, remSec: 30, lightSec: 60, deepSec: 60,
    segments: [{ stageId: 0, halfMinutes: 1 }, { stageId: 1, halfMinutes: 1 }, { stageId: 2, halfMinutes: 2 }, { stageId: 3, halfMinutes: 2 }],
    provenance: { ...sample('heartRate').provenance, dateSource: 'ring-sleep' } };
  const options = { nowMs: now, startMs: start, endMs: now };
  const result = buildR1SleepHealthKitExport([session], options);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { samples: [
    { type: 'sleepAnalysis', value: 2, startMs: start, endMs: start + 30_000, syncIdentifier: `faceclaw-r1|AA:BB:CC:DD:EE:FF|sleep|${start}|0`, syncVersion: 1 },
    { type: 'sleepAnalysis', value: 5, startMs: start + 30_000, endMs: start + 60_000, syncIdentifier: `faceclaw-r1|AA:BB:CC:DD:EE:FF|sleep|${start}|1`, syncVersion: 1 },
    { type: 'sleepAnalysis', value: 3, startMs: start + 60_000, endMs: start + 120_000, syncIdentifier: `faceclaw-r1|AA:BB:CC:DD:EE:FF|sleep|${start}|2`, syncVersion: 1 },
    { type: 'sleepAnalysis', value: 4, startMs: start + 120_000, endMs: start + 180_000, syncIdentifier: `faceclaw-r1|AA:BB:CC:DD:EE:FF|sleep|${start}|3`, syncVersion: 1 },
  ], excluded: 0 });
  for (const patch of [{ timeResolved: false }, { endMs: start + 150_000 }, { totalSec: 151 },
    { provenance: undefined }, { provenance: { ...session.provenance, exportRevision: 2 } },
    { segments: undefined },
    { segments: [{ stageId: 9, halfMinutes: 6 }] }]) {
    assert.equal(buildR1SleepHealthKitExport([{ ...session, ...patch }], options).samples.length, 0);
  }
  assert.equal(buildR1SleepHealthKitExport([session], { ...options, nowMs: Infinity }).samples.length, 0);
});
