const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
  const sent = [], prompts = [], failures = [], connections = [];
  let listener, closed = false, choose;
  const load = loader({ setTimeout, clearTimeout, setInterval, clearInterval }, {
    '../native/socket': { openSocket(url, events, header) {
      connections.push({url, header});
      listener = events;
      return { sendText(text) { sent.push(JSON.parse(text)); return !closed; }, close() { closed = true; } };
    } },
    '../native/gateway-identity': { signGatewayChallenge() { return { id: 'device', publicKey: 'public', signature: 'signature', nonce: 'nonce', signedAt: 1000 }; } },
  });
  const { OpenClawInputClient } = load('app/assistant/openclaw-input-client.ts');
  const client = new OpenClawInputClient({ baseUrl: 'https://private.example:8445/v1', apiKey: 'fixture',
    onQuestion: prompt => { prompts.push(prompt); return new Promise(resolve => { choose = resolve; }); },
    onError: error => failures.push(error),
  });
  const receive = frame => listener.onTextMessage(JSON.stringify(frame));
  const respond = (request, payload, ok = true) => receive({ type: 'res', id: request.id, ok, ...(ok ? { payload } : { error: payload }) });
  async function connect() {
    const promise = client.connect();
    receive({ type: 'event', event: 'connect.challenge', payload: { nonce: 'nonce', ts: 1000 } });
    respond(sent[0], { type: 'hello-ok', protocol: 4, server: { connId: 'connection-1' }, auth: { role: 'operator', scopes: ['operator.read','operator.questions','operator.approvals'] },
      features: { methods: ['question.list','question.get','question.resolve','plugin.approval.list','plugin.approval.resolve'], events: ['question.requested','question.resolved','plugin.approval.requested','plugin.approval.resolved'] } });
    assert.equal(await promise, 'connection-1');
  }
  return { client, sent, prompts, failures, connections, connect, receive, respond, choose: answer => choose(answer), isClosed: () => closed };
}
function record(overrides={}) { return { id:'q1', sessionKey:'session-1', runId:'run-1', status:'pending', createdAtMs:Date.now(), expiresAtMs:Date.now()+60000,
  // Core ask_user adds isOther:true even when choosing an advertised option.
  questions:[{questionId:'consent',question:'Allow synthetic conversation access?',isOther:true,options:[{label:'Allow',value:'allow'}, {label:'Decline',value:'decline'}]}], ...overrides }; }
async function lists(h, questions, approvals=[]) {
  await flush();
  h.respond(h.sent.findLast(r => r.method === 'question.list'), {questions});
  h.respond(h.sent.findLast(r => r.method === 'plugin.approval.list'), approvals);
  await flush();
}

test('connect uses device proof and specific approval scopes, never administrator', async () => {
  const h=fixture(); try {
    await h.connect();
    assert.equal(h.sent[0].params.client.id,'webchat-ui');
    assert.deepEqual(h.sent[0].params.caps,['approvals']);
    assert.deepEqual(h.sent[0].params.scopes,['operator.read','operator.questions','operator.approvals']);
  } finally { h.client.close(); }
});

test('confirmation socket supplies its exact HTTPS origin including the private port', async () => {
  const h=fixture(); try {
    await h.connect();
    assert.equal(h.connections.length, 1);
    assert.equal(h.connections[0].url, 'wss://private.example:8445/');
    assert.equal(h.connections[0].header?.name, 'Origin');
    assert.equal(h.connections[0].header?.value, 'https://private.example:8445');
  } finally { h.client.close(); }
});

test('only the current HTTP run question reaches UI; explicit answer rereads exact binding', async () => {
  const h=fixture(); try {
    await h.connect(); h.client.bindRun('run-1','session-1','connection-1');
    await lists(h,[record({id:'other',runId:'run-2'}),record()]);
    assert.equal(h.prompts.length,1);
    assert.equal(h.sent.some(r=>r.method==='question.resolve'),false);
    h.choose({consent:[0]}); await flush();
    const get=h.sent.findLast(r=>r.method==='question.get');
    h.respond(get,{question:record()}); await flush();
    const resolution=h.sent.findLast(r=>r.method==='question.resolve');
    assert.deepEqual(resolution.params,{id:'q1',answers:{answers:{consent:['allow']}}});
    h.respond(resolution,{ok:true}); await flush();
  } finally { h.client.close(); }
});

