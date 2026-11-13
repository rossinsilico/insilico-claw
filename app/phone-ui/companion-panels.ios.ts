import { Button, Dialogs, GridLayout, Image, ImageSource, Label, ScrollView, StackLayout, type View } from '@nativescript/core'
import { ALL_APPS } from '../apps/all-apps'
import type { AppLaunchParams } from '../apps/app-definition'
import { launcherEntries } from '../apps/launcher'
import { dailySummary, nextBucketStart } from '../health/health-derive'
import { hasLiveData, isFixtureData } from '../health/health-seed'
import { healthStore } from '../health/health-store-files'
import { startOfLocalDay } from '../health/health-types'
import { buildR1HealthKitExport, buildR1SleepHealthKitExport } from '../health/healthkit-export'
import { isAutomaticR1HealthSyncEnabled, setAutomaticR1HealthSyncEnabled, syncAutomaticR1Health } from '../health/healthkit-sync.ios'
import { iosRingBackgroundStatus } from '../health/ring-session.ios'
import { requestFreshPull } from '../health/health-live'
import { isAppleHealthAvailable, requestAppleHealthAccess, readAppleHealthSummary, writeR1HealthSamples, type AppleHealthSummary } from '../native/apple-health'
import { FaceclawCommunicatorBridge } from '../native/faceclaw-communicator.ios'
import { getBooleanSetting, setBooleanSetting } from '../native/settings-store'
import { isHealthSharingAllowed, setHealthSharingDestination } from '../assistant/health-access'
import * as settings from '../ui/dashboard-settings'
import { phoneSettingsSections } from '../ui/dashboard/settings-menus'
import type { MenuItem } from '../ui/menu'
import { shell } from '../ui/shell/shell'
import { FACECLAW_VERSION } from '../version'
import { cancelPhoneSettingsActions, phoneSettingsValue, runPhoneSettingsAction } from './phone-settings-actions.ios'

type PanelActions = {
  launchApp(id: string, params?: AppLaunchParams): Promise<void>
  openDevices(): Promise<void>
  openPermissions(): void
  openAdvanced(): void
}

type EditableSetting = settings.ConfigSettingBoolean | settings.ConfigSettingEnum<string> | settings.ConfigSettingString

function text(value: string, className: string, style = UIFontTextStyleBody): Label {
  const label = new Label()
  label.text = value
  label.textTransform = 'none'
  label.letterSpacing = 0
  label.className = className
  label.textWrap = true
  label.on('loaded', () => {
    label.ios.font = UIFont.preferredFontForTextStyle(style)
    label.ios.adjustsFontForContentSizeCategory = true
  })
  return label
}

function panel(): { view: ScrollView; content: StackLayout } {
  const view = new ScrollView()
  view.className = 'companion-scroll'
  const content = new StackLayout()
  content.className = 'companion-content'
  view.content = content
  return { view, content }
}

function group(content: StackLayout, title: string): StackLayout {
  content.addChild(text(title, 'companion-section-title', UIFontTextStyleHeadline))
  const rows = new StackLayout()
  rows.className = 'companion-group'
  content.addChild(rows)
  return rows
}

function row(parent: StackLayout, title: string, value: string, action?: () => void, symbol?: string): GridLayout {
  const item = new GridLayout()
  item.columns = symbol ? '28,*,120' : '*,120'
  item.className = 'companion-row'
  item.minHeight = 56
  const label = text(title, 'companion-row-title')
  const valueLabel = text(value, 'companion-row-value', UIFontTextStyleSubheadline)
  const labelColumn = symbol ? 1 : 0
  GridLayout.setColumn(label, labelColumn)
  GridLayout.setColumn(valueLabel, labelColumn + 1)
  valueLabel.textAlignment = 'right'
  valueLabel.verticalAlignment = 'middle'
  label.verticalAlignment = 'middle'
  item.addChild(label)
  item.addChild(valueLabel)
  if (symbol) {
    const image = new Image()
    image.width = 21; image.height = 24
    image.verticalAlignment = 'middle'
    image.className = 'companion-symbol'
    image.imageSource = ImageSource.fromSystemImageSync(symbol)
    image.accessible = false
    item.addChild(image)
  }
  item.accessible = true
  item.accessibilityLabel = [title, value].filter(Boolean).join(', ')
  if (action) {
    item.accessibilityRole = 'button'
    item.on('tap', action)
  }
  parent.addChild(item)
  return item
}

