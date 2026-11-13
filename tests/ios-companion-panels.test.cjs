const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const path = require('node:path');
const healthExport = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../app/health/healthkit-export.ts'), 'utf8'),
  {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,
  {module:healthExport,exports:healthExport.exports,require});

function harness() {
  const calls = [], views = [];
  class View {
    constructor() { this.children = []; this.events = {}; views.push(this); }
    addChild(view) { this.children.push(view); }
    removeChildren() { this.children = []; }
    getChildAt(i) { return this.children[i]; }
    getChildrenCount() { return this.children.length; }
    on(name, action) { this.events[name] = action; }
    static setColumn() {}
  }
  class StringSetting {
    constructor() { this.label = 'Private endpoint key'; this.editorTitle = this.label; this.inputKind = 'password'; this.value = 'private-test-value'; }
    get() { return this.value; }
    set(value) { this.value = value; calls.push(['set', value]); }
    validationError(value) { return value === 'invalid' ? 'Invalid value' : null; }
  }
  class EnumSetting {
    constructor() { this.label = 'Mode'; this.values = ['one', 'two', 'blocked']; this.value = 'one'; this.blocked = new Set(['blocked']); }
    get() { return this.value; }
    set(value) { this.value = value; calls.push(['set', value]); }
    displayValue(value = this.value) { return value; }
    isDisabled(value) { return this.blocked.has(value); }
  }
  class BooleanSetting extends EnumSetting {
    constructor() { super(); this.value = true; }
    displayValue() { return this.value ? 'On' : 'Off'; }
    toggle() { this.value = !this.value; calls.push(['toggle']); }
  }
  const ringControlsOnlyWhileWornSetting = new BooleanSetting();
  ringControlsOnlyWhileWornSetting.label = 'Ring controls only while glasses are worn';
  const ringConnectionModeSetting = new EnumSetting();
  ringConnectionModeSetting.label = 'ringConnectionModeSetting';
  ringConnectionModeSetting.values = ['glasses', 'health', 'direct'];
  ringConnectionModeSetting.value = 'health';
  ringConnectionModeSetting.displayValue = value => value === 'direct' ? 'Direct to phone' : value === 'health' ? 'Via glasses + health sync' : 'Only via glasses';
  const timeFormatSetting = new EnumSetting();
  timeFormatSetting.get = () => '12h';
  let glassesType = 'g2';
  const exported = { __esModule: true, ConfigSettingString: StringSetting, ConfigSettingEnum: EnumSetting, ConfigSettingBoolean: BooleanSetting,
    ringConnectionModeSetting, ringControlsOnlyWhileWornSetting, timeFormatSetting,
    effectiveRingConnectionMode: () => glassesType === 'g2' ? ringConnectionModeSetting.get() : 'direct' };
  const settings = new Proxy(exported, { get(target, key) {
    if (key in target) return target[key];
    if (typeof key === 'string' && key.endsWith('Setting')) {
      const value = /Key|Url|Language|ModelSetting/.test(key) ? new StringSetting() : new EnumSetting();
      value.label = key; target[key] = value; return value;
    }
  } });
  const canonicalSettings = [
    settings.brightnessSetting, settings.autoBrightnessMinSetting, settings.autoBrightnessMaxSetting,
    settings.autoBrightnessCurveSetting, settings.ringConnectionModeSetting, settings.uiDepthSetting,
    settings.batteryDisplayModeSetting, settings.phoneBatteryVisibilitySetting, settings.menuAnimationSetting,
    settings.newNotificationDisplaySetting, settings.wakeWordActionSetting, settings.saveTranscribeAudioSetting,
    settings.assistantBackendSetting, settings.assistantModelSetting, settings.assistantOpenAiCompatibleUrlSetting,
    settings.remoteInputSetting, settings.mapboxApiKeySetting, settings.phoneRotationSetting,
    settings.watchRemoteEnabledSetting, settings.showBleBandwidthSetting, settings.dataCollectionSetting,
  ];
  const phoneItem = setting => ({ label: setting.label, description: setting.description, onSelect() {},
    phone: { kind: 'setting', setting } });
  const phoneSections = () => [
    { label: 'Canonical settings', items: canonicalSettings.filter(setting => setting !== settings.ringConnectionModeSetting).map(phoneItem) },
    { label: 'Developer', items: [phoneItem(settings.ringConnectionModeSetting)] },
  ];
  let fixture = true, live = false, samples = [], readings = [], sleep = [], available = false, automatic = false, resolveRead, readSignal, ringMessage = '';
  const dialogs = { action: async () => 'Cancel', prompt: async () => ({result:false,text:''}), confirm: async () => false,
    alert: async value => calls.push(['alert',value.title]), inputType:{password:'password',text:'text',email:'email'} };
  const pullListeners = [];
  let sessionReady = true, ringOnlyHealthReady = false;
  const ringBridge = {
    isSessionReady: () => sessionReady,
    canSyncRingHealth: () => sessionReady || ringOnlyHealthReady,
    requestRingHealthNow: () => calls.push(['request-ring-health']),
    startRingHealthRecordingNow: async () => { calls.push(['fresh-start']); return 'recording enabled; clock acknowledged' },
    onRingHealthPullFinished(listener) { pullListeners.push(listener); return () => { const index=pullListeners.indexOf(listener); if(index>=0) pullListeners.splice(index,1); }; },
  };
  let activeBridge = ringBridge;
  const modules = {
    '@nativescript/core': {Button:View,Dialogs:dialogs,GridLayout:View,Image:View,ImageSource:{fromSystemImageSync:value=>value},Label:View,ScrollView:View,StackLayout:View},
    '../ui/dashboard-settings':settings,
    '../ui/dashboard/settings-menus':{phoneSettingsSections:phoneSections},
    './phone-settings-actions.ios':{cancelPhoneSettingsActions(){},runPhoneSettingsAction:async()=>false,phoneSettingsValue:()=>''},
    '../ui/shell/shell':{shell:{noteUserActivity:()=>calls.push(['activity']), getAssistantHealthDestination:()=>null}},
    '../native/apple-health': { isAppleHealthAvailable: () => available,
      requestAppleHealthAccess: async () => { calls.push(['health-permission']); return {requestCompleted:true} },
      writeR1HealthSamples: async records => { calls.push(['write-health',records.length]);return {submittedCount:records.length} },
      readAppleHealthSummary: (day, signal) => { calls.push(['health-query',day]);readSignal=signal;return new Promise(resolve=>{resolveRead=resolve}) } },
    '../native/faceclaw-communicator.ios': { FaceclawCommunicatorBridge: { getActive: () => activeBridge } },
    '../native/settings-store': { getBooleanSetting: () => false, setBooleanSetting: () => calls.push(['permission-completed']) },
    '../assistant/health-access': { isHealthSharingAllowed: () => false },
    '../health/healthkit-export': healthExport.exports,
    '../health/healthkit-sync.ios': { isAutomaticR1HealthSyncEnabled: () => automatic,
      setAutomaticR1HealthSyncEnabled: value => { automatic = value; calls.push(['automatic', value]); },
      syncAutomaticR1Health: async () => calls.push(['automatic-drain']) },
    '../health/ring-session.ios': { iosRingBackgroundStatus: () => ({ scheduler: { availability: 'available' }, ringConnection: { message: ringMessage } }) },
    '../health/health-live': { requestFreshPull: () => { if (activeBridge) { calls.push(['ring-pull']); activeBridge.requestRingHealthNow(); } } },
    '../apps/all-apps':{ALL_APPS:[]},
    '../apps/launcher':{launcherEntries:()=>[{appId:'evenhub-installed:g2c',label:'G2C'},{appId:'weather',label:'Weather'}]},
    '../health/health-seed':{isFixtureData:()=>fixture,hasLiveData:()=>live},
    '../health/health-store-files':{healthStore:()=>({samplesInRange:()=>{calls.push(['read-health']);return samples},readingsInRange:()=>readings,sleepSessions:()=>sleep})},
    '../health/health-types':{startOfLocalDay:()=>0},
    '../health/health-derive':{nextBucketStart:()=>86400000,dailySummary:require('../.test-build/app/health/health-derive.js').dailySummary},
    '../version':{FACECLAW_VERSION:'0.9.0'},
  };
  const sandbox = {exports:{},require:id=>{assert.ok(modules[id],id);return modules[id]},
    UIFontTextStyleBody:'body',UIFontTextStyleSubheadline:'subheadline',UIFontTextStyleHeadline:'headline',UIFontTextStyleLargeTitle:'largeTitle',UIFontTextStyleFootnote:'footnote',
    UIImage:{systemImageNamed:value=>value},Date};
  const source=fs.readFileSync(path.join(__dirname,'../app/phone-ui/companion-panels.ios.ts'),'utf8');
  vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,sandbox);
  return {...sandbox.exports,calls,views,dialogs,StringSetting,EnumSetting,setFixture:value=>fixture=value,setLive:value=>live=value,setSamples:value=>samples=value,
    setReadings:value=>readings=value,setSleep:value=>sleep=value,setAvailable:value=>available=value,setBridge:value=>activeBridge=value,
    setSessionReady:value=>sessionReady=value,setRingOnlyHealthReady:value=>ringOnlyHealthReady=value,bridge:ringBridge,
    setRingMessage:value=>ringMessage=value,setRingMode:value=>ringConnectionModeSetting.value=value,
    setGlassesType:value=>glassesType=value,ringSavedMode:()=>ringConnectionModeSetting.get(),
    pullCallbacks:()=>pullListeners.slice(),finishPull:value=>pullListeners.slice().forEach(listener=>listener(value)),finishRead:value=>resolveRead(value),readSignal:()=>readSignal};
}

