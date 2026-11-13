const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const images = require('../.test-build/app/graphics/image.js');
const events = require('../.test-build/app/g2/events.js');

function load(file, modules, globals = {}) {
  const context = { exports: {}, require: id => {
    if (!(id in modules)) throw new Error(`Unstubbed import: ${id}`);
    return modules[id];
  }, ...globals };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, context);
  return context.exports;
}
const planes = load('app/graphics/plane.ts', { './image': images });
const timings = load('app/native/frame-timings.ts', {});
const LAUNCHER_GRAY = 75;

let glassesType = 'g2';

function fixture() {
  const relay = { available: true, starts: 0, client: null, message: undefined };
  const observers = new Map(), phoneState = { protectedDataAvailable: true };
  let settingsChanged, remoteHost, controller, bridge = null, sharedBridge = null, connectionWanted = true, pullPending = false, detachShared;
  let now = 1000, nextTask = 0, screenOn = true, shellOptions, wakeFocus;
  const headUp = load('app/native/head-up-settings.ts', {});
  const battery = {};
  const nativePolicy = { gate: null, calls: 0 };
  const health = { enabled: false, drains: 0, pulls: 0, coldStart: false, ringMode: 'glasses', ring: '' };
  const tasks = new Map(), sent = [], previews = [], received = [], errors = [];
  const boardStats = { starts: 0, stops: 0, paints: 0 };
  const registered = [], inProcessApps = [];
  const settings = { lock: true, ringControlsOnlyWhileWorn: true, enabled: true, tap: true, hold: true, tilt: true, duration: 3000, depth: 0 };
  const clock = { Date: class extends Date { static now() { return now; } },
    setTimeout: (fn, ms) => { tasks.set(++nextTask, { fn, at: now + ms }); return nextTask; },
    clearTimeout: id => tasks.delete(id), setInterval: () => ++nextTask, clearInterval() {} };
  const { GlanceHost } = load('app/g2/glance-host.ts', {
    '../graphics/image': images, '../graphics/plane': planes,
    '../graphics/glyph-wire': { prepareFrameDraws: () => null }, '../native/frame-timings': timings,
    '../ui/shell/geometry': { minWindowTop: () => 48 },
    '../util/render-freshness': { beginRenderPass() {}, endRenderPass: () => false },
    './glance-state': require('../.test-build/app/g2/glance-state.js'),
  }, clock);
  const launcherPixels = new Uint8Array(640 * 480).fill(LAUNCHER_GRAY), fullRect = { x: 0, y: 0, width: 640, height: 480 };
  const window = { windowId: 'launcher', surfaceId: 'launcher', appId: 'launcher', title: 'Apps',
    // The launcher repaints into whichever display target the controller has after a switch.
    requestRender() { void controller?.displayReady.then(() => controller.display?.submitSurfaceFrame('launcher', launcherPixels, fullRect, 'launcher')); }, setScreenOn() {} };
  const shell = {
    configure: options => { shellOptions = options; }, registerWindow: window => registered.push(window), focusWindow() {},
    wake: focus => { wakeFocus = focus; screenOn = true; shellOptions.onScreenStateChanged(true); },
    sleep: () => { screenOn = false; shellOptions.onScreenStateChanged(false); },
    isScreenOn: () => screenOn, getWindows: () => [window], foregroundWindow: () => window,
    setBatteryLevels: levels => Object.assign(battery, levels), underlayDim: () => 1, getFocus: () => 'app', hasOverlay: () => false,
    describeInputTarget: () => 'test app',
    paintScene: () => new Uint8Array([0, 0]), paintSurface: () => [{ image: new images.GrayImage(640, 480, 0), x: 0, y: 0 }],
    receiveInput: async input => {
      received.push(input);
      if (!screenOn && (input.type === 'display-wake' || input.type === 'double-click')) shell.wake();
    },
  };
  // Both display targets share a minimal compositor (z-ordered opaque and
  // color-keyed surfaces, visibility, blanking) so the pixel assertions below
  // exercise layering, blanking and lock surfaces.
  class Display {
    surfaces = new Map(); blanked = false; depths = [];
    async configureCompositorScreen() {}
    async configureSurface(id, options) {
      const previous = this.surfaces.get(id);
      const pixels = previous?.width === options.width && previous.height === options.height
        ? previous.pixels : new Uint8Array(options.width * options.height);
      this.surfaces.set(id, { ...options, pixels, visible: previous?.visible ?? true });
    }
    async removeSurface(id) { this.surfaces.delete(id); this.changed(); }
    async setSurfaceVisible(id, visible) { const surface = this.surfaces.get(id); if (surface) surface.visible = visible; this.changed(); }
    async setSurfaceDepth(id, depth) { this.depths.push([id, depth]); }
    async setUnderlayDim() { this.changed(); }
    async setScreenBlanked(blanked) { this.blanked = blanked; this.changed(); }
    async submitSurfaceFrame(id, pixels, rect) {
      const surface = this.surfaces.get(id);
      if (!surface) throw new Error(`Unknown surface: ${id}`);
      for (let y = 0; y < rect.height; y++) {
        surface.pixels.set(pixels.subarray(y * rect.width, (y + 1) * rect.width), (rect.y + y) * surface.width + rect.x);
      }
      this.changed();
    }
    async submitShellScene() { this.changed(); }
    getCompositePreview() {
      const output = new Uint8Array(640 * 480);
      if (this.blanked) return output;
      for (const s of [...this.surfaces.values()].filter(s => s.visible).sort((a, b) => a.zOrder - b.zOrder)) {
        for (let y = 0; y < s.height; y++) for (let x = 0; x < s.width; x++) {
          const value = s.pixels[y * s.width + x];
          if (s.transparency !== 'color-key' || value) output[(s.y + y) * 640 + s.x + x] = value;
        }
      }
      return output;
    }
    changed() {}
  }
  class PreviewDisplayTarget extends Display {
    activate(fn) { this.onFrame = fn; } release() { this.onFrame = null; }
    changed() { this.onFrame?.(); }
    waitForFrameFinished() { return Promise.resolve('composited'); }
  }
  const noop = () => () => {};
  class FaceclawCommunicatorBridge extends Display {
    phase = 'disconnected'; listeners = {};
    headUpEnabled = true; headUpAtStart = null;
    constructor(addresses) { super(); bridge = this; this.addresses = addresses; this.independent = addresses.independentRingHealth; }
    on(kind, fn) { this.listeners[kind] = fn; return () => { if (this.listeners[kind] === fn) delete this.listeners[kind]; }; }
    onStateChange(fn) { return this.on('state', fn); } onRingEvent(fn) { return this.on('ring', fn); }
    onRingHealthPullFinished(fn) { return this.on('health', fn); }
    isSessionReady() { return this.phase === 'connected'; }
    canSyncRingHealth() { return this.isSessionReady() || Boolean(this.independent && this.addresses.ring); }
    setIndependentRingHealthEnabled(enabled) { this.independent = enabled; }
    onWearState(fn) { return this.on('wear', fn); } onBatteryState(fn) { return this.on('battery', fn); } onCaseState(fn) { return this.on('case', fn); } onFirmwareInfo(fn) { return this.on('firmware', fn); }
    onFrameMetrics() { return noop(); } onPreviewAnimationFrame() { return noop(); } addCompassListener() { return noop(); } onAncsRelayFrame() { return noop(); }
    onAncsAuthorization() { return noop(); } setRequiresAncs() {} ancsRelayAvailable() { return relay.available; } rightWriteLimit() { return 20; } onPhoneLockSignal() {}
    async writeRawToRight() {} async configureBrightness() {} async setBrightness() {} async enableWearDetectionAndRequestState() {} async playBuzzerSequence() {} async close() {}
    emitState(phase, status = phase) { if (phase === 'connected' || phase === 'disconnected') this.phase = phase; this.listeners.state?.({ phase, status }); }
    emitRing(input) { this.listeners.ring?.(input); }
    emitWear(wearing) { this.listeners.wear?.(wearing); }
    emitBattery(state) { this.listeners.battery?.(state); }
    emitCase(state) { this.listeners.case?.(state); }
    async setHeadUpEnabled(enabled) { nativePolicy.calls++; if (nativePolicy.gate) await nativePolicy.gate; this.headUpEnabled = enabled; }
    async readHeadUpAngle() { return 30; }
    async setHeadUpAngle() { return true; }
    async start() { this.headUpAtStart = this.headUpEnabled; this.emitState(health.coldStart ? 'connecting' : 'connected', health.coldStart ? 'Glasses unavailable' : 'Connected.'); }
    async promoteToInteractive() { await this.start(); }
    get connectionState() { return {phase:this.phase,status:this.phase}; }
    async disconnect() { this.emitState('disconnected', 'Disconnected.'); }
    waitForFrameFinished() { return Promise.resolve('sent'); }
    changed() { if (this.phase === 'connected') sent.push(this.getCompositePreview()); }
  }
  const provider = {
    isEnabled: () => settings.enabled, showOnTap: () => settings.tap,
    showOnLongPress: () => settings.hold, showOnHeadTilt: () => settings.tilt,
    headUpTarget: () => settings.target ?? (settings.enabled ? 'glanceboard' : 'last-app'),
    tapTimeoutMs: () => settings.duration, depth: () => settings.depth,
    createBoard: () => ({ start: () => boardStats.starts++, stop: () => boardStats.stops++,
      paint: () => { boardStats.paints++; return new images.GrayImage(100, 80, 200); } }),
  };
  const inputMonitor = load("app/ui/input-monitor.ts", {});
  const modules = {
    '../health/ring-session.ios': {
      async ensureIosSession(options) {
        if(options.userInitiated)connectionWanted=true;
        if(!connectionWanted)return null;
        if(!sharedBridge) {
          sharedBridge=new FaceclawCommunicatorBridge({right:'AA',left:'BB',ring:health.ringMode==='direct'?health.ring:'',
            ringRole:health.ringMode==='direct'&&health.ring?'glasses':undefined,glassesType,
            independentRingHealth:health.ringMode==='direct'&&Boolean(health.ring)&&health.enabled});
          const target=sharedBridge;
          target.onRingHealthPullFinished(()=>{if(sharedBridge===target){health.drains++;pullPending=false;}});
        }
        return sharedBridge;
      },
      claimIosSessionForUi(_bridge,detach){detachShared=detach;},
      async releaseIosSession(target){if(sharedBridge===target)sharedBridge=null;await target.close();},
      setIosSessionConnectionWanted(value){connectionWanted=value;},
      syncIosRingPolicy(){sharedBridge?.setIndependentRingHealthEnabled(health.enabled);if(!health.enabled)pullPending=false;},
      resumeIosRingHealth(){if(health.enabled&&sharedBridge?.addresses.ring&&sharedBridge.canSyncRingHealth()&&!pullPending){pullPending=true;health.pulls++;}},
    },
    '../health/healthkit-sync.ios': { isAutomaticR1HealthSyncEnabled: () => health.enabled,
      syncAutomaticR1Health: async () => { health.drains++; } },
    '../health/health-live': { requestFreshPull: () => { health.pulls++; } },
    "../ui/input-monitor": inputMonitor,
    '../remote/service': { startRemoteInput(host) { remoteHost = host; } },
    '../assistant/system-tools': { registerSystemTools() {} },
    '../assistant/window-tools': { registerWindowTools() {} },
    '../assistant/navigate-tools': { registerNavigateTools() {} },
    '../assistant/roam-tools': { registerRoamTools() {} },
    "../native/ios-navigation-sensors": {},
    '../native/notification-icons.ios': { bindIosNotifications() {}, iosNotificationsChanged() {}, onIosNotificationPopup: () => () => {}, readActiveNotifications: () => [] },
    '../native/notification-sources': { shouldShowNotificationOnGlasses: () => true },
    "../native/compass.ios": { bindCompassSession() {}, receiveCompassEvent() {} },
    '../native/bandwidth-benchmark.ios': { bindBandwidthBenchmarkSession() {} },
    '../native/head-up-settings': headUp,
    '@nativescript/core': { File: { fromPath: () => ({ writeTextSync() {} }) },
      knownFolders: { documents: () => ({ path: '/tmp' }) }, path },
    '../native/ios-voice-input': { iosVoiceInput: { handleSessionEnded() {}, stopPhoneCapture() {}, setRawSession() {}, onSpeechEnd: () => () => {} } },
    '../native/cloud-stt-provider': { transcriptionKey: voice => voice.provider },
    '../ui/shell/voice-activity': { voiceActivity: { setActive() {}, isActive: () => false, subscribe: () => () => {} } },
    '../native/faceclaw-communicator.ios': { FaceclawCommunicatorBridge, resolveIosPeripherals: async addresses => addresses },
    '../native/preview-display.ios': { PreviewDisplayTarget },
    '../g1/firmware/g1v0-image': { G1V0_IMAGE: { version: '0.5.65' } },
    './ancs-client': { ANCS_FIRMWARE_VERSION: 16, AncsClient: class { state = 'disconnected'; constructor() { relay.client = this; }
      start() { this.state = 'starting'; relay.starts++; } stop(message) { this.state = 'disconnected'; relay.message = message; }
      stopCommand() { return new Uint8Array(); } receive() { return false; } } },
    '../native/nightscout-bridge': { nightscoutBridge: { async start() {}, async stop() {} } },
    '../native/weather': { weatherBridge: { setSessionActive() {} } },
    './glance-host': { GlanceHost }, './events': events,
    // Whole-panel mirror: the pixel assertions below index the full 640x480 preview.
    './phone-preview-crop': { phonePreviewCrop: () => null, mirrorToPanelFraction: (_crop, nx, ny) => ({ nx, ny }) },
    './lock-screen': { LOCK_SCREEN_SURFACE_ID: 'lock-screen', createLockScreenImage: () => new images.GrayImage(640, 480, 123) },
    './glasses-presence': load('app/g2/glasses-presence.ts', {}),
    './device-addresses': { loadDeviceAddresses: () => ({ right: 'AA', left: 'BB', ring: health.ring }) }, './ios-peripheral-identity': { deviceAddressError: () => null },
    './wear-remote': { WearRemote: class { schedulePublish() {} } },
    './firmware-compat': load('app/g2/firmware-compat.ts', {}), './reconnect-policy': load('app/g2/reconnect-policy.ts', {}),
    '../apps/launcher': { launcherEntries: () => [] },
    '../apps/evenhub/installed-apps': {}, '../apps/evenhub/manager': { onPhoneShownChanged: () => () => {}, phoneUiButton: () => null },
    '../apps/evenhub/updates': {}, '../apps/evenhub': {},
    '../apps/launcher/launcher-app': { createLauncherWindow: () => window, LAUNCHER_SURFACE_ID: 'launcher' },
    '../apps/notifications/notifications-app': { NOTIFICATIONS_SURFACE_ID: 'window:notifications', NOTIFICATIONS_WINDOW_ID: 'notifications',
      createNotificationsAppWindow: options => {
        const app = { options, window: { windowId: 'notifications', surfaceId: 'window:notifications', appId: 'notifications', heightMode: 'min' } };
        inProcessApps.push(app);
        return app;
      } },
    '../apps/all-apps': { ALL_APPS: [{ appId: 'glanceboard', glanceboard: provider }] },
    '../apps/onboarding/onboarding-progress': { claimGlassesOnboardingAutoLaunch: () => false },
    '../ui/shell/worker-window': {}, '../ui/shell/in-process-window': {},
    '../ui/dashboard-settings': { glassesTypeSetting: { get: () => glassesType }, brightnessSetting: { get: () => 'auto' }, brightnessSettingToLevel: () => null, getBrightnessPreferences: () => ({ auto: true, level: 50, minimum: 2, maximum: 100, curve: '0:0,1000:100', fadeMs: 280 }), lockScreenEnabledSetting: { get: () => settings.lock }, ringConnectionModeSetting: { get: () => health.ringMode }, ringControlsOnlyWhileWornSetting: { get: () => settings.ringControlsOnlyWhileWorn }, onAnySettingChanged: fn => { settingsChanged = fn; return () => {}; }, previewColorSetting: { get: () => 'white' } },
    '../native/phone-battery': { readPhoneBatteryState: () => ({ battery: 80, charging: false }) },
    '../apps/ios-availability': { iosAppUnavailableReason: () => null },
    '../graphics/glyph-wire': { prepareFrameDraws: () => null },
    '../graphics/plane': planes, '../graphics/image': images,
    '../ui/gestures': { makeInputEvent: event => event }, '../ui/layers': { noopLayerActions: {} },
    '../apps/files/text-viewer': {},
    '../ui/shell/shell': { shell, rawInputEventToInputEvent: event => ({
      ringInput: event.ringInput, timestampMs: now,
      type: event.kind === 'display-wake' ? 'display-wake'
        : ({ 0: 'click', 1: 'scroll-up', 2: 'scroll-down', 3: 'double-click', 9: 'long-press',
          10: 'long-press-release', 11: 'short-then-long-press' })[event.eventType] ?? 'unknown', source: 'ring',
    }) },
    '../ui/shell/geometry': { appViewportRect: () => ({ x: 0, y: 0, width: 640, height: 480 }) },
  };
  const { IosPreviewController } = load('app/g2/ios-preview-controller.ts', modules, {
    ...clock, console: { log() {}, warn() {}, error: text => errors.push(text) },
    UIDevice: { currentDevice: {} }, UIApplication: { sharedApplication: phoneState },
    UIApplicationProtectedDataWillBecomeUnavailable: 'lock', UIApplicationProtectedDataDidBecomeAvailable: 'unlock',
    UIDeviceBatteryLevelDidChangeNotification: 'level', UIDeviceBatteryStateDidChangeNotification: 'state',
    NSNotificationCenter: { defaultCenter: { addObserverForNameObjectQueueUsingBlock(name, _object, _queue, fn) { observers.set(name, fn); return name; }, removeObserver(name) { observers.delete(name); } } },
    NSOperationQueue: { mainQueue: {} },
  });
  controller = new IosPreviewController((pixels, title) => previews.push({ pixels, title }), message => errors.push(message));
  window.requestRender();
  controller.resume();
  async function drain() { await controller.inputQueue; await controller.glance.queue; }
  async function advance(ms) {
    now += ms;
    for (const [id, task] of [...tasks]) if (task.at <= now && tasks.delete(id)) task.fn();
    await drain();
  }
  async function render() { await drain(); await advance(33); await drain(); assert.deepEqual(errors, []); }
  async function hardware(type, source = 2, ringTick) {
    const input = { kind: type === 12 ? 'display-wake' : 'sys-event', containerName: '', eventType: type, eventSource: source,
      systemExitReasonCode: 0, frameId: 0 };
    if (ringTick !== undefined) input.ringInput = { type: type === 3 ? 2 : 1, tick: ringTick, aux: 0, speed: 0 };
    bridge.emitRing(input);
    await render();
  }
  async function phone(type, origin = 'ring') { controller.gesture(type, origin); await render(); }
  async function connect() { await controller.connect(false,true); await render(); }
  return { relay, controller, shell, battery, nativePolicy, headUp, get wakeFocus() { return wakeFocus; }, health, remoteHost, keyboardChanged: session => shellOptions.onKeyboardInputChanged(session), settings, phoneState, observers,
    get shellOptions() { return shellOptions; }, registered, inProcessApps,
    get bridge() { return bridge; }, detachShared:()=>detachShared(), connect, wear: wearing => bridge.emitWear(wearing), settingsChanged: () => settingsChanged(), sent, previews, received, boardStats, hardware, phone, advance, render };
}
test('R1 collection needs automatic consent and stale transfer callbacks cannot target a replacement session', async () => {
  const f = fixture();
  Object.assign(f.health,{ringMode:'direct',ring:'R1'});
  await f.connect();
  assert.equal(f.health.pulls, 0);
  f.health.enabled = true;
  f.controller.pause(); f.controller.resume();
  await f.render();
  assert.equal(f.health.pulls, 1);
  const oldCompletion = f.bridge.listeners.health;
  const before = f.health.drains;
  oldCompletion({ completed: false, pages: 1, watermark: 1 });
  assert.equal(f.health.drains, before + 1);
  assert.equal(f.health.pulls, 1);
  await f.controller.disconnect();
  const closed = f.health.drains;
  oldCompletion({ completed: true, pages: 1, watermark: 2 });
  assert.equal(f.health.drains, closed);
});

