const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

function bridge(native, options = {}) {
  class NSObject { static new() { return new this(); } }
  const load = loader({
    NSObject, NativeClass: () => cls => cls, setTimeout, clearTimeout,
    FaceclawKitIosGlassesSession: { alloc: () => ({ initWithRightAddressLeftAddressRingAddress: () => native }) },
    FaceclawKitFaceclawBleCommunicatorListener: {}, FaceclawKitIosAncsListener: {}, FaceclawKitIosAudioPacketListener: {},
    FaceclawKitFaceclawCompassListener: {}, FaceclawKitFaceclawImuListener: {}, FaceclawKitIosAmbientLightListener: {},
    FaceclawKitIosMicStatusListener: {},
  }, {
    '@nativescript/core': { File: {}, knownFolders: {}, path: {} },
    '../g2/firmware-compat': { REQUIRED_FACECLAW_FIRMWARE_VERSION: 37 },
    './kotlin-data': { toData: bytes => bytes, fromData: data => data },
    './ios-graphics': { previewPixels() {} },
    './ios-bluetooth': { iosBluetooth: {} },
  });
  const { FaceclawCommunicatorBridge } = load('app/native/faceclaw-communicator.ios.ts');
  return new FaceclawCommunicatorBridge({ right: 'r', left: 'l', ...options });
}

test('iOS bridge binds original ring identity before start and forwards pull completion once', async () => {
  let listener, identity;
  const native = {
    setRequiredFirmwareRevisionRevision() {}, setPreviewAnimationListenerListener() {},
    setRingHealthIdentityRingId: value => { identity = value; },
    setListenerListener: value => { listener = value; },
    takeRingHealthBatchJson: () => JSON.stringify({ ringId: identity, watermark: 9, records: [] }),
  };
  const api = bridge(native, { ring: 'UUID-R1', healthRingId: 'AA:BB:CC:DD:EE:FF' });
  assert.equal(identity, 'AA:BB:CC:DD:EE:FF');
  assert.equal(api.takeRingHealthBatch().ringId, identity);
  const received = [];
  const off = api.onRingHealthPullFinished(value => received.push(value));
  listener.onRingHealthPullFinishedCompletedPagesWatermark(false, 2, 9);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(JSON.parse(JSON.stringify(received)), [{ completed: false, pages: 2, watermark: 9 }]);
  off();
  listener.onRingHealthPullFinishedCompletedPagesWatermark(true, 0, 9);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(received.length, 1);
});

test('iOS communicator forwards the read-only ring status when the native framework supports it', () => {
  const native = {
    setRequiredFirmwareRevisionRevision() {}, setListenerListener() {}, setPreviewAnimationListenerListener() {},
    getRingStatus: () => '{"directRole":"glasses"}',
  };
  assert.equal(bridge(native).getRingStatus(), '{"directRole":"glasses"}');
  delete native.getRingStatus;
  assert.equal(bridge(native).getRingStatus(), null);
});

test('iOS glasses ring handback uses the configured MAC and never treats queueing as connection proof',async()=>{
  const calls=[];let listener,ready=false,reported='';
  const native={setRequiredFirmwareRevisionRevision(){},setListenerListener:value=>listener=value,setPreviewAnimationListenerListener(){},
    isSessionReady:()=>ready,getRingStatus:()=>JSON.stringify({glassesRingMac:reported}),
    setGlassesRingLinkActionFallbackAddressFallbackName:(...args)=>{calls.push(args);return true;},close(){}};
  const api=bridge(native),observed=[];
  api.onGlassesRingConnectionState(value=>observed.push(value));
  assert.equal(await api.connectGlassesRing('AA:BB:CC:DD:EE:FF',()=>true),false);
  ready=true;
  await assert.rejects(api.connectGlassesRing('00000000-0000-0000-0000-000000000001',()=>true),/MAC/);
  assert.equal(await api.connectGlassesRing('aa:bb:cc:dd:ee:ff',()=>true),true);
  assert.deepEqual(calls,[['connect','AA:BB:CC:DD:EE:FF','EVEN R1_DDEEFF']]);
  assert.equal(observed.length,0);
  reported='112233445566';
  await assert.rejects(api.connectGlassesRing('AA:BB:CC:DD:EE:FF',()=>true),/different ring/);
  assert.equal(calls.length,1);
  listener.onGlassesRingConnectionStateConnectedRingId(true,'AA:BB:CC:DD:EE:FF');
  await new Promise(resolve=>setTimeout(resolve,5));
  assert.deepEqual(JSON.parse(JSON.stringify(observed)),[{connected:true,ringId:'AA:BB:CC:DD:EE:FF'}]);
  await api.close();listener.onGlassesRingConnectionStateConnectedRingId(false,'AA:BB:CC:DD:EE:FF');
  await new Promise(resolve=>setTimeout(resolve,5));assert.equal(observed.length,1);
});

