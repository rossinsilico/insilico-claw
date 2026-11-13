const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

function load(file, context) {
  const sandbox = { exports: {}, ...context }
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText
  vm.runInNewContext(output, sandbox)
  return sandbox.exports
}

test('iOS companion tabs retain one live glasses controller and return keyboard input to Glasses', () => {
  const views = []
  const appEvents = new Map()
  const controllerCalls = { constructed: 0, resume: 0, pause: 0, connect: 0 }
  const panelCalls = { refresh: 0, clear: 0, clearSettings: 0 }
  let keyboardSessionChanged, connectionChanged

  class View {
    constructor() { this.children = []; this.events = new Map(); views.push(this) }
    on(event, handler) { this.events.set(event, handler) }
    addChild(view) { this.children.push(view) }
    set(key, value) { this[key] = value }
    getActualSize() { return { width: 390, height: 844 } }
    getViewById() { return { focus() {}, dismissSoftInput() {} } }
    static setRow() {}
    static setColumn() {}
    static setColumnSpan() {}
  }
  class TabView extends View {
    constructor() { super(); this.items = []; this.selectedIndex = 0 }
  }
  class TabViewItem {
    constructor() { this.title = ''; this.view = null }
  }
  class Controller {
    constructor(_frame, _alert, _connection, keyboard) {
      controllerCalls.constructed++
      keyboardSessionChanged = keyboard
      connectionChanged = _connection
      this.connectionState = { phase: 'disconnected', status: 'Preview only' }
    }
    resume() { controllerCalls.resume++ }
    pause() { controllerCalls.pause++ }
    connect() { controllerCalls.connect++; return Promise.resolve() }
    disconnect() { return Promise.resolve() }
    typeIntoApp() {}
    startVoiceInput() {}
    gesture() {}
  }

  const core = {
    Application: {
      suspendEvent: 'suspend', resumeEvent: 'resume',
      on: (event, handler) => appEvents.set(event, handler),
      off: event => appEvents.delete(event),
    },
    Builder: { load: () => new View() },
    Button: View, Color: class {}, Dialogs: {}, Frame: { topmost: () => null },
    GridLayout: View, Image: View, Label: View, Page: View, StackLayout: View,
    TabView, TabViewItem, TextView: View,
  }
  const modules = {
    '@nativescript/core': core,
    './keyboard-input-view-model': { KeyboardInputViewModel: class { setSession() {} } },
    './remote-controls-view-model': { RemoteControlsViewModel: class extends View { refreshDisplayControls() {} } },
    './companion-panels.ios': {
      createCompanionPanels: () => ({ health: new View(), apps: new View(), settings: new View(),
        refresh() { panelCalls.refresh++ }, clearHealth() { panelCalls.clear++ },
        clearSettings() { panelCalls.clearSettings++ } }),
    },
    './phone-gestures': { PhoneGestureRecognizer: class { touch() {}; cancel() {} } },
    './ble-bandwidth-meter': { BleBandwidthMeter: class { reset() {}; sample() { return '' } } },
    '../native/ble-traffic': { sampleBleTraffic: () => ({ messages: 0, bytes: 0, frames: 0 }) },
    '../g2/ios-preview-controller': { IosPreviewController: Controller },
    '../g2/reconnect-policy': { isAutoReconnectSuppressed: () => false, resumeAutoReconnect() {}, suppressAutoReconnect() {} },
    '../ui/dashboard-settings': {
      glassesModelName: () => 'G2', mirrorTouchSetting: { get: () => true },
      showBleBandwidthSetting: { get: () => false }, onAnySettingChanged: () => () => {},
    },
    '../g2/device-addresses': { loadDeviceAddresses: () => ({ right: 'right', left: 'left' }) },
    '../g2/ios-peripheral-identity': { deviceAddressError: () => null },
    '../g2/glasses-display-state': { formatBatteryLine: () => 'G2 75%' },
    '../ui/shell/shell': {
      shell: {
        getBatteryLevels: () => ({ headset: 75, headsetCharging: false, case: 80, caseCharging: false, ring: 70, ringCharging: false }),
        onBatteryLevelsChanged: () => () => {},
      },
    },
    './onboarding-state': { isPreviewOnlyMode: () => false },
  }

  const { createMainPage } = load('app/phone-ui/main-page.ios.ts', {
    require: id => modules[id] ?? {},
    NSNotificationCenter: { defaultCenter: { addObserverForNameObjectQueueUsingBlock: () => ({}), removeObserver() {} } },
    UIKeyboardWillChangeFrameNotification: 'keyboard', UIKeyboardFrameEndUserInfoKey: 'frame',
    NSOperationQueue: { mainQueue: {} }, setTimeout: () => 1, clearTimeout() {},
    setInterval: () => 1, clearInterval() {},
  })

  const page = createMainPage()
  const tabs = views.find(view => view instanceof TabView)
  assert.ok(tabs, 'the companion shell should expose native bottom navigation')
  assert.deepEqual(Array.from(tabs.items, item => item.title), ['Glasses', 'Health', 'Apps', 'Settings'])
  assert.equal(controllerCalls.constructed, 1)

  page.events.get('loaded')()
  const lifecycleAfterLoad = { ...controllerCalls }
  tabs.selectedIndex = 3
  tabs.events.get('selectedIndexChanged')?.({ object: tabs })
  assert.equal(panelCalls.clearSettings, 0, 'opening Settings must not cancel its actions')
  tabs.selectedIndex = 2
  tabs.events.get('selectedIndexChanged')?.({ object: tabs })
  assert.equal(panelCalls.clearSettings, 1, 'leaving Settings must cancel pending native settings actions')
  assert.deepEqual(controllerCalls, lifecycleAfterLoad, 'tab changes must not reconnect, pause, or recreate the glasses session')

  keyboardSessionChanged({ appId: 'notes' })
  assert.equal(tabs.selectedIndex, 0, 'typing into an on-glasses app should restore the Glasses destination')
  const beforeReconnect = panelCalls.refresh
  connectionChanged({ phase: 'connecting' })
  connectionChanged({ phase: 'connected' })
  assert.equal(panelCalls.refresh, beforeReconnect + 2, 'foreground reconnects must rebind the visible Health panel')
  connectionChanged({ phase: 'connected' })
  assert.equal(panelCalls.refresh, beforeReconnect + 2, 'frame/status updates must not repeatedly repaint all panels')
  appEvents.get('suspend')()
  connectionChanged({ phase: 'retrying' })
  assert.equal(panelCalls.refresh, beforeReconnect + 2, 'background connection updates must not repaint cleared health data')
  const pauses = controllerCalls.pause
  page.events.get('unloaded')()
  assert.equal(controllerCalls.pause, pauses + 1)
})