test('cased startup queues Direct-mode health after native start and revoking consent keeps controls gated', async () => {
  const f = fixture();
  Object.assign(f.health, { enabled: true, coldStart: true, ringMode: 'direct', ring: 'R1' });
  await f.connect();
  assert.equal(f.bridge.addresses.independentRingHealth, true);
  assert.equal(f.bridge.isSessionReady(), false);
  assert.equal(f.health.pulls, 1);
  const before = f.received.length;
  await f.hardware(0);
  assert.equal(f.received.length, before);
  f.health.enabled = false; f.settingsChanged();
  assert.equal(f.bridge.independent, false);
  f.controller.pause(); f.controller.resume(); await f.render();
  assert.equal(f.health.pulls, 1);
});

test('ordinary ready startup never invents a ring in glasses-only mode', async () => {
  const f = fixture(); f.health.enabled = true;
  await f.connect();
  assert.equal(f.bridge.addresses.ring, '');
  assert.equal(f.bridge.addresses.independentRingHealth, false);
  assert.equal(f.health.pulls, 0);
});

test('service-driven detach resets the connected UI and returns to preview without an explicit user stop',async()=>{
  const f=fixture();await f.connect();assert.equal(f.controller.connectionState.phase,'connected');
  f.detachShared();await f.render();
  assert.equal(f.controller.connectionState.phase,'disconnected');
  assert.equal(f.controller.communicator,null);assert.ok(f.previews.length>0);
});