test('a queued handback rechecks its owning mode and connection intent before mutation',async()=>{
  const writes=[];
  const native={setRequiredFirmwareRevisionRevision(){},setListenerListener(){},setPreviewAnimationListenerListener(){},
    isSessionReady:()=>true,getRingStatus:()=>'{"glassesRingMac":""}',
    setGlassesRingLinkActionFallbackAddressFallbackName:(...args)=>{writes.push(args);return true;}};
  const api=bridge(native);let wanted=true;
  const queued=api.connectGlassesRing('AA:BB:CC:DD:EE:FF',()=>wanted);
  wanted=false;
  assert.equal(await queued,false);assert.equal(writes.length,0);
});

test('iOS health binding passes original hardware MACs separately from UUID transport and waits for native acceptance',async()=>{
  const calls=[];let complete;
  const native={setRequiredFirmwareRevisionRevision(){},setListenerListener(){},setPreviewAnimationListenerListener(){},
    isSessionReady:()=>true,getRingStatus:()=>'{"glassesRingMac":""}',
    bindRingToGlassesRightHardwareMacLeftHardwareMacRingHardwareMacRingNameTimeoutMsCompletion:(...args)=>{complete=args.pop();calls.push(args);},
    cancelRingBinding:()=>complete('Ring binding cancelled.')};
  const api=bridge(native,{ring:'00000000-0000-0000-0000-000000000003'});
  const addresses={right:'AA:BB:CC:DD:EE:01',left:'AA:BB:CC:DD:EE:02',ring:'AA:BB:CC:DD:EE:03'};
  const pending=api.bindGlassesRing(addresses,()=>true);await new Promise(resolve=>setTimeout(resolve,5));
  assert.deepEqual(calls,[[addresses.right,addresses.left,addresses.ring,'EVEN R1_DDEE03',15000]]);
  complete('glasses-connect-queued');assert.equal(await pending,true);
  const cancelled=api.bindGlassesRing(addresses,()=>true);await new Promise(resolve=>setTimeout(resolve,5));
  api.cancelGlassesRingBinding();await assert.rejects(cancelled,/cancelled/);
  await assert.rejects(api.bindGlassesRing({...addresses,left:addresses.right},()=>true),/distinct/);
  await assert.rejects(api.bindGlassesRing({...addresses,right:'00000000-0000-0000-0000-000000000001'},()=>true),/MAC/);
  assert.equal(calls.length,2);
});

test('a queued iOS binding rechecks authorization before programming ring targets',async()=>{
  let writes=0,authorized=true;
  const native={setRequiredFirmwareRevisionRevision(){},setListenerListener(){},setPreviewAnimationListenerListener(){},
    isSessionReady:()=>true,getRingStatus:()=>'{"glassesRingMac":""}',
    bindRingToGlassesRightHardwareMacLeftHardwareMacRingHardwareMacRingNameTimeoutMsCompletion:()=>writes++};
  const api=bridge(native),pending=api.bindGlassesRing({right:'AA:BB:CC:DD:EE:01',left:'AA:BB:CC:DD:EE:02',ring:'AA:BB:CC:DD:EE:03'},()=>authorized);
  authorized=false;assert.equal(await pending,false);assert.equal(writes,0);
});

test('role release uses the bounded native acknowledgement and rechecks queued authorization',async()=>{
  const calls=[];
  const native={setRequiredFirmwareRevisionRevision(){},setListenerListener(){},setPreviewAnimationListenerListener(){},
    prepareForRingRoleChangeTimeoutMsCompletion:(value,done)=>{calls.push(value);setTimeout(()=>done({boolValue:true}),0);}};
  const api=bridge(native);let authorized=true;
  const stale=api.prepareForRingRoleChange(12000,()=>authorized);authorized=false;
  assert.equal(await stale,false);assert.deepEqual(calls,[]);
  assert.equal(await api.prepareForRingRoleChange(12000,()=>true),true);assert.deepEqual(calls,[12000]);
  native.prepareForRingRoleChangeTimeoutMsCompletion=(_value,done)=>done({boolValue:false});
  assert.equal(await api.prepareForRingRoleChange(12000,()=>true),false);
  delete native.prepareForRingRoleChangeTimeoutMsCompletion;
  assert.equal(await api.prepareForRingRoleChange(12000,()=>true),false);
});

