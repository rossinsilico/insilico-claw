const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

function fixture() {
  const api = loader({}, {})('app/native/head-up-settings.ts');
  const calls = [];
  const session = { ready: true, angle: 30, confirmed: true,
    isSessionReady() { return this.ready; },
    async readHeadUpAngle() { calls.push(['read']); return this.angle; },
    async setHeadUpAngle(angle) { calls.push(['write', angle]); return this.confirmed; } };
  return { api, calls, session };
}

test('binding never reads or writes an invented angle; real zero and sixty remain valid', async () => {
  const { api, calls, session } = fixture();
  api.bindHeadUpSettingsSession(session);
  assert.equal(api.headUpAngleValue(), 'Not read');
  assert.deepEqual(calls, []);
  for (const angle of [0, 60]) {
    session.angle = angle;
    assert.equal(await api.refreshHeadUpAngle(), angle);
    assert.equal(api.headUpAngleValue(), `${angle}°`);
  }
});

test('angle writes validate the boundary and publish only confirmed values', async () => {
  const { api, calls, session } = fixture();
  api.bindHeadUpSettingsSession(session);
  const generation = api.headUpSettingsGeneration();
  for (const angle of [-1, 61, 1.5, NaN, Infinity]) await assert.rejects(api.setHeadUpAngle(angle, generation), /whole number.*0.*60/);
  assert.deepEqual(calls, []);
  await api.setHeadUpAngle(40, generation);
  assert.equal(api.headUpAngleValue(), '40°');
  session.confirmed = false;
  await assert.rejects(api.setHeadUpAngle(50, generation), /both lenses/);
  assert.equal(api.headUpAngleValue(), 'Not read');
});

test('disconnect and same-session reconnect expire a picker and cached angle', async () => {
  const { api, calls, session } = fixture();
  api.bindHeadUpSettingsSession(session);
  await api.refreshHeadUpAngle();
  const generation = api.headUpSettingsGeneration();
  api.bindHeadUpSettingsSession(null);
  assert.equal(api.isHeadUpSettingsAvailable(), false);
  api.bindHeadUpSettingsSession(session);
  await assert.rejects(api.setHeadUpAngle(20, generation), /connection changed/);
  assert.deepEqual(calls, [['read']]);
  assert.equal(api.headUpAngleValue(), 'Not read');
});

test('late reads cannot publish into a replacement session or over a newer confirmed write', async () => {
  const { api, session } = fixture();
  let finish;
  session.readHeadUpAngle = () => new Promise(resolve => { finish = resolve; });
  api.bindHeadUpSettingsSession(session);
  const read = api.refreshHeadUpAngle();
  await api.setHeadUpAngle(45, api.headUpSettingsGeneration());
  finish(10); await read;
  assert.equal(api.headUpAngleValue(), '45°');
  const stale = api.refreshHeadUpAngle();
  api.bindHeadUpSettingsSession({ ...session, readHeadUpAngle: async () => 55 });
  await api.refreshHeadUpAngle();
  finish(5); await stale;
  assert.equal(api.headUpAngleValue(), '55°');
});

test('an old write cannot update or unlock a new session operation', async () => {
  const { api, session } = fixture();
  let oldFinish, newFinish;
  session.setHeadUpAngle = () => new Promise(resolve => { oldFinish = resolve; });
  api.bindHeadUpSettingsSession(session);
  const old = assert.rejects(api.setHeadUpAngle(10, api.headUpSettingsGeneration()), /connection changed/);
  const next = { ...session, setHeadUpAngle: () => new Promise(resolve => { newFinish = resolve; }) };
  api.bindHeadUpSettingsSession(next);
  const current = api.setHeadUpAngle(20, api.headUpSettingsGeneration());
  oldFinish(true); await old;
  await assert.rejects(api.setHeadUpAngle(30, api.headUpSettingsGeneration()), /already in progress/);
  newFinish(true); await current;
  assert.equal(api.headUpAngleValue(), '20°');
});

test('a failed current read clears its old value without clearing a newer write', async () => {
  const { api, session } = fixture();
  api.bindHeadUpSettingsSession(session);
  await api.refreshHeadUpAngle();
  session.readHeadUpAngle = async () => { throw new Error('Read failed'); };
  await assert.rejects(api.refreshHeadUpAngle(), /Read failed/);
  assert.equal(api.headUpAngleValue(), 'Not read');
  let rejectRead;
  session.readHeadUpAngle = () => new Promise((_, reject) => { rejectRead = reject; });
  const stale = assert.rejects(api.refreshHeadUpAngle(), /Old failure/);
  await api.setHeadUpAngle(45, api.headUpSettingsGeneration());
  rejectRead(new Error('Old failure')); await stale;
  assert.equal(api.headUpAngleValue(), '45°');
});