async function report(action: () => void | Promise<void>): Promise<void> {
  try { await action() }
  catch (error) {
    await Dialogs.alert({ title: 'Couldn’t complete that action', message: error instanceof Error ? error.message : String(error), okButtonText: 'OK' })
  }
}

function displaySetting(setting: EditableSetting): string {
  if (setting instanceof settings.ConfigSettingString) return setting.get() ? 'Saved' : 'Not set'
  return setting.displayValue()
}

export async function editCompanionSetting(setting: EditableSetting): Promise<boolean> {
  if (setting instanceof settings.ConfigSettingBoolean) {
    setting.toggle()
  } else if (setting instanceof settings.ConfigSettingEnum) {
    const values = setting.values.filter(value => !setting.isDisabled(value))
    const labels = values.map(value => setting.displayValue(value))
    const answer = await Dialogs.action({ title: setting.label, message: setting.description, actions: labels, cancelButtonText: 'Cancel' })
    const index = labels.indexOf(answer)
    if (index < 0) return false
    const value = values[index]!
    if (setting.isDisabled(value)) return false
    setting.set(value)
  } else {
    const answer = await Dialogs.prompt({ title: setting.editorTitle, message: setting.description,
      defaultText: setting.get(), inputType: setting.inputKind,
      okButtonText: 'Save', cancelButtonText: 'Cancel' })
    if (!answer.result) return false
    const error = setting.validationError(answer.text)
    if (error) {
      await Dialogs.alert({ title: 'Check this value', message: error, okButtonText: 'OK' })
      return false
    }
    setting.set(answer.text)
  }
  shell.noteUserActivity()
  return true
}