function panelText(view) {
  return [view.text||'',...(view.children||[]).map(panelText),view.content?panelText(view.content):''].join('\n');
}

function showAdvanced(h) {
  h.views.filter(view=>view.accessibilityLabel==='Advanced health details, Show').at(-1).events.tap();
}

test('companion settings exclude disabled values and recheck availability after selection',async()=>{
  const h=harness(), setting=new h.EnumSetting();
  h.dialogs.action=async options=>{assert.deepEqual([...options.actions],['one','two']);setting.blocked.add('two');return 'two';};
  assert.equal(await h.editCompanionSetting(setting),false);
  assert.equal(setting.value,'one');
  assert.deepEqual(h.calls,[]);
});

test('automatic Apple Health sync needs explicit consent and stale confirmations cannot enable it',async()=>{
  const h=harness();h.setAvailable(true);
  const panels=h.createCompanionPanels({launchApp:async()=>{},openDevices:async()=>{},openPermissions(){},openAdvanced(){}});
  panels.refresh();
  const action=()=>h.views.filter(view=>view.accessibilityLabel==='Automatic Apple Health sync, Off').at(-1);
  assert.ok(action());
  action().events.tap();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.calls.some(call=>call[0]==='automatic'),false);
  let resolve;
  h.dialogs.confirm=()=>new Promise(done=>{resolve=done});
  action().events.tap();await Promise.resolve();panels.clearHealth();resolve(true);
  await new Promise(done=>setImmediate(done));
  assert.equal(h.calls.some(call=>call[0]==='automatic'),false);
  panels.refresh();h.dialogs.confirm=async()=>true;
  action().events.tap();await new Promise(done=>setImmediate(done));
  assert.deepEqual(h.calls.filter(call=>['automatic','automatic-drain','ring-pull'].includes(call[0])),
    [['automatic',true],['automatic-drain'],['ring-pull']]);
});

