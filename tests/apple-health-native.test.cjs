const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

function signal() {
  const listeners = new Set();
  return {
    aborted: false,
    addEventListener(_type, listener) { listeners.add(listener); },
    removeEventListener(_type, listener) { listeners.delete(listener); },
    abort() { this.aborted = true; for (const listener of [...listeners]) listener(); },
    listenerCount: () => listeners.size,
  };
}

function iosAdapter() {
  const timers = [];
  const native = {
    available: true, cancelled: [], accessCalls: 0,
    isAvailable() { return this.available; },
    requestAccessWithCompletion(callback) { this.accessCalls++; this.accessCallback = callback; },
    querySummaryRequestIdCompletion(day, requestId, callback) { this.query = { day, requestId, callback }; },
    writeRingSamplesRequestIdCompletion(json, requestId, callback) { this.write = { json, requestId, callback }; },
    cancelRequest(requestId) { this.cancelled.push(requestId); },
  };
  const api = loader({
    FaceclawHealthKit: { shared: () => native },
    setTimeout(callback, delay) { timers.push({ callback, delay, cleared: false }); return timers.length; },
    clearTimeout(id) { timers[id - 1].cleared = true; },
  })('app/native/apple-health.ios.ts');
  return { api, native, timers };
}

test('non-iOS adapter reports unavailable without prompting', async () => {
  const api = loader()('app/native/apple-health.ts');
  assert.equal(api.isAppleHealthAvailable(), false);
  await assert.rejects(api.requestAppleHealthAccess(), /only available on iOS/);
});

test('availability is passive and access is requested only by the explicit call', async () => {
  const { api, native } = iosAdapter();
  assert.equal(api.isAppleHealthAvailable(), true);
  assert.equal(native.accessCalls, 0);
  const pending = api.requestAppleHealthAccess();
  assert.equal(native.accessCalls, 1);
  native.accessCallback('{"ok":true,"requestCompleted":true,"readAuthorization":"not_disclosed_by_healthkit"}', null);
  assert.deepEqual(JSON.parse(JSON.stringify(await pending)), {
    ok: true, requestCompleted: true, readAuthorization: 'not_disclosed_by_healthkit',
  });
});

test('reads and validates the exact summary contract', async () => {
  const { api, native } = iosAdapter();
  const pending = api.readAppleHealthSummary('today');
  assert.equal(native.query.day, 'today');
  native.query.callback(JSON.stringify({
    ok: true, source: 'apple-health', day: 'today', timeZone: 'America/New_York',
    interval: { startMs: 100, endMs: 200 }, queriedAtMs: 210,
    metrics: {
      steps: { value: 1234, unit: 'count' },
      heartRate: { value: 72, unit: 'bpm', sampleAtMs: 180,
        source: { name: 'Watch', bundleIdentifier: 'com.apple.health' } },
      restingHeartRate: null, hrv: null, oxygenSaturation: null,
    },
  }), null);
  assert.equal((await pending).metrics.heartRate.value, 72);

  const invalid = api.readAppleHealthSummary('yesterday');
  native.query.callback('{"ok":true,"source":"apple-health"}', null);
  await assert.rejects(invalid, /Invalid Apple Health summary response/);
});

test('writes canonical records and rejects native failures', async () => {
  const { api, native } = iosAdapter();
  const endMs = Date.now();
  const records = [{ type: 'heartRate', value: 72, startMs: endMs, endMs,
    syncIdentifier: 'ring-1', syncVersion: 1 }];
  const pending = api.writeR1HealthSamples(records);
  assert.deepEqual(JSON.parse(native.write.json), records);
  native.write.callback(JSON.stringify({ ok: true, saveCompleted: true, submittedCount: 1,
    requestId: native.write.requestId }), null);
  assert.equal((await pending).submittedCount, 1);

  const failed = api.writeR1HealthSamples(records);
  native.write.callback('{"ok":false,"error":{"code":"save_failed","message":"denied"}}', 'denied');
  await assert.rejects(failed, /denied/);
});

test('forwards genuine activity and sleep intervals while rejecting unsupported semantics', async () => {
  for (const [type, value, span] of [['stepCount', 123, 600000], ['activeEnergyBurned', 12, 600000], ['sleepAnalysis', 5, 30000]]) {
    const { api, native } = iosAdapter();
    const endMs = Date.now();
    const records = [{ type, value, startMs: endMs - span, endMs, syncIdentifier: 'activity-1', syncVersion: 1 }];
    const pending = api.writeR1HealthSamples(records);
    assert.deepEqual(JSON.parse(native.write.json), records);
    native.write.callback(JSON.stringify({ ok: true, saveCompleted: true, submittedCount: 1, requestId: native.write.requestId }), null);
    assert.equal((await pending).submittedCount, 1);
  }
  const { api } = iosAdapter();
  const endMs = Date.now();
  for (const [type, value, span] of [['stepCount', 1.5, 600000], ['stepCount', 1, 30000],
    ['activeEnergyBurned', 1024, 600000], ['sleepAnalysis', 1, 30000], ['sleepAnalysis', 5, 45000],
    ['heartRateVariabilitySDNN', 42, 0], ['bodyTemperature', 36.5, 0]]) {
    await assert.rejects(api.writeR1HealthSamples([{ type, value, startMs: endMs - span, endMs,
      syncIdentifier: 'bad-1', syncVersion: 1 }]), /Invalid R1 health/);
  }
});

test('abort and nine-second timeout cancel native requests, remove listeners, and ignore late callbacks', async () => {
  const abortedSignal = signal();
  const first = iosAdapter();
  const aborted = first.api.readAppleHealthSummary('today', abortedSignal);
  const late = first.native.query.callback;
  abortedSignal.abort();
  await assert.rejects(aborted, /cancelled/);
  assert.deepEqual(first.native.cancelled, [first.native.query.requestId]);
  assert.equal(abortedSignal.listenerCount(), 0);
  late('{"ok":true}', null);

  const second = iosAdapter();
  const endMs = Date.now();
  const timedOut = second.api.writeR1HealthSamples([{ type: 'oxygenSaturation', value: 0.98,
    startMs: endMs, endMs, syncIdentifier: 'ring-2', syncVersion: 1 }]);
  assert.equal(second.timers[0].delay, 9000);
  second.timers[0].callback();
  await assert.rejects(timedOut, /timed out/);
  assert.deepEqual(second.native.cancelled, [second.native.write.requestId]);
});
