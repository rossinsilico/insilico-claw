const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

function fixture() {
  const values = new Map([
    ['onboarding.complete', true], ['health.apple.automaticR1Sync', true],
    ['developer.ringConnectionMode', 'direct'],
  ]);
  const addresses = { right: 'AA:BB:CC:DD:EE:01', left: 'AA:BB:CC:DD:EE:02', ring: 'AA:BB:CC:DD:EE:03' };
  const ids = { right: '00000000-0000-0000-0000-000000000001', left: '00000000-0000-0000-0000-000000000002', ring: '00000000-0000-0000-0000-000000000003' };
  values.set('ios.ble.session.ringRoleLease', JSON.stringify({ringId:addresses.ring,needsRelease:false}));
  for (const role of Object.keys(ids)) values.set(`ios.ble.peripheral.${addresses[role]}`, JSON.stringify({ role, identifier: ids[role] }));
  const sessions = [], events = new Map(), completions = [], requests = [], settingsChanges=[];
  let changed, start, cancel, drains = 0, resolveScan, now = 1800000000000, drainError, drainResult=true;
  const scheduler = {
    registerWithStartCancel(a,b) { start=a;cancel=b;return true; },
    setEnabled(value) { this.enabled=value; },
    completeSuccess(id,success) { completions.push({id,success}); },
    statusJson: () => JSON.stringify({registered:true,availability:'available'}),
  };
  class Bridge {
    constructor(options) { this.options=options;this.listeners={};this.mode='idle';sessions.push(this); }
    onRingHealthPullFinished(fn) { this.listeners.pull=fn;return ()=>delete this.listeners.pull; }
    onBackgroundRingHealthFinished(fn) { this.listeners.job=fn;return ()=>delete this.listeners.job; }
    onSessionRestored(fn) { this.listeners.restore=fn;return ()=>delete this.listeners.restore; }
    onGlassesRingConnectionState(fn) { this.listeners.glassesRing=fn;return ()=>delete this.listeners.glassesRing; }
    onPhoneRingReady(fn) { this.listeners.phoneRingReady=fn;return ()=>delete this.listeners.phoneRingReady; }
    async connectGlassesRing(ringId) { (this.handbacks??=[]).push(ringId);if(this.handbackError)throw this.handbackError;return true; }
    async bindGlassesRing(addresses) { (this.bindings??=[]).push({...addresses});return this.connectGlassesRing(addresses.ring); }
    cancelGlassesRingBinding() { this.bindingCancelled=true; }
    async prepareForRingRoleChange(_timeout, authorized) { this.preparations=(this.preparations??0)+1;return authorized() && (this.preparation ?? true); }
    onStateChange(fn) { this.listeners.state=fn;return ()=>delete this.listeners.state; }
    setConnectionWanted(value) { this.wanted=value; }
    setIndependentRingHealthEnabled(value) { this.independent=value; }
    configureStateRestoration(value) { this.restoration=value; }
    startHealthOnly() { if(this.mode!=='interactive')this.mode='health-only';return true; }
    isSessionReady() { return this.mode==='interactive'; }
    canSyncRingHealth() { return this.wanted && this.independent; }
    getRingStatus() { return JSON.stringify({sessionReady:this.isSessionReady()}); }
    requestBackgroundRingHealth(generation,budget) { requests.push({generation,budget,session:this});return this.accept!==false; }
    cancelBackgroundRingHealth(generation) { this.cancelled=generation;return true; }
    async close() { this.closed=true; }
  }
  const api=loader({
    Date: class extends Date { static now(){return now;} },
    FaceclawRingHealthBackground:{shared:()=>scheduler},
    NSUserDefaultsDidChangeNotification:'defaults',NSOperationQueue:{mainQueue:{}},
    NSNotificationCenter:{defaultCenter:{addObserverForNameObjectQueueUsingBlock(_n,_o,_q,fn){changed=fn;return {};}}},
  },{
    '@nativescript/core':{ApplicationSettings:{
      getString:(key,fallback='')=>values.get(key)??fallback,setString:(key,value)=>values.set(key,value),
      getBoolean:(key,fallback=false)=>values.get(key)??fallback,setBoolean:(key,value)=>values.set(key,value),
    },Application:{resumeEvent:'resume',on:(key,fn)=>events.set(key,fn)}},
    '../g2/device-addresses':{loadDeviceAddresses:()=>({...addresses})},
    '../native/settings-store':{setStringSetting:(key,value)=>{values.set(key,value);settingsChanges.push(key);}},
    '../g2/ios-peripheral-identity':{deviceAddressError:()=>null},
    '../phone-ui/onboarding-state':{hasCompletedOnboarding:()=>values.get('onboarding.complete'),isPreviewOnlyMode:()=>values.get('onboarding.previewOnly')===true},
    '../native/faceclaw-communicator.ios':{FaceclawCommunicatorBridge:Bridge,resolveIosPeripherals:()=>new Promise(resolve=>{resolveScan=()=>resolve({...ids});})},
    './healthkit-sync.ios':{isAutomaticR1HealthSyncEnabled:()=>values.get('health.apple.automaticR1Sync')===true,syncAutomaticR1Health:async()=>{drains++;if(drainError)throw drainError;return drainResult;}},
  })('app/health/ring-session.ios.ts');
  return {api,values,addresses,sessions,requests,completions,scheduler,events,settingsChanges,
    changed:()=>changed(),start:(id='os-job',budget=25000)=>start(id,budget),cancel:id=>cancel(id),
    get resolveScan(){return resolveScan;},drains:()=>drains,advance:ms=>now+=ms,
    setDrainError:value=>drainError=value,setDrainResult:value=>drainResult=value};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('bootstrap prepares one cached health-only owner and foreground adopts it without scanning',async()=>{
  const f=fixture();f.api.initializeIosRingBackground();
  assert.equal(f.sessions.length,1);assert.equal(f.sessions[0].mode,'health-only');
  const [a,b]=await Promise.all([f.api.ensureIosSession(),f.api.ensureIosSession()]);
  assert.equal(a,b);assert.equal(a,f.sessions[0]);assert.equal(f.sessions.length,1);
});

test('scheduled job has no page dependency, correlates native completion and drains before acknowledging success',async()=>{
  const f=fixture();f.api.initializeIosRingBackground();f.start();await tick();
  assert.equal(f.requests.length,1);const req=f.requests[0];
  assert.equal(req.session.mode,'health-only');assert.equal(req.budget,25000);
  req.session.listeners.job({generation:req.generation,outcome:'completed',pages:2,watermark:7});
  await tick();assert.deepEqual(f.completions,[{id:'os-job',success:true}]);assert.ok(f.drains()>0);
  assert.equal(f.api.iosRingBackgroundStatus().lastAttempt.glassesReadyAtStart,false);
});

test('expiration cancels only its generation and stale completion cannot finish a newer job',async()=>{
  const f=fixture();f.api.initializeIosRingBackground();f.start('first');await tick();
  const first=f.requests[0];f.cancel('first');await tick();
  assert.equal(first.session.cancelled,first.generation);assert.equal(first.session.closed,undefined);
  f.start('second');await tick();const second=f.requests[1];
  first.session.listeners.job({generation:first.generation,outcome:'completed',pages:1,watermark:1});await tick();
  assert.equal(f.completions.filter(x=>x.id==='second').length,0);
  second.session.listeners.job({generation:second.generation,outcome:'completed',pages:1,watermark:2});await tick();
  assert.equal(f.completions.filter(x=>x.id==='second'&&x.success).length,1);
});

test('persisted Disconnect disables scheduler and ordinary acquisition until explicit Connect',async()=>{
  const f=fixture();f.api.initializeIosRingBackground();
  f.api.setIosSessionConnectionWanted(false);assert.equal(f.scheduler.enabled,false);
  assert.equal(await f.api.ensureIosSession(),null);
  assert.ok(await f.api.ensureIosSession({userInitiated:true}));assert.equal(f.scheduler.enabled,true);
});

test('missing cached identifier never starts a background scan or a half-configured owner',async()=>{
  const f=fixture();f.values.delete(`ios.ble.peripheral.${f.addresses.ring}`);
  f.api.initializeIosRingBackground();assert.equal(f.sessions.length,0);
  f.start();await tick();assert.equal(f.requests.length,0);assert.equal(f.resolveScan,undefined);
  assert.deepEqual(f.completions,[{id:'os-job',success:false}]);
});

test('manual transfer completion suppresses a redundant foreground catch-up',async()=>{
  const f=fixture();f.api.initializeIosRingBackground();
  f.sessions[0].listeners.pull({completed:true,pages:1,watermark:1});await tick();
  f.events.get('resume')();await tick();assert.equal(f.requests.length,0);
  f.advance(31*60000);f.events.get('resume')();await tick();assert.equal(f.requests.length,1);
});

test('an actual restoration wake starts catch-up without promoting the arms',async()=>{
  const f=fixture();f.api.initializeIosRingBackground();
  f.sessions[0].listeners.restore(1);await tick();
  assert.equal(f.requests.length,1);assert.equal(f.sessions[0].mode,'health-only');
  const restored=f.api.iosRingBackgroundStatus().lastRestoration;
  assert.equal(restored.peers,1);assert.ok(restored.at>0);
  const req=f.requests[0];req.session.listeners.job({generation:req.generation,outcome:'completed',pages:1,watermark:1});await tick();
  f.advance(1000);f.sessions[0].listeners.restore(2);await tick();
  assert.equal(f.requests.length,1);
  const latest=f.api.iosRingBackgroundStatus().lastRestoration;
  assert.equal(latest.at,restored.at+1000);assert.equal(latest.peers,2);
});

test('replacing the foreground consumer detaches the old UI without closing the shared owner',()=>{
  const f=fixture();f.api.initializeIosRingBackground();const bridge=f.sessions[0];let detached=0;
  f.api.claimIosSessionForUi(bridge,()=>detached++);
  f.api.claimIosSessionForUi(bridge,()=>{});
  assert.equal(detached,1);assert.equal(bridge.closed,undefined);
});

test('configuration changes during discovery cannot publish the previous ring owner',async()=>{
  const f=fixture();f.values.delete(`ios.ble.peripheral.${f.addresses.right}`);f.api.initializeIosRingBackground();
  const pending=f.api.ensureIosSession({allowScan:true});await tick();
  f.addresses.ring='AA:BB:CC:DD:EE:04';f.changed();f.resolveScan();
  assert.equal(await pending,null);assert.equal(f.sessions.length,0);
});

test('configuration changes cancel active old-ring work and retire that owner',async()=>{
  const f=fixture();f.api.initializeIosRingBackground();f.start();await tick();
  const old=f.sessions[0],request=f.requests[0];f.addresses.ring='AA:BB:CC:DD:EE:04';f.changed();await tick();
  assert.equal(old.cancelled,request.generation);assert.equal(old.closed,true);
  old.listeners.job?.({generation:request.generation,outcome:'completed',pages:1,watermark:1});await tick();
  assert.equal(f.completions.some(x=>x.success),false);
});

test('deferred export is retried even when no new Bluetooth collection is due',async()=>{
  const f=fixture();f.api.initializeIosRingBackground();
  f.sessions[0].listeners.pull({completed:true,pages:1,watermark:1});await tick();
  f.setDrainError(new Error('store unavailable'));f.events.get('resume')();await tick();
  assert.equal(f.drains(),2);assert.equal(f.requests.length,0);
  f.start('retry-fails');await tick();assert.deepEqual(f.completions.at(-1),{id:'retry-fails',success:false});
  f.setDrainError(null);f.start('retry-succeeds');await tick();
  assert.deepEqual(f.completions.at(-1),{id:'retry-succeeds',success:true});
});

test('an early drain return never advances success or claims export completion',async()=>{
  const f=fixture();f.setDrainResult(false);f.api.initializeIosRingBackground();f.start();await tick();
  const req=f.requests[0];req.session.listeners.job({generation:req.generation,outcome:'completed',pages:1,watermark:1});await tick();
  assert.equal(f.api.iosRingBackgroundStatus().lastCompletedAt,undefined);
  assert.equal(f.api.iosRingBackgroundStatus().lastAttempt.exportCompleted,undefined);
  assert.deepEqual(f.completions,[{id:'os-job',success:false}]);
});

test('local export retries when collection is due but the ring rejects new work',async()=>{
  const f=fixture();f.api.initializeIosRingBackground();f.sessions[0].accept=false;
  f.events.get('resume')();await tick();assert.ok(f.drains()>0);
  const before=f.drains();f.start('offline-ring');await tick();
  assert.ok(f.drains()>before);assert.deepEqual(f.completions.at(-1),{id:'offline-ring',success:false});
});

test('each ring mode has its intended phone role and retains original health identity',async()=>{
  for(const mode of ['direct','glasses','health']){
    const f=fixture();f.values.set('developer.ringConnectionMode',mode);f.api.initializeIosRingBackground();
    const options=f.sessions[0].options;
    assert.equal(Boolean(options.ring),mode!=='glasses');
    assert.equal(options.ringRole,mode==='direct'?'glasses':mode==='health'?'phone':undefined);
    assert.equal(options.healthRingId,mode!=='glasses'?f.addresses.ring:undefined);
  }
});

test('health and glasses modes have distinct session identities and G1 always uses Direct',async()=>{
  const f=fixture();f.values.set('developer.ringConnectionMode','health');f.api.initializeIosRingBackground();const previous=f.sessions[0];
  f.values.set('developer.ringConnectionMode','glasses');f.changed();await tick();
  assert.equal(previous.closed,true);await f.api.ensureIosSession();assert.equal(f.sessions.length,2);assert.equal(f.sessions[1].options.ring,'');
  const g=fixture();g.values.set('deviceType','g1');g.values.set('developer.ringConnectionMode','glasses');g.api.initializeIosRingBackground();
  assert.equal(g.sessions[0].options.ringRole,'glasses');assert.equal(g.sessions[0].options.healthRingId,g.addresses.ring);
});

test('health handback waits for G2 readiness and remains pending until matching connection evidence',async()=>{
  const f=fixture();f.values.set('developer.ringConnectionMode','health');f.api.initializeIosRingBackground();const s=f.sessions[0];
  assert.equal(s.handbacks,undefined);
  s.listeners.state({phase:'connected',status:'Connected'});s.listeners.state({phase:'connected',status:'Connected'});await tick();
  assert.deepEqual(s.handbacks,[f.addresses.ring]);assert.equal(f.api.iosRingBackgroundStatus().ringConnection.state,'queued');
  assert.deepEqual(s.bindings,[f.addresses]);
  s.listeners.glassesRing({connected:true,ringId:'AA:BB:CC:DD:EE:99'});await tick();
  assert.equal(f.api.iosRingBackgroundStatus().ringConnection.state,'queued');
  s.listeners.glassesRing({connected:true,ringId:f.addresses.ring});await tick();
  assert.equal(f.api.iosRingBackgroundStatus().ringConnection.state,'confirmed');
  s.listeners.state({phase:'disconnected',status:'Disconnected'});await tick();
  assert.equal(f.api.iosRingBackgroundStatus().ringConnection.state,'pending');
  f.api.setIosSessionConnectionWanted(false);
  assert.equal(f.api.iosRingBackgroundStatus().ringConnection.state,'disconnected');
});

test('Glasses-only mode uses its retained binding without opening a PHONE binding operation',async()=>{
  const f=fixture();f.values.set('developer.ringConnectionMode','glasses');f.api.initializeIosRingBackground();const s=f.sessions[0];
  s.listeners.state({phase:'connected',status:'Connected'});await tick();
  assert.deepEqual(s.handbacks,[f.addresses.ring]);assert.equal(s.bindings,undefined);
});

test('a mode change cancels an in-flight ring binding before retiring the old owner',async()=>{
  const f=fixture();f.values.set('developer.ringConnectionMode','health');f.api.initializeIosRingBackground();const old=f.sessions[0];
  f.values.set('developer.ringConnectionMode','direct');f.changed();
  assert.equal(old.bindingCancelled,true);await tick();assert.equal(old.closed,true);
});

test('late binding failure cannot overwrite a real matching G2 ring connection',async()=>{
  const f=fixture();f.values.set('developer.ringConnectionMode','health');f.api.initializeIosRingBackground();const s=f.sessions[0];let fail;
  s.bindGlassesRing=()=>new Promise((_resolve,reject)=>fail=reject);
  s.listeners.state({phase:'connected',status:'Connected'});await tick();
  s.listeners.glassesRing({connected:true,ringId:f.addresses.ring});fail(new Error('Binding cancelled.'));await tick();
  assert.equal(f.api.iosRingBackgroundStatus().ringConnection.state,'confirmed');
});

test('an asynchronous binding error notifies the existing phone settings refresh path',async()=>{
  const f=fixture();f.values.set('developer.ringConnectionMode','health');f.api.initializeIosRingBackground();const s=f.sessions[0];
  f.settingsChanges.length=0;s.handbackError=new Error('The ring did not acknowledge its glasses setup.');
  s.listeners.state({phase:'connected',status:'Connected'});await tick();
  assert.equal(f.api.iosRingBackgroundStatus().ringConnection.state,'failed');
  assert.ok(f.settingsChanges.includes('ios.ble.session.ringHandback'));
});

test('a failed handback retries on PHONE readiness and coalesces duplicate ready events',async()=>{
  const f=fixture();f.values.set('developer.ringConnectionMode','health');f.api.initializeIosRingBackground();const s=f.sessions[0];
  s.mode='interactive';s.handbackError=new Error('failed: timed out');
  s.listeners.state({phase:'connected',status:'Connected'});await tick();
  assert.equal(f.api.iosRingBackgroundStatus().ringConnection.state,'failed');
  s.handbackError=null;s.listeners.phoneRingReady();s.listeners.phoneRingReady();await tick();
  assert.equal(s.bindings.length,2);assert.equal(f.api.iosRingBackgroundStatus().ringConnection.state,'queued');
  s.listeners.glassesRing({connected:true,ringId:f.addresses.ring});s.listeners.phoneRingReady();await tick();
  assert.equal(s.bindings.length,2);assert.equal(f.api.iosRingBackgroundStatus().ringConnection.state,'confirmed');
});

test('stale or glasses-unready PHONE readiness cannot start a handback',async()=>{
  const f=fixture();f.values.set('developer.ringConnectionMode','health');f.api.initializeIosRingBackground();const old=f.sessions[0];
  const late=old.listeners.phoneRingReady;late();await tick();assert.equal(old.bindings,undefined);
  f.values.set('developer.ringConnectionMode','direct');f.changed();await tick();old.mode='interactive';late();await tick();
  assert.equal(old.bindings,undefined);
});

test('explicit Connect and foreground entry retry failed handback on an already-ready owner',async()=>{
  for(const trigger of ['connect','foreground']) {
    const f=fixture();f.values.set('developer.ringConnectionMode','health');f.api.initializeIosRingBackground();const s=f.sessions[0];
    s.mode='interactive';s.handbackError=new Error('failed: timed out');s.listeners.state({phase:'connected',status:'Connected'});await tick();
    s.handbackError=null;
    if(trigger==='connect')await f.api.ensureIosSession({userInitiated:true});else f.api.resumeIosRingHealth();
    await tick();assert.equal(s.bindings.length,2);assert.equal(f.api.iosRingBackgroundStatus().ringConnection.state,'queued');
  }
});

test('an old failed handback cannot overwrite a newer request after G2 reconnect',async()=>{
  const f=fixture();f.values.set('developer.ringConnectionMode','health');f.api.initializeIosRingBackground();const s=f.sessions[0];let fail;
  s.bindGlassesRing=()=>new Promise((_resolve,reject)=>fail=reject);
  s.listeners.state({phase:'connected',status:'Connected'});await tick();
  s.listeners.state({phase:'disconnected',status:'Disconnected'});
  s.bindGlassesRing=async()=>true;s.listeners.state({phase:'connected',status:'Connected'});await tick();
  assert.equal(f.api.iosRingBackgroundStatus().ringConnection.state,'queued');
  fail(new Error('old request failed'));await tick();
  assert.equal(f.api.iosRingBackgroundStatus().ringConnection.state,'queued');
});

test('a matching negative G2 report allows the next explicit handback without a retry loop',async()=>{
  const f=fixture();f.values.set('developer.ringConnectionMode','health');f.api.initializeIosRingBackground();const s=f.sessions[0];
  s.mode='interactive';s.listeners.state({phase:'connected',status:'Connected'});await tick();
  s.listeners.glassesRing({connected:false,ringId:f.addresses.ring});await tick();
  assert.equal(s.bindings.length,1);assert.equal(f.api.iosRingBackgroundStatus().ringConnection.state,'pending');
  await f.api.ensureIosSession({userInitiated:true});await tick();
  assert.equal(s.bindings.length,2);assert.equal(f.api.iosRingBackgroundStatus().ringConnection.state,'queued');
});

test('handback failures and old-owner confirmation cannot establish current ring controls',async()=>{
  const f=fixture();f.values.set('developer.ringConnectionMode','health');f.api.initializeIosRingBackground();const old=f.sessions[0],late=old.listeners.glassesRing;
  old.handbackError=new Error('The glasses report a different ring');old.listeners.state({phase:'connected',status:'Connected'});await tick();
  assert.equal(f.api.iosRingBackgroundStatus().ringConnection.state,'failed');
  f.values.set('developer.ringConnectionMode','direct');f.changed();await tick();late({connected:true,ringId:f.addresses.ring});
  f.values.set('developer.ringConnectionMode','health');f.changed();await f.api.ensureIosSession();
  assert.equal(f.api.iosRingBackgroundStatus().ringConnection.state,'pending');
});

test('a different pair of glasses cannot inherit persisted confirmation for the same ring',async()=>{
  const f=fixture();f.values.set('developer.ringConnectionMode','health');f.api.initializeIosRingBackground();const s=f.sessions[0];
  s.listeners.glassesRing({connected:true,ringId:f.addresses.ring});
  assert.equal(f.api.iosRingBackgroundStatus().ringConnection.state,'confirmed');
  f.addresses.right='AA:BB:CC:DD:EE:77';f.changed();await tick();
  assert.equal(await f.api.ensureIosSession(),null);
  assert.equal(f.api.iosRingBackgroundStatus().ringConnection.state,'pending');
});

test('a legacy explicit Disconnect survives upgrade and mode edits until Connect',async()=>{
  const f=fixture();f.values.set('ios.ble.session.deviceSet',JSON.stringify([f.addresses,'g2',true]));f.values.set('ios.ble.session.connectionWanted',false);
  f.api.initializeIosRingBackground();assert.equal(f.sessions[0].wanted,false);
  f.values.set('developer.ringConnectionMode','health');f.changed();await tick();assert.equal(await f.api.ensureIosSession(),null);
  assert.equal(await f.api.ensureIosSession({userInitiated:true}),null);
  assert.match(f.api.iosRingBackgroundStatus().ringConnection.message,/Direct/);
});

test('Direct releases its live role before closing or starting PHONE health',async()=>{
  const f=fixture();f.api.initializeIosRingBackground();const old=f.sessions[0];let detach=0,release;
  f.api.claimIosSessionForUi(old,()=>detach++);old.preparation=new Promise(resolve=>release=resolve);
  assert.equal(JSON.parse(f.values.get('ios.ble.session.ringRoleLease')).needsRelease,true);
  f.values.set('developer.ringConnectionMode','health');f.changed();await tick();
  assert.equal(old.closed,undefined);assert.equal(detach,0);assert.equal(f.sessions.length,1);
  release(true);await tick();await f.api.ensureIosSession();
  assert.equal(old.closed,true);assert.equal(detach,1);assert.equal(f.sessions.at(-1).options.ringRole,'phone');
  assert.equal(JSON.parse(f.values.get('ios.ble.session.ringRoleLease')).mode,'health');
});

test('failed Direct release retains its owner and UI, rolls back the same request, and starts no PHONE role',async()=>{
  const f=fixture();f.api.initializeIosRingBackground();const old=f.sessions[0];let detached=false;
  f.api.claimIosSessionForUi(old,()=>detached=true);old.preparation=false;
  f.values.set('developer.ringConnectionMode','health');f.changed();await tick();
  assert.equal(old.closed,undefined);assert.equal(detached,false);assert.equal(f.sessions.length,1);
  assert.equal(f.values.get('developer.ringConnectionMode'),'direct');
  assert.equal(JSON.parse(f.values.get('ios.ble.session.ringRoleLease')).needsRelease,true);
  assert.match(f.api.iosRingBackgroundStatus().ringConnection.message,/could not/);
});

test('a newer mode choice wins over a failed release and never creates the stale PHONE owner',async()=>{
  const f=fixture();f.api.initializeIosRingBackground();const old=f.sessions[0];let release;
  old.preparation=new Promise(resolve=>release=resolve);
  f.values.set('developer.ringConnectionMode','health');f.changed();await tick();
  f.values.set('developer.ringConnectionMode','glasses');f.changed();release(false);await tick();
  assert.equal(f.values.get('developer.ringConnectionMode'),'glasses');
  assert.equal(f.sessions.some(s=>s.options.ringRole==='phone'),false);
});

test('a successful release cannot publish a stale PHONE choice or leave a restarted Direct lease clean',async()=>{
  const f=fixture();f.api.initializeIosRingBackground();const old=f.sessions[0];let release;
  old.preparation=new Promise(resolve=>release=resolve);
  f.values.set('developer.ringConnectionMode','health');f.changed();await tick();
  const stale=f.api.ensureIosSession();
  f.values.set('developer.ringConnectionMode','direct');f.changed();release(true);await tick();
  assert.equal(await stale,null);assert.equal(old.closed,true);
  await f.api.ensureIosSession();assert.equal(f.sessions.at(-1).options.ringRole,'glasses');
  assert.equal(f.sessions.some(s=>s.options.ringRole==='phone'),false);
  assert.equal(JSON.parse(f.values.get('ios.ble.session.ringRoleLease')).needsRelease,true);
});

test('cold health mode cannot treat dirty, missing, or different-ring release evidence as safe',async()=>{
  for(const lease of [undefined,{ringId:'AA:BB:CC:DD:EE:99',needsRelease:false},{ringId:'AA:BB:CC:DD:EE:03',needsRelease:true}]){
    const f=fixture();f.values.set('developer.ringConnectionMode','health');
    if(lease)f.values.set('ios.ble.session.ringRoleLease',JSON.stringify(lease));else f.values.delete('ios.ble.session.ringRoleLease');
    f.api.initializeIosRingBackground();assert.equal(f.sessions.length,0);assert.equal(f.scheduler.enabled,false);
    assert.equal(await f.api.ensureIosSession(),null);assert.equal(f.values.get('developer.ringConnectionMode'),'health');
    assert.match(f.api.iosRingBackgroundStatus().ringConnection.message,/Direct/);
  }
});

test('restarting Direct invalidates previous release evidence before native work resumes',async()=>{
  const f=fixture();f.values.set('developer.ringConnectionMode','health');f.api.initializeIosRingBackground();
  f.values.set('developer.ringConnectionMode','direct');f.changed();await tick();await f.api.ensureIosSession();
  assert.equal(JSON.parse(f.values.get('ios.ble.session.ringRoleLease')).needsRelease,true);
});

test('PHONE health releases its old connection before returning to Direct',async()=>{
  const f=fixture();f.values.set('developer.ringConnectionMode','health');f.api.initializeIosRingBackground();const old=f.sessions[0];let release;
  old.preparation=new Promise(resolve=>release=resolve);
  f.values.set('developer.ringConnectionMode','direct');f.changed();await tick();
  assert.equal(old.closed,undefined);assert.equal(f.sessions.length,1);
  release(true);await tick();await f.api.ensureIosSession();
  assert.equal(old.closed,true);assert.equal(f.sessions.at(-1).options.ringRole,'glasses');
});

test('failed PHONE release preserves Health mode and its existing health authorization',async()=>{
  const f=fixture();f.values.set('developer.ringConnectionMode','health');f.api.initializeIosRingBackground();const old=f.sessions[0];
  old.preparation=false;f.values.set('developer.ringConnectionMode','direct');f.changed();await tick();
  assert.equal(old.closed,undefined);assert.equal(f.sessions.length,1);
  assert.equal(f.values.get('developer.ringConnectionMode'),'health');
  assert.equal(JSON.parse(f.values.get('ios.ble.session.ringRoleLease')).mode,'health');
  assert.match(f.api.iosRingBackgroundStatus().ringConnection.message,/could not/);
});

test('an intermediate Glasses mode cannot bypass PHONE retirement before Direct',async()=>{
  const f=fixture();f.values.set('developer.ringConnectionMode','health');f.api.initializeIosRingBackground();const old=f.sessions[0];let release;
  old.preparation=new Promise(resolve=>release=resolve);
  f.values.set('developer.ringConnectionMode','glasses');f.changed();await tick();
  assert.equal(old.closed,undefined);
  f.values.set('developer.ringConnectionMode','direct');f.changed();release(true);await tick();await f.api.ensureIosSession();
  assert.equal(old.closed,true);assert.equal(old.preparations,1);assert.equal(f.sessions.at(-1).options.ringRole,'glasses');
});

test('explicit Disconnect must settle PHONE retirement before a later Direct connection',async()=>{
  const f=fixture();f.values.set('developer.ringConnectionMode','health');f.api.initializeIosRingBackground();const old=f.sessions[0];let release;
  old.preparation=new Promise(resolve=>release=resolve);
  const stop=f.api.releaseIosSession(old,true);await tick();assert.equal(old.closed,undefined);
  f.values.set('developer.ringConnectionMode','direct');f.changed();release(true);await stop;
  await f.api.ensureIosSession({userInitiated:true});
  assert.equal(old.preparations,1);assert.equal(f.sessions.at(-1).options.ringRole,'glasses');
});

test('a cold Direct restart cannot bypass a previous unresolved PHONE role',async()=>{
  const f=fixture();f.values.set('ios.ble.session.ringRoleLease',JSON.stringify({ringId:f.addresses.ring,mode:'health',needsRelease:true}));
  f.api.initializeIosRingBackground();assert.equal(f.sessions.length,0);assert.equal(f.scheduler.enabled,false);
  assert.equal(await f.api.ensureIosSession(),null);assert.match(f.api.iosRingBackgroundStatus().ringConnection.message,/health sync/);
});

test('failed explicit PHONE retirement still closes its owner and blocks Direct while allowing same-role recovery',async()=>{
  const f=fixture();f.values.set('developer.ringConnectionMode','health');f.api.initializeIosRingBackground();const old=f.sessions[0];
  old.preparation=false;await f.api.releaseIosSession(old,true);assert.equal(old.closed,true);
  const lease=JSON.parse(f.values.get('ios.ble.session.ringRoleLease'));assert.equal(lease.mode,'health');assert.equal(lease.needsRelease,true);
  f.values.set('developer.ringConnectionMode','direct');f.changed();assert.equal(await f.api.ensureIosSession({userInitiated:true}),null);
  f.values.set('developer.ringConnectionMode','health');f.changed();const recovered=await f.api.ensureIosSession();
  assert.notEqual(recovered,old);assert.equal(recovered.options.ringRole,'phone');
});

test('mode changes during discovery cancel the old request instead of mixing roles',async()=>{
  const f=fixture();f.values.delete(`ios.ble.peripheral.${f.addresses.right}`);f.api.initializeIosRingBackground();
  const pending=f.api.ensureIosSession({allowScan:true});await tick();
  f.values.set('developer.ringConnectionMode','glasses');f.changed();f.resolveScan();
  assert.equal(await pending,null);assert.equal(f.sessions.length,0);
});