test('cancelled and invalid text edits preserve saved configuration; valid edits use existing setter',async()=>{
  const h=harness(), setting=new h.StringSetting();
  assert.equal(await h.editCompanionSetting(setting),false);
  h.dialogs.prompt=async options=>{assert.equal(options.inputType,'password');return {result:true,text:'invalid'};};
  assert.equal(await h.editCompanionSetting(setting),false);
  assert.equal(setting.value,'private-test-value');
  h.dialogs.prompt=async()=>({result:true,text:'replacement'});
  assert.equal(await h.editCompanionSetting(setting),true);
  assert.equal(setting.value,'replacement');
  assert.deepEqual(h.calls,[['alert','Check this value'],['set','replacement'],['activity']]);
});

test('companion Settings exposes the worn-only ring control and toggles it in place',async()=>{
  const h=harness();
  const panels=h.createCompanionPanels({launchApp:async()=>{},openDevices:async()=>{},openPermissions(){},openAdvanced(){}});
  const row=h.views.find(view=>view.accessibilityLabel==='Ring controls only while glasses are worn, On');
  assert.ok(row);
  row.events.tap(); await new Promise(resolve=>setImmediate(resolve));
  assert.equal(row.accessibilityLabel,'Ring controls only while glasses are worn, Off');
  assert.deepEqual(h.calls,[['toggle'],['activity']]);
  panels.refresh();
  assert.equal(row.accessibilityLabel,'Ring controls only while glasses are worn, Off');
});