test('the session is told which glasses it drives, as a G2 session gets nowhere on a G1', async () => {
  for (const type of ['g1', 'g2']) {
    glassesType = type;
    const f = fixture();
    await f.connect();
    assert.equal(f.bridge.addresses.glassesType, type);
    assert.ok('right' in f.bridge.addresses && 'left' in f.bridge.addresses, 'the arms still come with it');
  }
  glassesType = 'g2';
});

test('a link that comes back asks for the notification relay again; a G1 without one is told to update', async () => {
  const f = fixture();
  await f.connect();
  const firmware = { leftVersion: 'g1v0 0.5.65', rightVersion: 'g1v0 0.5.65', extension: 'Faceclaw/38' };
  f.bridge.listeners.firmware(firmware);
  assert.equal(f.relay.starts, 1);
  // Connected and running: nothing to do.
  f.bridge.emitState('connected');
  assert.equal(f.relay.starts, 1);
  // The firmware's relay ended with the link, so the client must not go on thinking it's ready.
  f.bridge.emitState('retrying', 'Reconnecting');
  assert.equal(f.relay.client.state, 'disconnected');
  f.bridge.emitState('connected');
  assert.equal(f.relay.starts, 2);
  f.bridge.emitState('retrying', 'Reconnecting');
  f.relay.available = false;
  f.bridge.emitState('connected');
  assert.equal(f.relay.starts, 2);
  assert.match(f.relay.message, /firmware 0\.5\.65/);
});
const assertBlank = pixels => assert.ok(pixels.every(p => p === 0));
const assertBoard = pixels => {
  assert.equal(pixels[48 * 640 + 270], 200);
  assert.equal(pixels[0], 0, 'opaque Glanceboard hides the retained app and shell');
};

