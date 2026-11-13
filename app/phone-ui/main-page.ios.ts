import { KeyboardInputViewModel } from './keyboard-input-view-model'
import { Application, Builder, Button, Color, Dialogs, Frame, GridLayout, Image, Label, Page, TabView, TabViewItem, TextView, type PropertyChangeData, type TouchGestureEventData, type View } from '@nativescript/core'
import { createCompanionPanels } from './companion-panels.ios'
import { isPreviewOnlyMode } from './onboarding-state'
import { isAutoReconnectSuppressed, resumeAutoReconnect, suppressAutoReconnect } from '../g2/reconnect-policy'
import { RemoteControlsViewModel } from './remote-controls-view-model'
import { IosPreviewController } from '../g2/ios-preview-controller'
import { PhoneGestureRecognizer } from './phone-gestures'
import { BleBandwidthMeter } from './ble-bandwidth-meter'
import { sampleBleTraffic } from '../native/ble-traffic'
import { glassesModelName, onAnySettingChanged, mirrorTouchSetting, showBleBandwidthSetting } from '../ui/dashboard-settings'
import { loadDeviceAddresses } from '../g2/device-addresses'
import { deviceAddressError } from '../g2/ios-peripheral-identity'
import { formatBatteryLine } from '../g2/glasses-display-state'
import { shell } from '../ui/shell/shell'

export interface CompanionGeometry {
  innerWidth: number
  innerHeight: number
  mirrorWidth: number
  mirrorHeight: number
  showPreview: boolean
}

export function companionGeometry(width: number, height: number, landscape: boolean): CompanionGeometry {
  const innerWidth = Math.max(0, width - (landscape ? 24 : 32))
  const innerHeight = Math.max(0, height - (landscape ? 8 : 10))
  const sectionGap = 12
  const previewHeading = 19
  const remoteHeight = 263
  const remoteWidth = 345
  const widthBudget = landscape ? Math.max(0, innerWidth - remoteWidth - sectionGap) : innerWidth
  const heightBudget = landscape
    ? Math.max(0, innerHeight - previewHeading)
    : Math.max(0, innerHeight - remoteHeight - previewHeading - sectionGap)
  const mirrorHeight = Math.min(widthBudget * 3 / 4, heightBudget)
  const showPreview = mirrorHeight >= 72
  return {
    innerWidth,
    innerHeight,
    mirrorWidth: showPreview ? mirrorHeight * 4 / 3 : 0,
    mirrorHeight: showPreview ? mirrorHeight : 0,
    showPreview,
  }
}