test('iOS ring-only policy is passed before start and health readiness stays distinct from glasses readiness', () => {
  const policy = [];
  const native = {
    setRequiredFirmwareRevisionRevision() {}, setListenerListener() {}, setPreviewAnimationListenerListener() {},
    setIndependentRingHealthEnabledEnabled: value => policy.push(value),
    canSyncRingHealth: () => true, isSessionReady: () => false,
  };
  const api = bridge(native, { ring: 'UUID-R1', independentRingHealth: true });
  assert.deepEqual(policy, [true]);
  assert.equal(api.canSyncRingHealth(), true);
  assert.equal(api.isSessionReady(), false);
  api.setIndependentRingHealthEnabled(false);
  assert.deepEqual(policy, [true, false]);
});

test('iOS background bridge correlates generations, replays restoration and closes stale callbacks',async()=>{
  const calls=[];let listener;
  const native={setRequiredFirmwareRevisionRevision(){},setListenerListener:value=>listener=value,setPreviewAnimationListenerListener(){},
    setConnectionWantedWanted:value=>calls.push(['wanted',value]),configureStateRestorationEnabled:value=>calls.push(['restore',value]),
    startHealthOnly:()=>{calls.push(['health-only']);return true;},promoteToInteractive:()=>calls.push(['promote']),
    requestBackgroundRingHealthGenerationTimeoutMs:(id,budget)=>{calls.push(['request',id,budget]);return true;},
    cancelBackgroundRingHealthGeneration:id=>{calls.push(['cancel',id]);return true;},close(){}};
  const api=bridge(native),results=[],restores=[];
  api.setConnectionWanted(true);api.configureStateRestoration(true);assert.equal(api.startHealthOnly(),true);
  api.onBackgroundRingHealthFinished(value=>results.push(value));
  assert.equal(api.requestBackgroundRingHealth(7,25000),true);
  listener.onBackgroundRingHealthFinishedGenerationOutcomePagesWatermark(7,'completed',2,9);
  listener.onSessionRestoredRestoredPeers(1);api.onSessionRestored(value=>restores.push(value));
  await new Promise(resolve=>setTimeout(resolve,5));
  assert.deepEqual(JSON.parse(JSON.stringify(results)),[{generation:7,outcome:'completed',pages:2,watermark:9}]);
  assert.deepEqual(restores,[1]);api.cancelBackgroundRingHealth(7);await api.promoteToInteractive();
  await api.close();listener.onSessionRestoredRestoredPeers(2);
  listener.onBackgroundRingHealthFinishedGenerationOutcomePagesWatermark(8,'cancelled',0,9);
  await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(results.length,1);assert.deepEqual(restores,[1]);
  assert.deepEqual(calls,[['wanted',true],['restore',true],['health-only'],['request',7,25000],['cancel',7],['promote']]);
});

test('iOS health snapshot preserves its watermark and only consumes when explicitly requested', () => {
  const consumed = [], requested = [];
  const native = {
    setRequiredFirmwareRevisionRevision() {}, setListenerListener() {}, setPreviewAnimationListenerListener() {},
    takeRingHealthBatchJson: () => JSON.stringify({ watermark: 7, records: [{ cmdHi: 1, anchorUnixSeconds: 123 }] }),
    clearRingHealthRecordsBelowWatermark: watermark => { consumed.push(watermark); return 1; },
    requestRingHealthNow: () => requested.push(true),
  };
  const api = bridge(native);
  const batch = api.takeRingHealthBatch();
  assert.equal(batch.watermark, 7);
  assert.equal(batch.records[0].anchorUnixSeconds, 123);
  assert.deepEqual(consumed, []);
  assert.deepEqual(requested, []);
  assert.equal(api.clearRingHealthRecordsBelow(batch.watermark), 1);
  assert.deepEqual(consumed, [7]);
  api.requestRingHealthNow();
  assert.deepEqual(requested, [true]);
});

test('explicit R1 fresh start resolves only from the matching native terminal result', async () => {
  let requested = 0;
  const native = {
    setRequiredFirmwareRevisionRevision() {}, setListenerListener() {}, setPreviewAnimationListenerListener() {},
    isSessionReady: () => true,
    requestRingHealthStartFresh: () => { requested++; return 12; },
    getRingStatus: () => JSON.stringify({ freshStartGeneration: 12, freshStartState: 'succeeded',
      freshStartResult: 'recording enabled; clock acknowledged' }),
  };
  const result = await bridge(native).startRingHealthRecordingNow();
  assert.equal(requested, 1);
  assert.equal(result, 'recording enabled; clock acknowledged');
});