test('head-up Off keeps both Glanceboard and the regular display asleep, including while locked', async () => {
  for (const enabled of [true, false]) for (const locked of [false, true]) {
    const f = fixture();
    await f.connect();
    Object.assign(f.settings, { enabled, tilt: false });
    f.controller.glassesLocked = locked;
    f.shell.sleep();
    const before = f.received.length;
    await f.hardware(12, 0);
    assert.equal(f.controller.glance.isVisible(), false);
    assert.equal(f.shell.isScreenOn(), false, `board=${enabled}, locked=${locked}`);
    assert.equal(f.received.length, before, 'head-up must not reach the regular wake path');
    await f.hardware(3, 0);
    assert.equal(f.shell.isScreenOn(), true, 'double-tap still wakes');
  }
});

test('native head-up policy is applied before interactive startup and updated live', async () => {
  const f = fixture();
  f.settings.tilt = false;
  await f.connect();
  assert.equal(f.bridge.headUpAtStart, false);
  f.settings.tilt = true;
  f.settingsChanged();
  await f.render();
  assert.equal(f.bridge.headUpEnabled, true);
});

test('a setting changed while initial native policy waits is not lost during connect', async () => {
  const f = fixture();
  let release;
  f.nativePolicy.gate = new Promise(resolve => { release = resolve; });
  f.settings.tilt = false;
  const connected = f.connect();
  while (!f.nativePolicy.calls) await new Promise(resolve => setImmediate(resolve));
  f.settings.tilt = true;
  f.settingsChanged();
  release();
  await connected;
  assert.equal(f.bridge.headUpEnabled, true);
  assert.equal(f.bridge.headUpAtStart, true);
});