test('companion Settings renders the canonical iOS catalog with the same editable setting objects',async()=>{
  const h=harness();
  h.createCompanionPanels({launchApp:async()=>{},openDevices:async()=>{},openPermissions(){},openAdvanced(){}});
  for (const label of ['autoBrightnessMinSetting','autoBrightnessMaxSetting','autoBrightnessCurveSetting',
    'ringConnectionModeSetting','uiDepthSetting','batteryDisplayModeSetting','phoneBatteryVisibilitySetting',
    'menuAnimationSetting','newNotificationDisplaySetting','wakeWordActionSetting','saveTranscribeAudioSetting',
    'assistantBackendSetting','assistantModelSetting','assistantOpenAiCompatibleUrlSetting','remoteInputSetting',
    'mapboxApiKeySetting','phoneRotationSetting','watchRemoteEnabledSetting','showBleBandwidthSetting','dataCollectionSetting']) {
    assert.ok(h.views.some(view=>view.accessibilityLabel?.startsWith(`${label},`)),label);
  }
  const row=h.views.find(view=>view.accessibilityLabel?.startsWith('autoBrightnessMinSetting,'));
  h.dialogs.action=async()=> 'two'; row.events.tap(); await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(h.calls.slice(-2),[['set','two'],['activity']]);
});

test('Ring connection uses its canonical row exactly once inside the phone Ring group',async()=>{
  const h=harness();
  const panels=h.createCompanionPanels({launchApp:async()=>{},openDevices:async()=>{},openPermissions(){},openAdvanced(){}});
  const content=panels.settings.content;
  const sectionRows=title=>content.children[content.children.findIndex(view=>view.text===title)+1];
  const ringRows=sectionRows('Ring'), developerRows=sectionRows('Developer');
  assert.ok(ringRows.children.some(view=>view.accessibilityLabel?.startsWith('ringConnectionModeSetting,')));
  assert.equal(developerRows.children.some(view=>view.accessibilityLabel?.startsWith('ringConnectionModeSetting,')),false);
  assert.equal(h.views.filter(view=>view.accessibilityLabel?.startsWith('ringConnectionModeSetting,')).length,1);
  h.dialogs.action=async()=> 'Direct to phone';
  ringRows.children.find(view=>view.accessibilityLabel?.startsWith('ringConnectionModeSetting,')).events.tap();
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(h.calls.slice(-2),[['set','direct'],['activity']]);
});

test('Ring group explains the selected route without contradicting the other modes',()=>{
  const cases = [
    ['glasses', /R1 controls go through the glasses\. Pilot does not connect to R1 for health\./,
      /separate R1-to-iPhone link|iPhone handles R1 controls and health/],
    ['health', /R1 controls go through the glasses\. Health uses a separate R1-to-iPhone link\./,
      /does not connect to R1 for health|iPhone handles R1 controls and health/],
    ['direct', /iPhone handles R1 controls and health\. Health sync may briefly pause controls while R1 changes roles\./,
      /does not connect to R1 for health|Health uses a separate R1-to-iPhone link/],
  ];
  for (const [mode, expected, contradiction] of cases) {
    const h=harness();h.setRingMode(mode);
    const panels=h.createCompanionPanels({launchApp:async()=>{},openDevices:async()=>{},openPermissions(){},openAdvanced(){}});
    const content=panels.settings.content;
    const ringRows=content.children[content.children.findIndex(view=>view.text==='Ring')+1];
    const copy=panelText(ringRows);
    assert.match(copy,expected,mode);
    assert.doesNotMatch(copy,contradiction,mode);
    assert.match(copy,/Putting the glasses in their case does not change this mode\./,mode);
    assert.match(copy,/Worn only gates controls/,mode);
    assert.doesNotMatch(copy,/still being verified/,mode);
  }
});