test('explicit R1 fresh start rejects a verified native failure', async () => {
  const native = {
    setRequiredFirmwareRevisionRevision() {}, setListenerListener() {}, setPreviewAnimationListenerListener() {},
    isSessionReady: () => true,
    requestRingHealthStartFresh: () => 13,
    getRingStatus: () => JSON.stringify({ freshStartGeneration: 13, freshStartState: 'failed',
      freshStartResult: 'R1 did not acknowledge the UTC clock update' }),
  };
  await assert.rejects(bridge(native).startRingHealthRecordingNow(), /did not acknowledge the UTC clock update/);
});

test('iOS ring status reads the active bridge but every command helper remains inert', () => {
  const calls = [];
  const active = {
    getRingStatus: () => '{"directRole":"glasses","lastGlassesReport":"connected"}',
    setGlassesRingLink: () => { calls.push('glasses'); return true; },
    sendRingConfigCommand: () => { calls.push('ring'); return 'sent'; },
  };
  const api = loader({ global: { isIOS: true, isAndroid: false } }, {
    '@nativescript/core': { Utils: {} },
    './faceclaw-communicator.ios': { FaceclawCommunicatorBridge: { getActive: () => active } },
  })('app/native/ring-status.ts');

  assert.equal(api.getRingSessionStatus().directRole, 'glasses');
  assert.equal(api.getRingSystemBluetoothState('AA:BB'), null);
  assert.equal(api.setGlassesRingLink('unpair', 'AA:BB', 'R1'), false);
  assert.match(api.sendRingConfigCommand('remove-ring', 'AA:BB', 'R1'), /not sent/i);
  assert.deepEqual(calls, []);
});

test('iOS Ring status renders session diagnostics without Android or mutating controls', () => {
  const texts = [], calls = [], pushes = [];
  let pops = 0, viewportHeight = 288;
  let currentStatus;
  const status = {
    directEnabled: true, ringAddress: 'AA:BB', glassesConnected: true, sessionReady: true,
    directConnected: true, directNotificationsReady: true, directConnectCount: 1, directStateAgeMs: 1000,
    directBattery: 80, lastDirectNotifyAgeMs: 2000, lastDirectInputAgeMs: 3000, lastDirectInput: 'tap',
    glassesRingBattery: 70, glassesRingBatteryAgeMs: 4000, lastGlassesInputAgeMs: 5000, lastGlassesInput: 'scroll',
    lastDirectError: 'latest error', glassesRingMac: 'AABB', glassesRingName: 'R1', lastGlassesReport: 'connected',
    lastGlassesReportAgeMs: 6000, lastCommand: '', lastCommandAgeMs: -1, lastCommandResultR: '', lastCommandResultL: '',
    directRole: 'glasses', healthWindowActive: false, lastHealthPull: '', lastHealthPullAgeMs: -1, heldHealthRecords: 0,
    directGlassesAuth: 'accepted', directGlassesAuthAgeMs: 7000, lastRingCommand: '', lastRingCommandAgeMs: -1,
    lastRingCommandResult: '', lastDirectRaw: '', lastDirectRawAgeMs: -1,
  };
  currentStatus = status;
  class GrayImage {
    drawText(_font, _x, _y, text) { texts.push(text); }
    fillRoundedRect() {}
    drawRoundedRect() {}
  }
  const { RingStatusLayer } = loader({
    global: { isIOS: true, isAndroid: false },
    setInterval: () => 1, clearInterval() {},
  }, {
    '../../graphics/ui-fonts': { getDefaultSmallFont: () => ({ lineHeight: 12, measureText: text => text.length * 6 }) },
    '../../graphics/image': { GrayImage },
    '../../ui/shell/shell': { shell: { isWindowVisible: () => true } },
    '../../ui/menu': { MenuLayer: class {} },
    '../../ui/dashboard-settings': {
      effectiveRingConnectionMode: () => 'direct',
      ringConnectionModeSetting: { get: () => 'direct', next: () => 'glasses', set: () => calls.push('mode'), displayValue: String },
    },
    '../../g2/device-addresses': { loadDeviceAddresses: () => ({ ring: 'AA:BB' }) },
    '../../native/ring-status': {
      getRingSessionStatus: () => currentStatus,
      getRingSystemBluetoothState: () => { calls.push('system'); return {}; },
      sendRingConfigCommand: () => { calls.push('ring'); return 'sent'; },
      setGlassesRingLink: () => { calls.push('glasses'); return true; },
    },
  })('app/apps/developer/ring-status.ts');
  const layer = new RingStatusLayer('developer', () => {});
  const stack = { getBaseSize: () => ({ width: 576, height: viewportHeight }), push: value => pushes.push(value), pop: () => { pops++; } };

  layer.paint({ stack });
  layer.handleInput({ type: 'click' }, { stack });
  assert.ok(texts.includes('Ring status'));
  assert.ok(texts.includes('connected (6s ago)'));
  assert.ok(texts.some(text => text.includes('role glasses')));
  assert.ok(texts.some(text => text.includes('ago: tap')));
  assert.ok(texts.some(text => text.includes('ago: scroll')));
  assert.ok(!texts.includes('Phone BT'));
  assert.ok(texts.includes('Health sync'));
  assert.ok(!texts.includes('Glasses...'));
  assert.ok(!texts.includes('Ring...'));
  assert.ok(!texts.some(text => text.startsWith('Mode:')));
  assert.deepEqual(calls, []);
  assert.deepEqual(pushes, []);

  viewportHeight = 96;
  texts.length = 0;
  layer.paint({ stack });
  assert.ok(!texts.includes('latest error'));
  for (let i = 0; i < 20; i++) layer.handleInput({ type: 'scroll-down' }, { stack });
  texts.length = 0;
  layer.paint({ stack });
  assert.ok(texts.includes('latest error'));
  layer.handleInput({ type: 'double-click' }, { stack });
  assert.equal(pops, 1);
  assert.deepEqual(calls, []);

  currentStatus = null;
  texts.length = 0;
  new RingStatusLayer('developer', () => {}).paint({ stack });
  assert.ok(texts.includes('status unavailable'));
});