test('head-up On uses Glanceboard when enabled and regular wake otherwise, without reconnecting', async () => {
  for (const enabled of [true, false]) {
    const f = fixture();
    await f.connect();
    Object.assign(f.settings, { enabled, tilt: false });
    f.shell.sleep();
    await f.hardware(12, 0);
    assert.equal(f.shell.isScreenOn(), false);
    f.settings.tilt = true;
    await f.hardware(12, 0);
    assert.equal(f.controller.glance.isVisible(), enabled);
    assert.equal(f.shell.isScreenOn(), !enabled);
  }
});

test('head-up Show opens Glanceboard independently of tap/hold enable, or the retained app', async () => {
  const f = fixture();
  await f.connect();
  Object.assign(f.settings, { enabled: false, target: 'glanceboard' });
  f.shell.sleep(); await f.hardware(12, 0);
  assert.equal(f.controller.glance.isVisible(), true);
  assert.equal(f.shell.isScreenOn(), false);
  f.controller.glance.dismiss(); await f.render();
  f.settings.target = 'last-app';
  await f.hardware(12, 0);
  assert.equal(f.controller.glance.isVisible(), false);
  assert.equal(f.shell.isScreenOn(), true);
  assert.equal(f.wakeFocus, 'window');
});

test('angle editor binding expires a picker across the same native session reconnect', async () => {
  const f = fixture();
  await f.connect();
  assert.equal(f.headUp.isHeadUpSettingsAvailable(), true);
  const generation = f.headUp.headUpSettingsGeneration();
  f.bridge.emitState('retrying');
  assert.equal(f.headUp.isHeadUpSettingsAvailable(), false);
  f.bridge.emitState('connected');
  await assert.rejects(f.headUp.setHeadUpAngle(30, generation), /connection changed/);
});