test('companion geometry keeps the preview inside padded portrait and landscape remote budgets', () => {
  const { companionGeometry } = load('app/phone-ui/main-page.ios.ts', { require: () => ({}) })
  const remoteHeight = 263
  const previewHeading = 19
  const sectionGap = 12

  // 393x852 compact portrait: the measured body is 393x460 after native
  // header, device status, safe areas, and the bottom tab bar.
  const portrait = companionGeometry(393, 460, false)
  assert.equal(portrait.innerWidth, 361)
  assert.ok(portrait.mirrorWidth <= portrait.innerWidth)
  assert.ok(previewHeading + portrait.mirrorHeight + sectionGap + remoteHeight <= portrait.innerHeight)
  assert.equal(portrait.mirrorWidth / portrait.mirrorHeight, 4 / 3)

  // 844x390 landscape: the full device card is compacted into the header,
  // leaving a 283pt body below the header and native tab bar.
  const landscape = companionGeometry(844, 283, true)
  assert.equal(landscape.innerWidth, 820)
  assert.ok(landscape.mirrorWidth <= landscape.innerWidth - 345 - sectionGap)
  assert.ok(previewHeading + landscape.mirrorHeight <= landscape.innerHeight)
  assert.ok(remoteHeight <= landscape.innerHeight)
  assert.equal(landscape.mirrorWidth / landscape.mirrorHeight, 4 / 3)
})