test('Ring explanation uses the effective Direct route on G1 without changing the saved G2 mode',()=>{
  const h=harness();h.setRingMode('health');h.setGlassesType('g1');
  const panels=h.createCompanionPanels({launchApp:async()=>{},openDevices:async()=>{},openPermissions(){},openAdvanced(){}});
  const content=panels.settings.content;
  const ringRows=content.children[content.children.findIndex(view=>view.text==='Ring')+1];
  const copy=panelText(ringRows);
  assert.match(copy,/iPhone handles R1 controls and health/);
  assert.doesNotMatch(copy,/Health uses a separate R1-to-iPhone link/);
  assert.equal(h.ringSavedMode(),'health');
});

test('Ring group shows only the current safe-transition message and clears it on refresh',()=>{
  const h=harness();h.setRingMessage('Connect in Direct mode first, then choose health sync.');
  const panels=h.createCompanionPanels({launchApp:async()=>{},openDevices:async()=>{},openPermissions(){},openAdvanced(){}});
  assert.match(panelText(panels.settings),/Connect in Direct mode first/);
  h.setRingMessage('');panels.refresh();
  assert.doesNotMatch(panelText(panels.settings),/Connect in Direct mode first/);
});

test('companion panels show a simple empty Today state without fixture language or repeated missing rows',async()=>{
  const h=harness();
  const panels=h.createCompanionPanels({launchApp:async id=>h.calls.push(['launch',id]),openDevices:async()=>{},openPermissions(){},openAdvanced(){}});
  panels.refresh();
  const text=h.views.map(view=>view.text||'').join('\n');
  assert.match(text,/No saved readings today/);
  assert.match(text,/Sync now/);
  assert.match(text,/Apple Health is unavailable/);
  assert.doesNotMatch(text,/fixture|sample data|No reading|No saved data/i);
  assert.doesNotMatch(text,/private-test-value/);
  assert.equal(h.calls.length,0,'fixture data is not even read as real health data');
  const g2c=h.views.find(view=>view.accessibilityLabel==='G2C, Open');
  g2c.events.tap(); await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(h.calls,[['launch','evenhub-installed:g2c']]);
  h.setFixture(false);panels.refresh();
  assert.deepEqual(h.calls,[['launch','evenhub-installed:g2c']],'a missing/unreadable fixture marker alone cannot establish live data');
  h.setLive(true);panels.refresh();
  assert.deepEqual(h.calls,[['launch','evenhub-installed:g2c'],['read-health']]);
});

test('verified saved samples render measured values and preserve missing-data labels',()=>{
  const h=harness();h.setFixture(false);h.setLive(true);
  h.setSamples([{metric:'heartRate',startMs:0,spanMs:60000,min:60,max:80,avg:70,total:0}]);
  const panels=h.createCompanionPanels({launchApp:async()=>{},openDevices:async()=>{},openPermissions(){},openAdvanced(){}});
  panels.refresh();
  const text=h.views.map(view=>view.text||'').join('\n');
  assert.match(text,/70 bpm/);
  assert.equal(h.views.find(view=>view.accessibilityLabel==='Steps, No saved data').accessibilityLabel,'Steps, No saved data');
  assert.doesNotMatch(text,/Sample data is never shown/);
  assert.doesNotMatch(text,/R1 RMSSD/);
});