test('phone preview gestures use Glanceboard; losing runtime cleans up holds and timers', async () => {
  const f = fixture(); f.shell.sleep();
  await f.phone('tap', 'mirror'); assertBoard(f.previews.at(-1).pixels);
  await f.phone('double-tap', 'mirror'); assert.equal(f.shell.isScreenOn(), true);
  f.shell.sleep(); await f.phone('long-press', 'ring');
  await f.phone('long-press-release', 'ring'); assertBlank(f.previews.at(-1).pixels);
  await f.phone('short-then-long-press', 'ring'); assert.equal(f.controller.glance.isVisible(), true);
  f.controller.pause(); await f.render(); assert.equal(f.controller.glance.isVisible(), false);
  f.controller.resume(); await f.render(); assertBlank(f.previews.at(-1).pixels);
  assert.equal(f.boardStats.starts, f.boardStats.stops);
});

test('keyboard sessions cannot deliver text after the glasses lock or phone leaves the foreground', () => {
  const f = fixture();
  let editor;
  f.controller.onKeyboardInputChanged = session => { editor = session; };
  const calls = [];
  f.keyboardChanged({ targets: [{ id: 'app', label: 'Type into App' }],
    setText: text => calls.push(['text', text]), send: () => calls.push(['send']),
    sendTo: id => calls.push(['target', id]), discard: () => calls.push(['discard']) });
  editor.setText('hello'); editor.sendTo('app');
  assert.deepEqual(calls, [['text', 'hello'], ['target', 'app']]);
  f.controller.glassesLocked = true;
  editor.setText('locked'); editor.send(); editor.sendTo('app');
  assert.equal(calls.length, 2);
  f.controller.glassesLocked = false; f.controller.pause();
  editor.setText('background'); editor.sendTo('app');
  assert.equal(calls.length, 2);
  editor.discard(); assert.deepEqual(calls.at(-1), ['discard']);
});


