const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

function fixture({ granted = true, active = true, startError = null } = {}) {
  const requests = [], providers = [];
  const permission = {
    hasPermission: () => granted,
    requestPermission: done => requests.push(done),
  };
  const api = loader({
    FaceclawLocation: { shared: () => permission },
    FaceclawLocationUpdates: { new: () => {
      const provider = {
        starts: 0, stops: 0, eventHandler: null,
        startOnce() {
          this.starts++;
          if (startError) throw startError;
          if (!active) this.eventHandler(JSON.stringify({ error: 'Location unavailable while backgrounded' }));
        },
        stop() { this.stops++; },
      };
      providers.push(provider);
      return provider;
    } },
    UIApplication: { sharedApplication: { applicationState: active ? 0 : 2 } },
    UIApplicationState: { Active: 0 },
  })('app/native/location.ios.ts');
  return {
    api, requests, providers,
    respond(value) { granted = value; requests.shift()(value); },
  };
}

test('granted location access starts one lookup and returns its fix', async () => {
  const f = fixture();
  const result = f.api.getCurrentLocation();
  assert.equal(f.requests.length, 0);
  assert.equal(f.providers.length, 1);
  assert.equal(f.providers[0].starts, 1);
  f.providers[0].eventHandler(JSON.stringify({ latitude: 40.7, longitude: -74, accuracyMeters: 500 }));
  assert.deepEqual({ ...await result }, { latitude: 40.7, longitude: -74, accuracyMeters: 500 });
  assert.equal(f.providers[0].stops, 1);
});

test('first location lookup waits for permission before starting', async () => {
  const f = fixture({ granted: false });
  const result = f.api.getCurrentLocation();
  assert.equal(f.requests.length, 1);
  assert.equal(f.providers.length, 0);
  f.respond(true);
  await Promise.resolve();
  assert.equal(f.providers.length, 1);
  f.providers[0].eventHandler(JSON.stringify({ latitude: 51, longitude: 0 }));
  assert.equal((await result).latitude, 51);
});

test('denied location access rejects without starting a lookup', async () => {
  const f = fixture({ granted: false });
  const result = f.api.getCurrentLocation();
  f.respond(false);
  await assert.rejects(result, /Allow Location access.*Settings/);
  assert.equal(f.providers.length, 0);
});

test('first location lookup in the background directs the user to the phone', async () => {
  const f = fixture({ granted: false, active: false });
  await assert.rejects(f.api.getCurrentLocation(), /Open Faceclaw on the iPhone.*Location access/);
  assert.equal(f.requests.length, 0);
  assert.equal(f.providers.length, 0);
});

test('lookup errors reject and always stop the one-shot provider', async () => {
  const nativeFailure = fixture();
  const failed = nativeFailure.api.getCurrentLocation();
  nativeFailure.providers[0].eventHandler(JSON.stringify({ error: 'Location unavailable' }));
  await assert.rejects(failed, /Location unavailable/);
  assert.equal(nativeFailure.providers[0].stops, 1);

  const malformed = fixture();
  const invalid = malformed.api.getCurrentLocation();
  malformed.providers[0].eventHandler('{');
  await assert.rejects(invalid, /JSON|position|property/i);
  assert.equal(malformed.providers[0].stops, 1);

  const thrown = fixture({ startError: new Error('Native start failed') });
  await assert.rejects(thrown.api.getCurrentLocation(), /Native start failed/);
  assert.equal(thrown.providers[0].stops, 1);
});