test('Health prefers true latest readings and labels hourly-only values as averages',()=>{
  const h=harness();h.setFixture(false);h.setLive(true);
  h.setSamples([
    {metric:'heartRate',startMs:0,spanMs:3600000,min:60,max:80,avg:70,total:0},
    {metric:'spo2',startMs:0,spanMs:3600000,min:94,max:98,avg:96,total:0},
  ]);
  h.setReadings([
    {metric:'heartRate',startMs:100,spanMs:0,min:72,max:72,avg:72,total:72},
    {metric:'heartRate',startMs:200,spanMs:0,min:78,max:78,avg:78,total:78},
  ]);
  const panels=h.createCompanionPanels({launchApp:async()=>{},openDevices:async()=>{},openPermissions(){},openAdvanced(){}});
  panels.refresh();
  const rendered=panelText(panels.health);
  assert.match(rendered,/Heart rate\s+78 bpm/);
  assert.match(rendered,/Average oxygen\s+96%/);
  assert.match(rendered,/Heart rate .*(AM|PM)/);
  assert.doesNotMatch(rendered,/Average heart rate/);
});

test('Health shows saved steps, active energy and resolved asleep duration without primary raw diagnostics',()=>{
  const h=harness();h.setFixture(false);h.setLive(true);
  h.setSamples([
    {metric:'steps',startMs:0,spanMs:3600000,min:1234,max:1234,avg:1234,total:1234},
    {metric:'activeCalories',startMs:0,spanMs:3600000,min:87,max:87,avg:87,total:87},
    {metric:'calories',startMs:0,spanMs:3600000,min:999,max:999,avg:999,total:999},
  ]);
  h.setSleep([{dayStartMs:0,startMs:1,endMs:2,totalSec:24120,wakeSec:600,remSec:3600,lightSec:15000,deepSec:5520,segments:[],timeResolved:true}]);
  const panels=h.createCompanionPanels({launchApp:async()=>{},openDevices:async()=>{},openPermissions(){},openAdvanced(){}});
  panels.refresh();
  const rendered=panelText(panels.health);
  assert.match(rendered,/Steps\s+1,234/);
  assert.match(rendered,/Active energy\s+87 kcal/);
  assert.match(rendered,/Sleep\s+6h 42m/);
  assert.doesNotMatch(rendered,/RMSSD|temperature|999 kcal/);
});

test('Health keeps maintenance collapsed below assistant sharing and reveals it only on request',()=>{
  const h=harness();h.setAvailable(true);
  const panels=h.createCompanionPanels({launchApp:async()=>{},openDevices:async()=>{},openPermissions(){},openAdvanced(){}});
  panels.refresh();
  let rendered=panelText(panels.health);
  assert.doesNotMatch(rendered,/Start R1 recording from now|Export R1 measurements|RMSSD|temperature/);
  const advanced=h.views.find(view=>view.accessibilityLabel==='Advanced health details, Show');
  assert.ok(advanced);
  advanced.events.tap();
  rendered=panelText(panels.health);
  assert.match(rendered,/Start R1 recording from now/);
  assert.match(rendered,/Export R1 measurements/);
  assert.match(rendered,/RMSSD/);
  assert.ok(rendered.indexOf('Share with assistant') < rendered.indexOf('Advanced health details'));
  assert.ok(rendered.indexOf('Advanced health details') < rendered.indexOf('Open Health'));
});

test('Sync now is unavailable without a connected bridge and never claims completion',async()=>{
  const h=harness();h.setBridge(null);
  const panels=h.createCompanionPanels({launchApp:async()=>{},openDevices:async()=>{},openPermissions(){},openAdvanced(){}});
  panels.refresh();
  const sync=h.views.find(view=>view.accessibilityLabel==='Sync now');
  assert.ok(sync);assert.equal(sync.isEnabled,false);
  assert.match(panelText(panels.health),/Connect Pilot to sync/);
  sync.events.tap?.();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.calls.some(call=>call[0]==='ring-pull'),false);
  assert.doesNotMatch(panelText(panels.health),/Synced|Sync requested/);
});

test('Sync now stays unavailable while the active bridge is still connecting',async()=>{
  const h=harness();h.setSessionReady(false);
  const panels=h.createCompanionPanels({launchApp:async()=>{},openDevices:async()=>{},openPermissions(){},openAdvanced(){}});
  panels.refresh();
  let sync=h.views.filter(view=>view.accessibilityLabel==='Sync now').at(-1);
  assert.equal(sync.isEnabled,false);
  assert.match(panelText(panels.health),/Connect Pilot to sync/);
  sync.events.tap();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.calls.some(call=>call[0]==='ring-pull'),false);
  assert.doesNotMatch(panelText(panels.health),/Sync requested/);
  h.setSessionReady(true);panels.refresh();
  sync=h.views.filter(view=>view.accessibilityLabel==='Sync now').at(-1);
  assert.equal(sync.isEnabled,true);
});