test('ring battery reported through the glasses reaches the shell while connected', async () => {
  const f = fixture();
  await f.connect();
  f.bridge.emitBattery({ battery: 70, chargingStatus: 0, ringBattery: 55, ringChargingStatus: 1 });
  assert.deepEqual([f.battery.headset, f.battery.ring, f.battery.ringCharging], [70, 55, true]);
  // An unavailable ring reading clears the indicator; the headset keeps its last level.
  f.bridge.emitBattery({ battery: -1, chargingStatus: 0, ringBattery: -1, ringChargingStatus: -1 });
  assert.deepEqual([f.battery.headset, f.battery.ring, f.battery.ringCharging], [70, null, null]);
  f.bridge.emitBattery({ battery: 70, chargingStatus: 0, ringBattery: 40, ringChargingStatus: 0 });
  assert.deepEqual([f.battery.ring, f.battery.ringCharging], [40, false]);
  await f.controller.disconnect(); await f.render();
  assert.deepEqual([f.battery.ring, f.battery.ringCharging], [null, null]);
});

test('ring gestures fail closed until wear is confirmed, without gating temple input', async () => {
  const f = fixture();
  await f.connect();
  await f.hardware(0, 2);
  assert.equal(f.received.length, 0, 'unknown wear state blocks ring input');
  await f.hardware(0, 1);
  assert.equal(f.received.length, 1, 'temple input is unchanged');
  f.wear(true);
  await f.hardware(0, 2);
  assert.equal(f.received.length, 2, 'confirmed worn allows ring input');
  f.wear(false);
  await f.hardware(0, 2);
  assert.equal(f.received.length, 2, 'off-head blocks ring input');
  f.wear(true);
  f.bridge.emitState('retrying', 'Reconnecting');
  f.bridge.emitState('connected', 'Connected');
  await f.hardware(0, 2);
  assert.equal(f.received.length, 2, 'a reconnected transport requires a fresh worn report');
});

test('a ring gesture arriving before worn confirmation stays blocked if its queue runs later', async () => {
  const f = fixture();
  await f.connect();
  let unblock;
  f.controller.inputQueue = new Promise(resolve => { unblock = resolve; });
  f.bridge.emitRing({ kind: 'sys-event', containerName: '', eventType: 0, eventSource: 2,
    systemExitReasonCode: 0, frameId: 0 });
  f.wear(true);
  unblock();
  await f.render();
  assert.equal(f.received.length, 0);
});