export function createMainPage(): Page {
  const page = new Page()
  page.actionBarHidden = true
  page.className = 'main-page'
  page.iosOverflowSafeAreaEnabled = false
  const root = new GridLayout()
  root.rows = '*'
  page.content = root
  const glassesView = new GridLayout()
  glassesView.rows = 'auto,auto,*'
  glassesView.className = 'glasses-destination'
  const header = new GridLayout()
  header.columns = '*,auto,auto,auto,auto'; header.className = 'main-header'
  const title = new Label()
  title.text = 'Glasses'; title.className = 'action-bar-title'
  header.addChild(title)
  const compactState = new Label()
  compactState.text = 'Preview · Battery levels unavailable'
  compactState.className = 'compact-device-state'; compactState.visibility = 'collapse'
  compactState.verticalAlignment = 'middle'; compactState.textWrap = true
  compactState.accessibilityIdentifier = 'compact-device-state'
  compactState.on('tap', () => { void openDevices() })
  GridLayout.setColumn(compactState, 1); header.addChild(compactState)
  // The foreground EvenHub app's icon, which opens its phone UI. UIImageView
  // ignores padding, so a wrapper supplies Android's wider tap target.
  const appIconButton = new GridLayout()
  appIconButton.className = 'action-bar-app-icon'; appIconButton.verticalAlignment = 'middle'
  appIconButton.visibility = 'collapse'; appIconButton.accessible = true
  const appIcon = new Image()
  appIcon.width = 21; appIcon.height = 21
  appIconButton.addChild(appIcon)
  let phoneUiWindowId: string | null = null
  appIconButton.on('tap', () => { if (phoneUiWindowId) controller.showEvenHubPhoneUi(phoneUiWindowId) })
  GridLayout.setColumn(appIconButton, 2); header.addChild(appIconButton)
  // Android's warning triangle: shown while the glasses report firmware Faceclaw can't run.
  const warning = new Label()
  warning.text = '\u26A0\uFE0F'; warning.className = 'action-bar-warning'
  warning.accessibilityLabel = 'Attention needed'; warning.verticalAlignment = 'middle'
  warning.visibility = 'collapse'
  warning.on('tap', () => { void showFirmwareWarning() })
  GridLayout.setColumn(warning, 3); header.addChild(warning)
  const overflow = new Button()
  overflow.text = '⋮'; overflow.accessibilityLabel = 'More options'; overflow.className = 'overflow-button'
  overflow.on('tap', () => openMenu())
  GridLayout.setColumn(overflow, 4); header.addChild(overflow); glassesView.addChild(header)
  const deviceCard = new GridLayout()
  deviceCard.rows = 'auto,auto'; deviceCard.columns = '*,auto'
  deviceCard.className = 'device-status-card'; deviceCard.accessible = true
  deviceCard.accessibilityRole = 'button'; deviceCard.accessibilityLabel = 'Open glasses connection details'
  deviceCard.on('tap', () => { void openDevices() })
  const deviceName = new Label()
  deviceName.text = glassesModelName(); deviceName.className = 'device-name'
  const state = new Label()
  state.text = 'Preview'; state.className = 'device-connection-state'
  state.verticalAlignment = 'middle'; GridLayout.setColumn(state, 1)
  const batterySummary = new Label()
  batterySummary.text = 'Battery levels unavailable'; batterySummary.className = 'device-battery-summary'
  batterySummary.textWrap = true; batterySummary.accessibilityIdentifier = 'device-battery-summary'
  GridLayout.setRow(batterySummary, 1); GridLayout.setColumnSpan(batterySummary, 2)
  deviceCard.addChild(deviceName); deviceCard.addChild(state); deviceCard.addChild(batterySummary)
  GridLayout.setRow(deviceCard, 1); glassesView.addChild(deviceCard)
  const body = new GridLayout()
  body.className = 'glasses-content'; body.rows = 'auto,*'; body.columns = '*'
  GridLayout.setRow(body, 2); glassesView.addChild(body)
  const previewSection = new GridLayout()
  previewSection.rows = 'auto,*'; previewSection.className = 'glasses-section preview-section'
  const previewTitle = new Label()
  previewTitle.text = 'On your glasses'; previewTitle.className = 'companion-section-title'
  previewSection.addChild(previewTitle)
  const mirror = new Image()
  mirror.stretch = 'fill'; mirror.backgroundColor = new Color('black')
  mirror.accessibilityIdentifier = 'glasses-preview'
  mirror.accessibilityLabel = 'Interactive glasses screen preview'
  mirror.horizontalAlignment = 'left'; mirror.verticalAlignment = 'middle'; mirror.className = 'glasses-preview'
  GridLayout.setRow(mirror, 1); previewSection.addChild(mirror); body.addChild(previewSection)
  // The iOS presentation keeps the shared remote model and gesture bindings.
  const model = new RemoteControlsViewModel()
  const controlsSection = new GridLayout()
  controlsSection.rows = 'auto,*'; controlsSection.className = 'glasses-section remote-section'
  const remoteTitle = new Label()
  remoteTitle.text = 'REMOTE'; remoteTitle.className = 'section-eyebrow'
  controlsSection.addChild(remoteTitle)
  const controls = new GridLayout()
  const remote = Builder.load('~/phone-ui/remote-controls')
  remote.bindingContext = model
  controls.addChild(remote); GridLayout.setRow(controls, 1); controlsSection.addChild(controls)
  GridLayout.setRow(controlsSection, 1); body.addChild(controlsSection)
  const keyboardModel = new KeyboardInputViewModel()
  const keyboardPanel = Builder.load('~/phone-ui/keyboard-input-panel')
  keyboardPanel.bindingContext = keyboardModel
  GridLayout.setRow(keyboardPanel, 0)
  let companionTabs: TabView | null = null
  let focusTimer: ReturnType<typeof setTimeout> | null = null
  // The Settings tab's battery row. iOS reports charging sessions as
  // connected, so "connected" is the whole live-link condition here.
  let glassesLinked = false
  const refreshBatteryLine = () => {
    const line = formatBatteryLine(shell.getBatteryLevels(), glassesLinked, glassesModelName())
    model.batteryLine = line
    batterySummary.text = line || 'Battery levels unavailable'
    compactState.text = `${state.text} · ${batterySummary.text}`
  }
  const keyboardField = () => keyboardPanel.getViewById<TextView>('keyboardInputField')
  let foreground = false, lastConnectionPhase = ''
  let refreshCompanionPanels = () => {}
  const controller = new IosPreviewController((image, label) => {
    mirror.imageSource = image; model.set('padFocusLine', label)
  }, message => {
    void Dialogs.alert({ title: 'Faceclaw', message, okButtonText: 'OK' })
  }, connection => {
    const phaseChanged = connection.phase !== lastConnectionPhase
    lastConnectionPhase = connection.phase
    state.text = ({ connected: 'Connected', disconnected: 'Preview', connecting: 'Connecting',
      retrying: 'Reconnecting', disconnecting: 'Disconnecting', error: 'Failed' })[connection.phase]
    warning.visibility = connection.firmwareWarning ? 'visible' : 'collapse'
    glassesLinked = connection.phase === 'connected'; refreshBatteryLine()
    if (foreground && phaseChanged) refreshCompanionPanels()
  }, session => {
    keyboardModel.setSession(session)
    controls.visibility = session ? 'collapse' : 'visible'
    if (focusTimer !== null) clearTimeout(focusTimer)
    focusTimer = null
    if (session) {
      if (companionTabs) companionTabs.selectedIndex = 0
      focusTimer = setTimeout(() => { focusTimer = null; keyboardField()?.focus() }, 0)
    } else keyboardField()?.dismissSoftInput()
  }, button => {
    phoneUiWindowId = button?.icon ? button.windowId : null
    appIcon.imageSource = button?.icon ?? null
    appIconButton.visibility = phoneUiWindowId ? 'visible' : 'collapse'
    appIconButton.accessibilityLabel = button ? `Open ${button.title} on phone` : ''
  })
  async function navigateDevicePage(moduleName: string, context?: object): Promise<void> {
    suppressAutoReconnect()
    await controller.disconnect()
    Frame.topmost()?.navigate({ moduleName, context })
  }
  function openMenu(): void {
    const connected = ['connected', 'connecting', 'retrying'].includes(controller.connectionState?.phase ?? '')
    const configured = !deviceAddressError(loadDeviceAddresses())
    const menu = UIAlertController.alertControllerWithTitleMessagePreferredStyle(null, null, UIAlertControllerStyle.ActionSheet)
    const add = (label: string, action: (() => void) | null) => {
      const item = UIAlertAction.actionWithTitleStyleHandler(label, UIAlertActionStyle.Default, () => {
        // Finish dismissal before presenting a share sheet or another page.
        menu.dismissViewControllerAnimatedCompletion(true, () => action?.())
      })
      item.enabled = action !== null
      menu.addAction(item)
    }
    if (configured) add(connected ? 'Disconnect' : 'Connect', () => {
      if (connected) { suppressAutoReconnect(); void controller.disconnect() }
      else { resumeAutoReconnect(); void controller.connect(false, true) }
    })
    add('Pair glasses', () => { void navigateDevicePage('phone-ui/onboarding-unpair-page') })
    add('Permissions', () => Frame.topmost()?.navigate({ moduleName: 'phone-ui/permissions-page' }))
    // Keep Android's menu order/text. These services still require Android;
    // disabled items make the platform limitation visible without dead actions.
    add('Conversations', null)
    add('Take screenshot', mirror.imageSource ? () => {
      const share = UIActivityViewController.alloc().initWithActivityItemsApplicationActivities([mirror.imageSource.ios], null)
      if (share.popoverPresentationController) {
        share.popoverPresentationController.sourceView = overflow.ios
        share.popoverPresentationController.sourceRect = overflow.ios.bounds
      }
      page.ios.presentViewControllerAnimatedCompletion(share, true, null)
    } : null)
    add('Record screen', null)
    if (configured) add('Uninstall custom firmware', () => {
      void navigateDevicePage('phone-ui/onboarding-flash-page', { mode: 'uninstall', fromOnboarding: false })
    })
    menu.addAction(UIAlertAction.actionWithTitleStyleHandler('Cancel', UIAlertActionStyle.Cancel, null))
    if (menu.popoverPresentationController) {
      menu.popoverPresentationController.sourceView = overflow.ios
      menu.popoverPresentationController.sourceRect = overflow.ios.bounds
    }
    page.ios.presentViewControllerAnimatedCompletion(menu, true, null)
  }
  async function showFirmwareWarning(): Promise<void> {
    const message = controller.connectionState?.firmwareWarning
    if (!message) return
    const install = await Dialogs.confirm({ title: 'Attention needed', message,
      okButtonText: 'Install custom firmware', cancelButtonText: 'Close' })
    if (install) await navigateDevicePage('phone-ui/onboarding-flash-page', { mode: 'install', fromOnboarding: false })
  }
  async function openDevices(): Promise<void> {
    const connected = ['connected', 'connecting', 'retrying'].includes(controller.connectionState?.phase ?? '')
    const choice = await Dialogs.action({ title: 'Connection status', message: controller.connectionState?.status ?? 'Preview only', cancelButtonText: 'Cancel',
      actions: ['Pair glasses', 'Configure devices', connected ? 'Disconnect' : 'Connect', 'Check firmware', 'Install custom firmware', 'Uninstall custom firmware', 'Connection details'] })
    if (['Pair glasses', 'Configure devices', 'Check firmware', 'Install custom firmware', 'Uninstall custom firmware'].includes(choice)) {
      suppressAutoReconnect()
      await controller.disconnect()
      if (choice === 'Pair glasses') {
        Frame.topmost()?.navigate({ moduleName: 'phone-ui/onboarding-unpair-page' })
      } else if (choice === 'Configure devices') {
        Frame.topmost()?.navigate({ moduleName: 'phone-ui/config-page', context: { onboarding: isPreviewOnlyMode() } })
      } else if (choice === 'Check firmware') {
        Frame.topmost()?.navigate({ moduleName: 'phone-ui/onboarding-firmware-check-page' })
      } else {
        Frame.topmost()?.navigate({ moduleName: 'phone-ui/onboarding-flash-page', context: { mode: choice === 'Uninstall custom firmware' ? 'uninstall' : 'install', fromOnboarding: false } })
      }
    } else if (choice === 'Connect') { resumeAutoReconnect(); await controller.connect(false, true) }
    else if (choice === 'Disconnect') { suppressAutoReconnect(); await controller.disconnect() }
    else if (choice === 'Connection details') await Dialogs.alert({ title: 'Connection details', message: controller.connectionDetails, okButtonText: 'OK' })
  }
  const panels = createCompanionPanels({
    launchApp: (id, params) => controller.launchApp(id, params),
    openDevices,
    openPermissions: () => { Frame.topmost()?.navigate({ moduleName: 'phone-ui/permissions-page' }) },
    openAdvanced: openMenu,
  })
  refreshCompanionPanels = () => panels.refresh()
  companionTabs = new TabView()
  companionTabs.className = 'companion-tabs'
  companionTabs.accessibilityIdentifier = 'companion-tabs'
  companionTabs.items = [
    Object.assign(new TabViewItem(), { title: 'Glasses', view: glassesView }),
    Object.assign(new TabViewItem(), { title: 'Health', view: panels.health }),
    Object.assign(new TabViewItem(), { title: 'Apps', view: panels.apps }),
    Object.assign(new TabViewItem(), { title: 'Settings', view: panels.settings }),
  ]
  let previousCompanionTab = companionTabs.selectedIndex
  companionTabs.on('selectedIndexChanged', () => {
    if (previousCompanionTab === 3 && companionTabs?.selectedIndex !== 3) panels.clearSettings()
    previousCompanionTab = companionTabs?.selectedIndex ?? 0
    panels.refresh()
  })
  root.addChild(companionTabs)
  root.addChild(keyboardPanel)
  const watchInput = new PhoneGestureRecognizer(gesture => controller.gesture(gesture, 'watch'))
  const ringInput = new PhoneGestureRecognizer(gesture => controller.gesture(gesture, 'ring'))
  const mirrorInput = new PhoneGestureRecognizer((gesture, x, y) => {
    if (!mirrorTouchSetting.get()) return
    const size = mirror.getActualSize()
    if (size.width > 0 && size.height > 0) controller.gesture(gesture, 'mirror', x / size.width, y / size.height)
  })
  const touch = (recognizer: PhoneGestureRecognizer) => (event: TouchGestureEventData) => {
    if (!['down', 'move', 'up', 'cancel'].includes(event.action)) return
    recognizer.touch({ action: event.action as 'down' | 'move' | 'up' | 'cancel', x: event.getX(), y: event.getY(), pointers: event.getPointerCount() })
  }
  model.set('onPadTouch', touch(watchInput))
  model.set('onRingPadTouch', touch(ringInput))
  model.set('onSyntheticMicTap', () => controller.startVoiceInput())
  model.set('onKeyboardTap', () => { controller.typeIntoApp() })
  mirror.on('touch', touch(mirrorInput))
  const cancelGestures = () => { watchInput.cancel(); ringInput.cancel(); mirrorInput.cancel() }
  model.on('propertyChange', (args: PropertyChangeData) => {
    if (args.propertyName === 'watchTabVisibility') cancelGestures()
  })
  let controlsLayoutTimer: ReturnType<typeof setTimeout> | null = null
  model.set('onControlsContentLayoutChanged', (args: { object: View }) => {
    if (controlsLayoutTimer !== null) clearTimeout(controlsLayoutTimer)
    // Defer binding updates out of UIKit's layout pass.
    controlsLayoutTimer = setTimeout(() => {
      controlsLayoutTimer = null
      const { width, height } = args.object.getActualSize()
      model.set('watchFaceWidth', Math.min(345, Math.max(0, width)))
      model.set('watchFaceHeight', Math.min(230, Math.max(0, height - 2)))
      model.set('ringTouchpadHeight', Math.min(250, Math.max(0, height - 2)))
    }, 0)
  })
  const bandwidth = new Label()
  bandwidth.accessibilityIdentifier = 'ble-bandwidth-indicator'
  bandwidth.className = 'ble-bandwidth-indicator'; bandwidth.isUserInteractionEnabled = false
  bandwidth.horizontalAlignment = 'center'; bandwidth.verticalAlignment = 'bottom'
  bandwidth.visibility = 'collapse'
  GridLayout.setRow(bandwidth, 0); root.addChild(bandwidth)
  const bandwidthMeter = new BleBandwidthMeter()
  let bandwidthTimer: ReturnType<typeof setInterval> | null = null
  function stopBandwidth(): void {
    if (bandwidthTimer !== null) clearInterval(bandwidthTimer)
    bandwidthTimer = null; bandwidthMeter.reset()
  }
  function syncBandwidth(): void {
    if (!foreground) { stopBandwidth(); return }
    const enabled = showBleBandwidthSetting.get()
    bandwidth.visibility = enabled ? 'visible' : 'collapse'
    if (!enabled) { stopBandwidth(); return }
    if (bandwidthTimer !== null) return
    const refresh = () => { bandwidth.text = bandwidthMeter.sample(sampleBleTraffic(), Date.now()) }
    refresh(); bandwidthTimer = setInterval(refresh, 1000)
  }
  let lastLayout = ''
  function layout(): void {
    const size = body.getActualSize()
    if (size.width <= 0 || size.height <= 0) return
    const landscape = root.getActualSize().width > root.getActualSize().height
    const key = `${size.width}:${size.height}:${landscape}`
    if (key === lastLayout) return
    lastLayout = key; cancelGestures()
    deviceCard.visibility = landscape ? 'collapse' : 'visible'
    compactState.visibility = landscape ? 'visible' : 'collapse'
    body.className = landscape ? 'glasses-content landscape-layout' : 'glasses-content'
    root.className = landscape ? 'main-landscape' : ''
    const geometry = companionGeometry(size.width, size.height, landscape)
    previewSection.visibility = geometry.showPreview ? 'visible' : 'collapse'
    body.rows = landscape || !geometry.showPreview ? '*' : 'auto,*'
    body.columns = landscape && geometry.showPreview ? '*,345' : '*'
    GridLayout.setRow(previewSection, 0); GridLayout.setColumn(previewSection, 0)
    GridLayout.setRow(controlsSection, landscape || !geometry.showPreview ? 0 : 1)
    GridLayout.setColumn(controlsSection, landscape && geometry.showPreview ? 1 : 0)
    mirror.width = geometry.mirrorWidth; mirror.height = geometry.mirrorHeight
  }
  // iOS emits layoutChanged inside its layout pass. Defer mutations so
  // NativeScript does not clear our new layout request at the end of that pass.
  let layoutTimer: ReturnType<typeof setTimeout> | null = null
  body.on('layoutChanged', () => {
    if (layoutTimer !== null) return
    layoutTimer = setTimeout(() => { layoutTimer = null; layout() }, 0)
  })
  const pause = () => {
    foreground = false; stopBandwidth()
    panels.clearHealth()
    if (layoutTimer !== null) clearTimeout(layoutTimer)
    layoutTimer = null
    if (controlsLayoutTimer !== null) clearTimeout(controlsLayoutTimer)
    controlsLayoutTimer = null
    if (focusTimer !== null) clearTimeout(focusTimer)
    focusTimer = null
    keyboardField()?.dismissSoftInput()
    cancelGestures(); controller.pause()
  }
  const resume = () => { foreground = true; panels.refresh(); controller.resume(); syncBandwidth() }
  let keyboardObserver: any = null
  let offSettings: (() => void) | null = null
  let offBattery: (() => void) | null = null
  function applyTabSymbols(): void {
    const nativeItems = companionTabs?.ios?.tabBar?.items
    const imageType = (globalThis as any).UIImage
    if (!nativeItems || !imageType?.systemImageNamed) return
    ;['eyeglasses', 'heart', 'square.grid.2x2', 'gearshape'].forEach((name, index) => {
      const item = nativeItems.objectAtIndex ? nativeItems.objectAtIndex(index) : nativeItems[index]
      if (item) item.image = imageType.systemImageNamed(name)
    })
  }
  page.on('loaded', () => {
    if (!keyboardObserver) keyboardObserver = NSNotificationCenter.defaultCenter.addObserverForNameObjectQueueUsingBlock(
      UIKeyboardWillChangeFrameNotification, null, NSOperationQueue.mainQueue, notification => {
        const frame = notification.userInfo.objectForKey(UIKeyboardFrameEndUserInfoKey).CGRectValue
        const view = page.ios.view
        const local = view.convertRectFromView(frame, null)
        root.paddingBottom = Math.max(0, view.bounds.size.height - local.origin.y - view.safeAreaInsets.bottom)
      })
    Application.on(Application.suspendEvent, pause); Application.on(Application.resumeEvent, resume)
    offSettings?.(); offSettings = onAnySettingChanged(() => {
      deviceName.text = glassesModelName(); model.refreshDisplayControls(); panels.refresh(); syncBandwidth()
    })
    offBattery?.(); offBattery = shell.onBatteryLevelsChanged(refreshBatteryLine)
    model.refreshDisplayControls(); refreshBatteryLine(); panels.refresh(); applyTabSymbols(); resume()
    if (!isPreviewOnlyMode() && !isAutoReconnectSuppressed() && !deviceAddressError(loadDeviceAddresses())) void controller.connect()
  })
  page.on('unloaded', () => {
    if (keyboardObserver) NSNotificationCenter.defaultCenter.removeObserver(keyboardObserver)
    keyboardObserver = null
    root.paddingBottom = 0
    pause(); offSettings?.(); offSettings = null; offBattery?.(); offBattery = null
    Application.off(Application.suspendEvent, pause); Application.off(Application.resumeEvent, resume)
  })
  return page
}

export const createPage = createMainPage