test('Sync now can queue ring-only health while glasses stay unavailable',async()=>{
  const h=harness();h.setSessionReady(false);h.setRingOnlyHealthReady(true);
  const panels=h.createCompanionPanels({launchApp:async()=>{},openDevices:async()=>{},openPermissions(){},openAdvanced(){}});
  panels.refresh();
  const sync=h.views.filter(view=>view.accessibilityLabel==='Sync now').at(-1);
  assert.equal(sync.isEnabled,true);
  sync.events.tap();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.calls.filter(call=>call[0]==='ring-pull').length,1);
  assert.match(panelText(panels.health),/Sync requested/);
  assert.doesNotMatch(panelText(panels.health),/Synced/);
});

test('Sync now requests a pull and refreshes local readings only for the current bridge generation',async()=>{
  const h=harness();h.setFixture(false);h.setLive(true);
  const panels=h.createCompanionPanels({launchApp:async()=>{},openDevices:async()=>{},openPermissions(){},openAdvanced(){}});
  panels.refresh();
  h.views.find(view=>view.accessibilityLabel==='Sync now').events.tap();
  await new Promise(resolve=>setImmediate(resolve));
  assert.match(panelText(panels.health),/Sync requested/);
  assert.doesNotMatch(panelText(panels.health),/Synced/);
  const callback=h.pullCallbacks()[0];
  h.setReadings([{metric:'heartRate',startMs:200,spanMs:0,min:81,max:81,avg:81,total:81}]);
  h.setBridge(null);callback({completed:true,pages:1,watermark:1});
  assert.doesNotMatch(panelText(panels.health),/81 bpm/);
  assert.match(panelText(panels.health),/Sync requested/);
  h.setBridge(h.bridge);callback({completed:true,pages:1,watermark:1});
  assert.match(panelText(panels.health),/81 bpm/);
  assert.doesNotMatch(panelText(panels.health),/Sync requested|Synced/);
  const reads=h.calls.filter(call=>call[0]==='read-health').length;
  const stale=h.pullCallbacks();
  panels.clearHealth();stale.forEach(listener=>listener({completed:true,pages:1,watermark:1}));
  assert.equal(h.calls.filter(call=>call[0]==='read-health').length,reads);
});

test('Health exposes one confirmed fresh-recording action and reports the verified native result',async()=>{
  const h=harness();h.setAvailable(true);
  h.dialogs.confirm=async options=>{assert.match(options.message,/undated history/i);return true;};
  const panels=h.createCompanionPanels({launchApp:async()=>{},openDevices:async()=>{},openPermissions(){},openAdvanced(){}});
  panels.refresh();
  showAdvanced(h);
  const action=h.views.find(view=>view.accessibilityLabel==='Start R1 recording from now, One-time');
  assert.ok(action);
  action.events.tap();await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(h.calls,[['fresh-start'],['alert','R1 recording configured']]);
});

test('backgrounding invalidates an old fresh-recording confirmation',async()=>{
  const h=harness();h.setAvailable(true);
  let confirm;
  h.dialogs.confirm=()=>new Promise(resolve=>{confirm=resolve});
  const panels=h.createCompanionPanels({launchApp:async()=>{},openDevices:async()=>{},openPermissions(){},openAdvanced(){}});
  panels.refresh();showAdvanced(h);
  h.views.find(view=>view.accessibilityLabel==='Start R1 recording from now, One-time').events.tap();
  panels.clearHealth();confirm(true);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.calls.some(call=>call[0]==='fresh-start'),false);
});