test('a queued hold release cannot revive across an off-head then on-head transition', async () => {
  const f = fixture();
  await f.connect();
  f.wear(true);
  await f.hardware(9, 2);
  let unblock;
  f.controller.inputQueue = new Promise(resolve => { unblock = resolve; });
  f.bridge.emitRing({ kind: 'sys-event', containerName: '', eventType: 10, eventSource: 2,
    systemExitReasonCode: 0, frameId: 0 });
  f.wear(false);
  f.wear(true);
  unblock();
  await f.render();
  assert.deepEqual(f.received.map(event => event.type), ['long-press']);
  assert.equal(f.shell.isScreenOn(), false);
});

test('turning off the wear gate allows ring gestures while off-head', async () => {
  const f = fixture();
  f.settings.ringControlsOnlyWhileWorn = false;
  await f.connect();
  f.wear(false);
  await f.hardware(0, 2);
  assert.equal(f.received.length, 1);
});

test('taking the glasses off cancels an admitted ring hold without dispatching its release', async () => {
  const f = fixture();
  await f.connect();
  f.wear(true);
  await f.hardware(9, 2);
  assert.deepEqual(f.received.map(event => event.type), ['long-press']);
  f.wear(false);
  await f.render();
  assert.equal(f.shell.isScreenOn(), false, 'sleep cancels voice, overlays and hold timers without submitting a release');
  await f.hardware(10, 2);
  assert.deepEqual(f.received.map(event => event.type), ['long-press']);
});

test('enabling the wear gate while off-head cancels a ring hold admitted by the override', async () => {
  const f = fixture();
  f.settings.ringControlsOnlyWhileWorn = false;
  await f.connect();
  f.wear(false);
  await f.hardware(9, 2);
  f.settings.ringControlsOnlyWhileWorn = true;
  f.settingsChanged();
  await f.render();
  assert.equal(f.shell.isScreenOn(), false);
  await f.hardware(10, 2);
  assert.deepEqual(f.received.map(event => event.type), ['long-press']);
});

test('the charging case reading reaches the shell and keeps its level once the glasses leave the case', async () => {
  const f = fixture();
  await f.connect();
  f.wear(true);
  f.bridge.emitCase({ battery: 64, charging: true, docked: true });
  assert.deepEqual([f.battery.case, f.battery.caseCharging], [64, true]);
  await f.hardware(0, 2);
  assert.equal(f.received.length, 0, 'a docked case report invalidates a stale worn state');
  // Out of the case there is no level, and whether the case is on USB is unknown.
  f.bridge.emitCase({ battery: null, charging: false, docked: false });
  assert.deepEqual([f.battery.case, f.battery.caseCharging], [64, null]);
});

test('the switcher can open the Notifications window in the background, once, with a live surface', async () => {
  const f = fixture();
  await f.render();
  const opened = f.shellOptions.openNotificationsWindow();
  assert.equal(opened.opened, true);
  const [app] = f.inProcessApps;
  assert.equal(opened.window, app);
  assert.ok(f.registered.includes(app.window), 'registered with the shell for the switcher to foreground');
  // A frame painted at once (the shell foregrounds and repaints the window
  // straight away) lands on the surface configured ahead of it.
  void app.options.submitFrame([{ image: new images.GrayImage(640, 480, 90), x: 0, y: 0 }], 0, 1);
  await f.render();
  const surface = f.controller.display.surfaces.get('window:notifications');
  assert.ok(surface, 'surface configured');
  assert.equal(surface.pixels[0], 90);
  assert.equal(surface.visible, false, 'stays hidden until the shell foregrounds it');
  // Already open: the same window, nothing new created or registered.
  const registeredBefore = f.registered.length;
  const again = f.shellOptions.openNotificationsWindow();
  assert.deepEqual([again.opened, again.window, f.inProcessApps.length, f.registered.length], [false, app, 1, registeredBefore]);
  // Closed (the selection moved on): frames stop, and the next open makes a new window.
  app.options.removeSurface(); app.options.onClosed();
  void app.options.submitFrame([{ image: new images.GrayImage(640, 480, 90), x: 0, y: 0 }], 0, 2);
  await f.render();
  assert.equal(f.controller.display.surfaces.has('window:notifications'), false);
  assert.equal(f.shellOptions.openNotificationsWindow().opened, true);
  assert.equal(f.inProcessApps.length, 2);
});