test('iOS Developer exposes the read-only Ring status page', () => {
  class MenuLayer {
    constructor(title, items) { this.title = title; this.items = items; }
  }
  class RingStatusLayer {}
  class EmptyLayer {}
  class YieldAtRootLayer { constructor(layer) { this.layer = layer; } }
  let windowOptions;
  const { createDeveloperAppWindow } = loader({ global: { isIOS: true } }, {
    '../../ui/menu': { MenuLayer, submenuItem: (label, onSelect, options = {}) => ({ ...options, label, onSelect }) },
    './screen-test': { ScreenTestLayer: EmptyLayer },
    './input-events': { InputEventsLayer: EmptyLayer },
    '../../ui/shell/shell': { shell: { isWindowVisible: () => true } },
    './buzzer-demo': { BuzzerDemoLayer: EmptyLayer },
    './accelerometer-demo': { AccelerometerDemoLayer: EmptyLayer },
    './bandwidth-benchmark': { BandwidthBenchmarkLayer: EmptyLayer },
    './light-sensor-demo': { LightSensorDemoLayer: EmptyLayer },
    './microphones-monitor': { MicrophonesMonitorLayer: EmptyLayer },
    './resource-usage': { ResourceUsageLayer: EmptyLayer },
    './ring-status': { RingStatusLayer },
    './load-app': { LoadAppFromQrLayer: EmptyLayer, LoadAppFromUrlLayer: EmptyLayer },
    './unicode-test': { unicodeTestMenu: () => new EmptyLayer() },
    '../../ui/shell/geometry': { appViewportSize: () => ({ height: 288 }) },
    '../../ui/shell/in-process-window': {
      YieldAtRootLayer,
      createInProcessWindow: options => { windowOptions = options; return { stack: { receiveTextInput: () => false } }; },
    },
  })('app/apps/developer/developer-app.ts');
  createDeveloperAppWindow({}, { actions: {}, submitFrame() {}, setSurfaceVisible() {}, removeSurface() {}, onClosed() {} });

  const pushed = [];
  const debug = windowOptions.baseLayer.layer.items.find(item => item.label === 'Debug tests');
  debug.onSelect({ stack: { push: layer => pushed.push(layer) }, actions: { requestRender() {} } });
  const ring = pushed[0].items.find(item => item.label === 'Ring status');
  assert.equal(ring.disabled, undefined);
  ring.onSelect({ stack: { push: layer => pushed.push(layer) }, actions: { requestRender() {} } });
  assert.ok(pushed[1] instanceof RingStatusLayer);
});