test('cancel, expired, changed prompt and disconnect cannot submit an Allow', async () => {
  for (const mode of ['cancel','expired','changed','disconnect']) {
    const h=fixture(); try {
      await h.connect(); h.client.bindRun('run-1','session-1','connection-1');
      const original=record(); await lists(h,[original]);
      if(mode==='cancel') h.client.endRun();
      if(mode==='disconnect') h.receive({type:'event',event:'shutdown',payload:{}});
      h.choose({consent:[0]}); await flush();
      const get=h.sent.findLast(r=>r.method==='question.get');
      if(get) h.respond(get,{question:mode==='expired'?record({expiresAtMs:1}):record({questions:[{...original.questions[0],question:'A different operation'}]})});
      await flush();
      assert.equal(h.sent.some(r=>r.method==='question.resolve' && r.params.answers),false,mode);
      assert.equal(h.prompts[0].signal.aborted,true,mode);
    } finally { h.client.close(); }
  }
});

test('wrong server connection binding fails closed', async () => {
  const h=fixture(); try { await h.connect(); assert.throws(()=>h.client.bindRun('run-1','session-1','different'),/binding/i); }
  finally {h.client.close();}
});

test('send approval displays full exact text and resolves once only after a fresh matching record', async () => {
  const h=fixture(); try {
    await h.connect();h.client.bindRun('run-1','session-1','connection-1');
    const exact='This is a synthetic test. '.repeat(80)+'END';
    const approval={id:'plugin:1',createdAtMs:Date.now(),expiresAtMs:Date.now()+60000,request:{
      sessionKey:'session-1',runId:'run-1',title:'Send',description:'Short summary',pluginId:'codex',toolName:'codex_mcp_tool_approval',toolCallId:'call-1',mcpTool:{server:'messages',tool:'send_message'},allowedDecisions:['allow-once','deny'],
      detail:JSON.stringify({kind:'faceclaw-message-send-v1',recipient:'Synthetic recipient',text:exact,toolCallId:'call-1',argumentsSha256:'a'.repeat(64)})}};
    await lists(h,[],[approval]);assert.equal(h.prompts.length,1);
    assert.ok(h.prompts[0].questions[0].question.endsWith(exact));
    assert.equal(h.prompts[0].questions[0].options[0].label,'Cancel');
    h.choose({decision:[1]});await flush();
    const list=h.sent.findLast(r=>r.method==='plugin.approval.list');h.respond(list,[approval]);await flush();
    const resolve=h.sent.findLast(r=>r.method==='plugin.approval.resolve');
    assert.deepEqual(resolve.params,{id:'plugin:1',decision:'allow-once'});
    h.respond(resolve,{ok:true});await flush();
    assert.equal(h.sent.filter(r=>r.method==='plugin.approval.resolve').length,1);
  }finally{h.client.close()}
});

test('truncated or missing plugin details never offer permission to send',async()=>{
  const h=fixture();try{
    await h.connect();h.client.bindRun('run-1','session-1','connection-1');
    const approval={id:'plugin:1',createdAtMs:Date.now(),expiresAtMs:Date.now()+60000,request:{sessionKey:'session-1',runId:'run-1',title:'Send',description:'text truncated...',allowedDecisions:['allow-once','deny']}};
    await lists(h,[],[approval]);assert.deepEqual(Array.from(h.prompts[0].questions[0].options,x=>x.value),['deny']);
    h.client.endRun();h.choose({decision:[1]});await flush();
    assert.equal(h.sent.some(r=>r.method==='plugin.approval.resolve'),false);
  }finally{h.client.close()}
});

test('another plugin cannot disguise its approval as a Messages send',async()=>{
  const h=fixture();try{
    await h.connect();h.client.bindRun('run-1','session-1','connection-1');
    const approval={id:'plugin:1',createdAtMs:Date.now(),expiresAtMs:Date.now()+60000,request:{sessionKey:'session-1',runId:'run-1',title:'Send',description:'Unrelated operation',pluginId:'other',toolName:'other_tool',allowedDecisions:['allow-once','deny'],detail:JSON.stringify({kind:'faceclaw-message-send-v1',recipient:'Fake',text:'Fake'})}};
    await lists(h,[],[approval]);assert.deepEqual(Array.from(h.prompts[0].questions[0].options,x=>x.value),['deny']);
    h.client.endRun();h.choose(null);await flush();
  }finally{h.client.close()}
});