export function createCompanionPanels(actions: PanelActions): { health: View; apps: View; settings: View; refresh(): void; clearHealth(): void; clearSettings(): void } {
  const health = panel(), apps = panel(), preferences = panel()
  let appleSummary: AppleHealthSummary | null = null
  let healthBusy = false, healthGeneration = 0
  let cancelHealthRead: (() => void) | null = null
  let advancedHealthExpanded = false, syncRequested = false
  let healthBridge: FaceclawCommunicatorBridge | null = null
  let healthBridgeGeneration = -1
  let stopHealthBridge: (() => void) | null = null
  function renderItems(rows: StackLayout, items: MenuItem[]): void {
    for (const item of items) {
      if (item.phone?.kind === 'submenu') {
        renderItems(rows, item.phone.items())
        continue
      }
      if (!item.phone) continue
      const disabled = typeof item.disabled === 'function' ? item.disabled() : Boolean(item.disabled)
      let value = phoneSettingsValue(item)
      let action: (() => void) | undefined
      if (item.phone.kind === 'setting') {
        const setting = item.phone.setting as EditableSetting
        value = item.phone.displayValue?.() ?? displaySetting(setting)
        let rendered: GridLayout
        if (!disabled) action = () => { void report(async () => {
          if (await editCompanionSetting(setting)) {
            const current = item.phone?.kind === 'setting' ? item.phone.displayValue?.() ?? displaySetting(setting) : displaySetting(setting)
            ;(rendered.getChildAt(1) as Label).text = current
            rendered.accessibilityLabel = `${item.label}, ${current}`
            refreshSettings()
          }
        }) }
        rendered = row(rows, item.label, value || (disabled ? 'Unavailable' : 'Open'), action)
        continue
      } else if (item.phone.kind !== 'status' && !disabled) {
        action = () => { void report(async () => {
          if (await runPhoneSettingsAction(item, actions)) {
            shell.noteUserActivity()
            refreshSettings()
          }
        }) }
      }
      row(rows, item.label, value || (disabled ? 'Unavailable' : 'Open'), action)
    }
  }
  function refreshSettings(): void {
    const sections = phoneSettingsSections()
    const ringConnection = sections.flatMap(section => section.items).find(item =>
      item.phone?.kind === 'setting' && item.phone.setting === settings.ringConnectionModeSetting)
    preferences.content.removeChildren()
    preferences.content.addChild(text('Settings', 'companion-heading', UIFontTextStyleLargeTitle))
    const devices = group(preferences.content, 'Your devices')
    row(devices, 'Glasses & connection', 'Manage', () => { void report(actions.openDevices) }, 'eyeglasses')
    const ring = group(preferences.content, 'Ring')
    const worn = settings.ringControlsOnlyWhileWornSetting
    let wornRow: GridLayout
    wornRow = row(ring, worn.label, displaySetting(worn), () => { void report(async () => {
      if (await editCompanionSetting(worn)) {
        const current = displaySetting(worn)
        ;(wornRow.getChildAt(1) as Label).text = current
        wornRow.accessibilityLabel = `${worn.label}, ${current}`
        refreshSettings()
      }
    }) })
    if (ringConnection) renderItems(ring, [ringConnection])
    const ringMode = settings.effectiveRingConnectionMode()
    const ringRoute = ringMode === 'direct'
      ? 'iPhone handles R1 controls and health. Health sync may briefly pause controls while R1 changes roles.'
      : ringMode === 'health'
        ? 'R1 controls go through the glasses. Health uses a separate R1-to-iPhone link.'
        : 'R1 controls go through the glasses. Pilot does not connect to R1 for health.'
    ring.addChild(text(`Selected mode: ${ringRoute}`, 'companion-note', UIFontTextStyleFootnote))
    ring.addChild(text('Putting the glasses in their case does not change this mode. Worn only gates controls, not the selected connection route.', 'companion-note', UIFontTextStyleFootnote))
    const ringMessage = iosRingBackgroundStatus().ringConnection?.message
    if (ringMessage) ring.addChild(text(ringMessage, 'companion-note', UIFontTextStyleFootnote))
    for (const section of sections) {
      const rows = group(preferences.content, section.label)
      renderItems(rows, section.items.filter(item => item !== ringConnection))
    }
    preferences.content.addChild(text('Notification controls affect what appears in Pilot and on your glasses. They do not clear iPhone Notification Center.', 'companion-note', UIFontTextStyleFootnote))
    const privacy = group(preferences.content, 'iPhone access')
    row(privacy, 'iPhone permissions', 'Review', () => { void report(actions.openPermissions) }, 'hand.raised')
    const advanced = group(preferences.content, 'Advanced & help')
    row(advanced, 'Connection tools', 'Open', () => { void report(actions.openAdvanced) }, 'wrench.and.screwdriver')
    row(advanced, 'App-specific settings', 'Open on glasses', () => { void report(() => actions.launchApp('settings')) }, 'gearshape')
    preferences.content.addChild(text(`FaceClaw Pilot · ${FACECLAW_VERSION}\nBuilt on Faceclaw by Jim Babcock and contributors.`, 'companion-note', UIFontTextStyleFootnote))
  }
  refreshSettings()

  function bindHealthBridge(): void {
    const bridge = FaceclawCommunicatorBridge.getActive()
    if (bridge === healthBridge && healthBridgeGeneration === healthGeneration) return
    stopHealthBridge?.()
    healthBridge = bridge
    const generation = healthGeneration
    healthBridgeGeneration = generation
    stopHealthBridge = bridge?.onRingHealthPullFinished(() => {
      if (FaceclawCommunicatorBridge.getActive() === bridge && healthBridge === bridge &&
          healthBridgeGeneration === generation && healthGeneration === generation) {
        syncRequested = false
        refreshHealth()
      }
    }) ?? null
  }

  function refreshHealth(): void {
    bindHealthBridge()
    health.content.removeChildren()
    health.content.addChild(text('Health', 'companion-heading', UIFontTextStyleLargeTitle))
    const healthReady = Boolean(healthBridge?.canSyncRingHealth())
    const clock = (atMs: number) => new Date(atMs).toLocaleTimeString([], {
      hour: 'numeric', minute: '2-digit', hour12: settings.timeFormatSetting.get() === '12h',
    })
    try {
      const start = startOfLocalDay(Date.now()), end = nextBucketStart(start, 'day')
      const eligible = hasLiveData() && !isFixtureData()
      const store = eligible ? healthStore() : null
      const samples = store?.samplesInRange(start, end) ?? []
      const readings = store?.readingsInRange(start, end) ?? []
      const summary = dailySummary(samples, store?.sleepSessions() ?? [], start)
      const latest = (metric: 'heartRate' | 'spo2') => readings
        .filter(reading => reading.metric === metric)
        .reduce<(typeof readings)[number] | null>((newest, reading) => !newest || reading.startMs > newest.startMs ? reading : newest, null)
      const heart = latest('heartRate'), oxygen = latest('spo2')
      const rows = group(health.content, 'Today · R1')
      const hasSteps = samples.some(sample => sample.metric === 'steps')
      const hasActiveEnergy = samples.some(sample => sample.metric === 'activeCalories')
      const hasSleep = Boolean(summary.sleep?.timeResolved)
      if (heart || oxygen || summary.heartRate.hasData || summary.spo2.hasData || hasSteps || hasActiveEnergy || hasSleep) {
        row(rows, heart ? 'Heart rate' : summary.heartRate.hasData ? 'Average heart rate' : 'Heart rate',
          heart ? `${Math.round(heart.avg)} bpm` : summary.heartRate.hasData ? `${Math.round(summary.heartRate.avg)} bpm` : 'No reading')
        row(rows, oxygen ? 'Blood oxygen' : summary.spo2.hasData ? 'Average oxygen' : 'Blood oxygen',
          oxygen ? `${Math.round(oxygen.avg)}%` : summary.spo2.hasData ? `${Math.round(summary.spo2.avg)}%` : 'No reading')
        row(rows, 'Steps', hasSteps ? summary.steps.toLocaleString() : 'No saved data')
        row(rows, 'Active energy', hasActiveEnergy ? `${Math.round(samples.filter(sample => sample.metric === 'activeCalories').reduce((total, sample) => total + sample.total, 0))} kcal` : 'No saved data')
        row(rows, 'Sleep', hasSleep ? `${summary.sleep!.hours}h ${summary.sleep!.minutes}m` : 'No saved data')
        const times = [heart && `Heart rate ${clock(heart.startMs)}`, oxygen && `Blood oxygen ${clock(oxygen.startMs)}`].filter(Boolean)
        if (times.length) rows.addChild(text(times.join(' · '), 'companion-note', UIFontTextStyleFootnote))
      } else {
        rows.addChild(text('No saved readings today.', 'companion-note'))
        rows.addChild(text(healthReady ? 'Tap Sync now to check for new measurements.' : 'Connect Pilot, then tap Sync now.', 'companion-note', UIFontTextStyleFootnote))
      }
    } catch {
      health.content.addChild(text('Saved health data could not be read. Reopen this screen to try again; your stored records have not been changed.', 'companion-note'))
    }

    const sync = group(health.content, 'Sync')
    const syncButton = new Button()
    syncButton.text = 'Sync now'
    syncButton.className = 'health-sync-button'
    syncButton.accessibilityLabel = 'Sync now'
    syncButton.isEnabled = healthReady && !healthBusy
    syncButton.on('loaded', () => {
      syncButton.ios.titleLabel.font = UIFont.preferredFontForTextStyle(UIFontTextStyleHeadline)
      syncButton.ios.titleLabel.adjustsFontForContentSizeCategory = true
      syncButton.requestLayout()
    })
    syncButton.on('tap', () => { void report(syncRingHealth) })
    sync.addChild(syncButton)
    sync.addChild(text(syncRequested ? 'Sync requested' : healthReady ? 'Connects briefly to collect new R1 measurements.' : 'Connect Pilot to sync.', 'companion-note', UIFontTextStyleFootnote))
    const background = iosRingBackgroundStatus()
    if (isAutomaticR1HealthSyncEnabled()) {
      if (background.scheduler.availability === 'denied' || background.scheduler.availability === 'restricted')
        sync.addChild(text('Background App Refresh is off. Open Pilot or use Sync now to catch up.', 'companion-note', UIFontTextStyleFootnote))
      else if (background.lastCompletedAt)
        sync.addChild(text(`Last completed sync ${clock(background.lastCompletedAt)}`, 'companion-note', UIFontTextStyleFootnote))
    }
    if (isAppleHealthAvailable()) row(sync, 'Automatic Apple Health sync', isAutomaticR1HealthSyncEnabled() ? 'On' : 'Off', () => { void report(toggleAutomaticHealth) })

    const apple = group(health.content, 'Apple Health access')
    if (isAppleHealthAvailable()) {
      row(apple, 'Health permissions', getBooleanSetting('health.apple.requestCompleted', false) ? 'Manage' : 'Connect', () => { void report(async () => {
        if (healthBusy) return
        await requestAppleHealthAccess()
        setBooleanSetting('health.apple.requestCompleted', true)
        refreshHealth()
      }) }, 'heart.text.square')
      row(apple, 'Today’s summary', healthBusy ? 'Reading…' : 'Refresh', () => { void report(() => readHealth('today')) })
      row(apple, 'Yesterday’s summary', healthBusy ? 'Reading…' : 'Refresh', () => { void report(() => readHealth('yesterday')) })
      apple.addChild(text('Choose access in Apple’s permission sheet. Empty results can mean unavailable measurements or restricted read access. Change existing permissions in iPhone Settings → Health → Data Access & Devices.', 'companion-note', UIFontTextStyleFootnote))
      if (appleSummary) {
        const metrics = appleSummary.metrics
        const summaryRows = group(health.content, appleSummary.day === 'today' ? 'Today · Apple Health' : 'Yesterday · Apple Health')
        const value = (metric: { value: number } | null, unit: string, scale = 1) => metric ? `${Math.round(metric.value * scale).toLocaleString()} ${unit}` : 'No readable data'
        row(summaryRows, 'Steps', value(metrics.steps, 'steps'))
        row(summaryRows, 'Heart rate · latest', value(metrics.heartRate, 'bpm'))
        row(summaryRows, 'Resting heart rate', value(metrics.restingHeartRate, 'bpm'))
        row(summaryRows, 'HRV · SDNN', value(metrics.hrv, 'ms'))
        row(summaryRows, 'Blood oxygen', value(metrics.oxygenSaturation, '%', 100))
        summaryRows.addChild(text(`Read ${new Date(appleSummary.queriedAtMs).toLocaleString()}. Heart metrics are the latest readable sample in this day; steps are the day’s total.`, 'companion-note', UIFontTextStyleFootnote))
        for (const [name, metric] of Object.entries(metrics)) {
          if (metric?.source && metric.sampleAtMs !== undefined) summaryRows.addChild(text(`${name}: ${metric.source.name} · ${new Date(metric.sampleAtMs).toLocaleString()}`, 'companion-note', UIFontTextStyleFootnote))
        }
      }
    } else apple.addChild(text('Apple Health is unavailable on this device.', 'companion-note'))

    const destination = shell.getAssistantHealthDestination()
    const sharing = isHealthSharingAllowed(destination)
    const assistant = group(health.content, 'Assistant sharing')
    row(assistant, 'Share with assistant', sharing ? 'Enabled' : 'Off', () => { void report(async () => {
        const selected = shell.getAssistantHealthDestination()
        if (isHealthSharingAllowed(selected)) setHealthSharingDestination(null)
        else {
          if (!selected) throw new Error('Configure a supported assistant first.')
          const generation = healthGeneration
          const confirmed = await Dialogs.confirm({ title: 'Share health summaries?', message: `When you ask, limited Apple Health summaries will be sent to ${decodeURIComponent(selected)} and retained in that assistant conversation. Changing the assistant requires a new opt-in.`, okButtonText: 'Allow', cancelButtonText: 'Cancel' })
          if (!confirmed || generation !== healthGeneration) return
          if (shell.getAssistantHealthDestination() !== selected) throw new Error('The assistant changed. Review sharing again.')
          setHealthSharingDestination(selected)
        }
        refreshHealth()
      }) }, 'hand.raised')
    if (sharing && destination) assistant.addChild(text(`Allowed destination: ${decodeURIComponent(destination)}`, 'companion-note', UIFontTextStyleFootnote))

    const advanced = group(health.content, 'Advanced')
    row(advanced, 'Advanced health details', advancedHealthExpanded ? 'Hide' : 'Show', () => {
      advancedHealthExpanded = !advancedHealthExpanded
      refreshHealth()
    }, 'ellipsis.circle')
    if (advancedHealthExpanded) {
      row(advanced, 'Background sync details', 'View', () => { void report(async () => {
        const status = iosRingBackgroundStatus(), attempt = status.lastAttempt
        await Dialogs.alert({ title: 'Ring sync', message: [
          `Background refresh: ${status.scheduler.availability ?? 'Not registered'}`,
          `Last attempt: ${attempt?.source ?? 'Not run'}`,
          `Result: ${attempt?.outcome ?? 'Not finished'}`,
          `Glasses ready at start: ${attempt ? (attempt.glassesReadyAtStart ? 'Yes' : 'No') : 'Not recorded'}`,
          `Glasses connected during transfer: ${attempt ? (attempt.glassesBecameReady ? 'Yes' : 'No') : 'Not recorded'}`,
        ].join('\n'), okButtonText: 'Done' })
      }) }, 'info.circle')
      if (isAppleHealthAvailable()) {
        row(advanced, 'Start R1 recording from now', 'One-time', () => { void report(startRingRecording) })
        row(advanced, 'Export R1 measurements', 'Last 7 days', () => { void report(exportRingHealth) })
      }
      advanced.addChild(text('Manual exports include captured heart rate and oxygen readings, completed steps, active energy, and resolved sleep. R1 RMSSD, raw nighttime temperature, and undated records stay local.', 'companion-note', UIFontTextStyleFootnote))
    }
    const tools = group(health.content, 'On your glasses')
    row(tools, 'Open Health', 'View', () => { void report(() => actions.launchApp('health')) }, 'heart')
  }

  function syncRingHealth(): void {
    if (healthBusy) return
    const bridge = FaceclawCommunicatorBridge.getActive()
    if (!bridge || bridge !== healthBridge || !bridge.canSyncRingHealth()) throw new Error('Connect Pilot before syncing R1 health data. Automatic sync enables phone health transfers in both Health and Direct ring connection modes with the glasses in their case.')
    requestFreshPull()
    syncRequested = true
    refreshHealth()
  }

  async function toggleAutomaticHealth(): Promise<void> {
    if (healthBusy) return
    const generation = healthGeneration
    healthBusy = true
    try {
      if (isAutomaticR1HealthSyncEnabled()) { setAutomaticR1HealthSyncEnabled(false); return }
      const confirmed = await Dialogs.confirm({ title: 'Automatically save R1 measurements?',
        message: 'Save verified heart rate, oxygen, steps, active energy and sleep to Apple Health after ring transfers. Pilot also collects on reconnect and foreground entry. Phone health transfers work in both Health and Direct ring connection modes and can connect to R1 with the glasses in their case. Only existing write permissions are used; assistant sharing is separate.',
        okButtonText: 'Enable', cancelButtonText: 'Cancel' })
      if (!confirmed || generation !== healthGeneration) return
      setAutomaticR1HealthSyncEnabled(true)
      await syncAutomaticR1Health()
      requestFreshPull()
    } finally { if (generation === healthGeneration) { healthBusy = false; refreshHealth() } }
  }

  async function readHealth(day: 'today' | 'yesterday'): Promise<void> {
    if (healthBusy) return
    const generation = ++healthGeneration, listeners = new Set<() => void>()
    const signal = { aborted: false, addEventListener(_type: 'abort', listener: () => void) { listeners.add(listener) }, removeEventListener(_type: 'abort', listener: () => void) { listeners.delete(listener) } }
    cancelHealthRead = () => { signal.aborted = true; for (const listener of listeners) listener() }
    healthBusy = true; appleSummary = null; refreshHealth()
    try {
      const summary = await readAppleHealthSummary(day, signal)
      if (generation === healthGeneration) appleSummary = summary
    } finally {
      if (generation === healthGeneration) { healthBusy = false; cancelHealthRead = null; refreshHealth() }
    }
  }

  async function exportRingHealth(): Promise<void> {
    if (healthBusy) return
    const generation = healthGeneration
    let submitted = 0
    healthBusy = true
    try {
      const now = Date.now(), start = now - 7 * 86_400_000
      const store = healthStore(), options = { startMs: start, endMs: now, nowMs: now }
      const eligible = hasLiveData() && !isFixtureData()
      const saved = eligible ? [...store.readingsInRange(start, now), ...store.samplesInRange(start, now)] : []
      const records = [...buildR1HealthKitExport(saved, options).samples,
        ...buildR1SleepHealthKitExport(eligible ? store.sleepSessions() : [], options).samples]
      if (!records.length) throw new Error('No verified, dated R1 readings, activity buckets or sleep stages are eligible in the last 7 days. Raw records remain saved locally; no ring clock was changed.')
      const first = Math.min(...records.map(record => record.startMs)), last = Math.max(...records.map(record => record.endMs))
      const confirmed = await Dialogs.confirm({ title: 'Export R1 to Apple Health?', message: `${records.length} dated records from ${new Date(first).toLocaleString()} to ${new Date(last).toLocaleString()}. Includes captured heart rate/oxygen readings, steps, active energy and verified sleep stages. HRV and temperature stay local. Repeated exports use the same sync identifiers.`, okButtonText: 'Export', cancelButtonText: 'Cancel' })
      if (!confirmed || generation !== healthGeneration) return
      for (let offset = 0; offset < records.length; offset += 1000) {
        if (generation !== healthGeneration) return
        const result = await writeR1HealthSamples(records.slice(offset, offset + 1000))
        submitted += result.submittedCount
      }
      if (generation === healthGeneration) await Dialogs.alert({ title: 'Export submitted', message: `Apple Health completed saving ${submitted} submitted records. This is not a count of new unique measurements.`, okButtonText: 'OK' })
    } catch (error) {
      if (submitted === 0) throw error
      throw new Error(`Export stopped after ${submitted} records were submitted. Retrying uses the same sync identifiers. ${error instanceof Error ? error.message : String(error)}`)
    } finally { if (generation === healthGeneration) { healthBusy = false; refreshHealth() } }
  }

  async function startRingRecording(): Promise<void> {
    if (healthBusy) return
    const generation = healthGeneration
    const confirmed = await Dialogs.confirm({ title: 'Start R1 recording from now?',
      message: 'This one-time operation enables health recording and corrects the ring clock to the current UTC time. Older undated history may be discarded by the ring; the existing raw backup is kept.',
      okButtonText: 'Start recording', cancelButtonText: 'Cancel' })
    if (!confirmed || generation !== healthGeneration) return
    const bridge = FaceclawCommunicatorBridge.getActive()
    if (!bridge) throw new Error('Connect the glasses before starting R1 recording.')
    healthBusy = true; refreshHealth()
    try {
      const result = await bridge.startRingHealthRecordingNow()
      if (generation === healthGeneration) await Dialogs.alert({
        title: 'R1 recording configured',
        message: `${result}\n\nNew dated measurements still need to be verified after the ring records them.`,
        okButtonText: 'OK',
      })
    } finally { if (generation === healthGeneration) { healthBusy = false; refreshHealth() } }
  }

  function refreshApps(): void {
    apps.content.removeChildren()
    apps.content.addChild(text('Apps', 'companion-heading', UIFontTextStyleLargeTitle))
    apps.content.addChild(text('Open an app on your glasses. Existing windows and conversations are preserved.', 'companion-note'))
    const entries = launcherEntries(ALL_APPS)
    const installed = entries.filter(entry => entry.appId.startsWith('evenhub-installed:'))
    if (installed.length) {
      const rows = group(apps.content, 'Installed apps')
      for (const entry of installed) row(rows, entry.label, 'Open', () => { void report(() => actions.launchApp(entry.appId)) }, 'app')
    }
    const builtIn = group(apps.content, 'Built-in apps')
    for (const entry of entries.filter(entry => !entry.appId.startsWith('evenhub-installed:'))) {
      row(builtIn, entry.label, 'Open', () => { void report(() => actions.launchApp(entry.appId)) }, 'app')
    }
    const browse = group(apps.content, 'Discover')
    row(browse, 'Even Hub', 'Browse on glasses', () => { void report(() => actions.launchApp('evenhub')) }, 'square.grid.2x2')
  }

  const clearSettings = () => cancelPhoneSettingsActions()
  return { health: health.view, apps: apps.view, settings: preferences.view, clearSettings, clearHealth() {
    clearSettings()
    healthGeneration++; cancelHealthRead?.(); cancelHealthRead = null; healthBusy = false; appleSummary = null
    stopHealthBridge?.(); stopHealthBridge = null; healthBridge = null; healthBridgeGeneration = -1; syncRequested = false; advancedHealthExpanded = false
    health.content.removeChildren()
    health.content.addChild(text('Health', 'companion-heading', UIFontTextStyleLargeTitle))
  }, refresh() {
    refreshHealth(); refreshApps(); refreshSettings()
  } }
}