test('exports captured point readings in bounded batches without sending hourly summaries',async()=>{
  const h=harness();h.setAvailable(true);h.setLive(true);h.setFixture(false);
  const receivedAtMs=Date.now()-1000;
  h.setReadings(Array.from({length:2001},(_,i)=>({metric:'heartRate',startMs:receivedAtMs-(i+1)*1000,spanMs:0,
    min:72,max:72,avg:72,total:72,provenance:{kind:'r1-live',ringId:'ring',dateSource:'ring-latest',receivedAtMs,exportRevision:1}})));
  h.dialogs.confirm=async options=>{assert.match(options.message,/captured/i);return true};
  const panels=h.createCompanionPanels({launchApp:async()=>{},openDevices:async()=>{},openPermissions(){},openAdvanced(){}});
  panels.refresh();
  showAdvanced(h);
  h.views.find(view=>view.accessibilityLabel==='Export R1 measurements, Last 7 days').events.tap();
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(h.calls.filter(call=>call[0]==='write-health'),[['write-health',1000],['write-health',1000],['write-health',1]]);
  assert.ok(h.calls.some(call=>call[0]==='alert'&&call[1]==='Export submitted'));
});

test('backgrounding invalidates an export confirmation before any write',async()=>{
  const h=harness();h.setAvailable(true);h.setLive(true);h.setFixture(false);
  const timestamp=Date.now()-1000;
  h.setReadings([{metric:'heartRate',startMs:timestamp,spanMs:0,min:72,max:72,avg:72,total:72,
    provenance:{kind:'r1-live',ringId:'ring',dateSource:'ring-latest',receivedAtMs:timestamp,exportRevision:1}}]);
  let confirm;
  h.dialogs.confirm=()=>new Promise(resolve=>{confirm=resolve});
  const panels=h.createCompanionPanels({launchApp:async()=>{},openDevices:async()=>{},openPermissions(){},openAdvanced(){}});
  panels.refresh();
  showAdvanced(h);
  h.views.find(view=>view.accessibilityLabel==='Export R1 measurements, Last 7 days').events.tap();
  panels.clearHealth();confirm(true);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.calls.filter(call=>call[0]==='write-health').length,0);
});

test('a pending export confirmation prevents a second simultaneous export',async()=>{
  const h=harness();h.setAvailable(true);h.setLive(true);h.setFixture(false);
  const timestamp=Date.now()-1000;
  h.setReadings([{metric:'heartRate',startMs:timestamp,spanMs:0,min:72,max:72,avg:72,total:72,
    provenance:{kind:'r1-live',ringId:'ring',dateSource:'ring-latest',receivedAtMs:timestamp,exportRevision:1}}]);
  let confirmations=0,confirm;
  h.dialogs.confirm=()=>{confirmations++;return new Promise(resolve=>{confirm=resolve})};
  const panels=h.createCompanionPanels({launchApp:async()=>{},openDevices:async()=>{},openPermissions(){},openAdvanced(){}});
  panels.refresh();
  showAdvanced(h);
  const action=h.views.find(view=>view.accessibilityLabel==='Export R1 measurements, Last 7 days');
  action.events.tap();action.events.tap();
  assert.equal(confirmations,1);
  confirm(false);await new Promise(resolve=>setImmediate(resolve));
});

test('Apple Health queries require a tap and suspending the page cancels and discards late values',async()=>{
  const h=harness();h.setAvailable(true);
  const panels=h.createCompanionPanels({launchApp:async()=>{},openDevices:async()=>{},openPermissions(){},openAdvanced(){}});
  panels.refresh();assert.deepEqual(h.calls,[]);
  h.views.find(view=>view.accessibilityLabel==='Today’s summary, Refresh').events.tap();
  assert.deepEqual(h.calls,[['health-query','today']]);
  panels.clearHealth();assert.equal(h.readSignal().aborted,true);
  h.finishRead({day:'today',queriedAtMs:1,metrics:{steps:{value:987654,unit:'count'},heartRate:null,restingHeartRate:null,hrv:null,oxygenSaturation:null}});
  await new Promise(resolve=>setImmediate(resolve));
  const currentText=view=>[view.text||'',...(view.children||[]).map(currentText),view.content?currentText(view.content):''].join('\n');
  assert.doesNotMatch(currentText(panels.health),/987,654|987654/);
});
