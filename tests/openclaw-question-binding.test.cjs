const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

const api = loader()('app/assistant/openclaw-questions.ts');
const NOW = 1_000;
const record = (overrides = {}) => ({
  id: 'question-1', sessionKey: 'agent:main:openai-user:phone-1', runId: 'run-1',
  status: 'pending', createdAtMs: 900, expiresAtMs: 2_000,
  questions: [
    { questionId: 'read', header: 'Messages', question: 'Allow this conversation?', options: [
      { label: 'Allow once', value: 'allow_once' }, { label: 'Deny' },
    ] },
  ],
  ...overrides,
});
const binding = { id: 'question-1', sessionKey: 'agent:main:openai-user:phone-1', runId: 'run-1' };

test('Gateway question scope stays least-privilege until execution approvals are requested', () => {
  assert.deepEqual(Array.from(api.gatewayQuestionScopes()), ['operator.read', 'operator.questions']);
  assert.deepEqual(Array.from(api.gatewayQuestionScopes(true)), ['operator.read', 'operator.questions', 'operator.approvals']);
});

test('pending question selection requires one exact live session and run match', () => {
  assert.equal(api.selectPendingQuestion([record()], binding.sessionKey, binding.runId, NOW).id, 'question-1');
  assert.equal(api.selectPendingQuestion([record({ sessionKey: 'wrong' })], binding.sessionKey, binding.runId, NOW), null);
  assert.equal(api.selectPendingQuestion([record({ runId: 'wrong' })], binding.sessionKey, binding.runId, NOW), null);
  assert.equal(api.selectPendingQuestion([record({ status: 'resolved' })], binding.sessionKey, binding.runId, NOW), null);
  assert.equal(api.selectPendingQuestion([record({ expiresAtMs: NOW })], binding.sessionKey, binding.runId, NOW), null);
  assert.equal(api.selectPendingQuestion([record(), record({ id: 'question-2' })], binding.sessionKey, binding.runId, NOW), null);
});

test('resolution revalidates binding and converts menu indexes to canonical answers', () => {
  assert.equal(JSON.stringify(api.buildQuestionResolution(record(), binding, { read: [0] }, NOW)), JSON.stringify({
    id: 'question-1', answers: { answers: { read: ['allow_once'] } },
  }));
  assert.equal(JSON.stringify(api.buildQuestionResolution(record(), binding, { read: [1] }, NOW)), JSON.stringify({
    id: 'question-1', answers: { answers: { read: ['Deny'] } },
  }));
  assert.throws(() => api.buildQuestionResolution(record(), { ...binding, runId: 'wrong' }, { read: [0] }, NOW), /binding changed/);
  assert.throws(() => api.buildQuestionResolution(record({ expiresAtMs: NOW }), binding, { read: [0] }, NOW), /no longer pending/);
  assert.throws(() => api.buildQuestionResolution(record(), binding, { read: [9] }, NOW), /valid option/);
  assert.throws(() => api.buildQuestionResolution(record(), binding, { read: ['yes'] }, NOW), /valid option/);
});

test('multi-select is explicit and custom or missing required answers fail closed', () => {
  const multi = record({ questions: [{ questionId: 'items', question: 'Choose', multiSelect: true, options: [
    { label: 'One', value: 'one' }, { label: 'Two', value: 'two' },
  ] }] });
  assert.equal(JSON.stringify(api.buildQuestionResolution(multi, binding, { items: [0, 1] }, NOW)), JSON.stringify({
    id: 'question-1', answers: { answers: { items: ['one', 'two'] } },
  }));
  assert.throws(() => api.buildQuestionResolution(record(), binding, {}, NOW), /requires an answer/);
  assert.throws(() => api.buildQuestionResolution(record({ questions: [{ questionId: 'custom', question: 'Type it' }] }), binding, { custom: [0] }, NOW), /cannot be answered safely/);
});

test('optional Other permits advertised choices but never accepts custom text or invented indexes', () => {
  const coreQuestion = record({ questions: [{
    questionId: 'color', header: 'Color', question: 'Choose a color', isOther: true,
    options: [{label:'Red'}, {label:'Blue'}],
  }] });
  assert.equal(JSON.stringify(api.buildQuestionResolution(coreQuestion, binding, { color: [1] }, NOW)), JSON.stringify({
    id:'question-1', answers:{answers:{color:['Blue']}},
  }));
  assert.throws(() => api.buildQuestionResolution(coreQuestion, binding, { color: ['custom text'] }, NOW), /valid option/);
  assert.throws(() => api.buildQuestionResolution(coreQuestion, binding, { color: [2] }, NOW), /valid option/);
  assert.throws(() => api.buildQuestionResolution(coreQuestion, binding, {}, NOW), /requires an answer/);
});
