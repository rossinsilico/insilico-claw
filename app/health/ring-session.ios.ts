import { Application, ApplicationSettings } from '@nativescript/core'
import { loadDeviceAddresses } from '../g2/device-addresses'
import { deviceAddressError } from '../g2/ios-peripheral-identity'
import { hasCompletedOnboarding, isPreviewOnlyMode } from '../phone-ui/onboarding-state'
import { FaceclawCommunicatorBridge, resolveIosPeripherals, type BackgroundRingHealthResult } from '../native/faceclaw-communicator.ios'
import { isAutomaticR1HealthSyncEnabled, syncAutomaticR1Health } from './healthkit-sync.ios'
import { setStringSetting } from '../native/settings-store'
import type { GlassesType, RingConnectionMode } from '../ui/dashboard-settings'

declare const FaceclawRingHealthBackground: any

const WANTED = 'ios.ble.session.connectionWanted'
const DEVICE_SET = 'ios.ble.session.deviceSet'
const STATUS = 'ios.ble.session.healthStatus'
const HANDBACK = 'ios.ble.session.ringHandback'
const ROLE_LEASE = 'ios.ble.session.ringRoleLease'
const INTERVAL_MS = 30 * 60_000
const BUDGET_MS = 25_000
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i

type Configuration = ReturnType<typeof configuration>
type Owner = { bridge: FaceclawCommunicatorBridge; key: string; config: Configuration; offs: (() => void)[];
  handbackRequest: object | null; handbackConfirmed: boolean }
type Handback = { key: string; ringId: string; state: 'pending' | 'queued' | 'confirmed' | 'failed'; message?: string }
type RoleLease = { ringId: string; mode?: RingConnectionMode; needsRelease: boolean; message?: string }
type Attempt = {
  requestId: string; generation: number; source: string; startedAt: number
  glassesReadyAtStart: boolean; glassesBecameReady: boolean
  outcome?: string; finishedAt?: number; pages?: number; exportCompleted?: boolean
}
type Job = { attempt: Attempt; bridge: FaceclawCommunicatorBridge; scheduled: boolean }
type SavedStatus = { lastCompletedAt?: number; lastAttempt?: Attempt; lastRestoration?: { at: number; peers: number } }

let owner: Owner | null = null
let consumer: { bridge: FaceclawCommunicatorBridge; detach: () => void } | null = null
let scheduler: any
let initialized = false, policyStamp = '', generation = 0, intentEpoch = 0, pendingOperations = 0
let tail: Promise<unknown> = Promise.resolve()
let activeJob: Job | null = null

function configuration() {
  const addresses = loadDeviceAddresses()
  // Read these leaf settings without loading the glasses UI on a background launch.
  const glassesType = ApplicationSettings.getString('deviceType', 'g2') as GlassesType
  const stored = ApplicationSettings.getString('developer.ringConnectionMode', 'glasses')
  const mode: RingConnectionMode = glassesType !== 'g2' ? 'direct' :
    stored === 'health' || stored === 'direct' ? stored : 'glasses'
  const ring = mode !== 'glasses' ? addresses.ring : ''
  return { addresses, glassesType, mode, ring, deviceKey: JSON.stringify([addresses, glassesType]),
    key: JSON.stringify([addresses, glassesType, mode]) }
}

function wanted(config: Configuration): boolean {
  const savedSet = ApplicationSettings.getString(DEVICE_SET, '')
  if (savedSet) {
    try {
      const previous = JSON.parse(savedSet)
      // Older versions included the mode in the stored device identity.
      if (Array.isArray(previous) && previous.length >= 2 &&
          JSON.stringify(previous.slice(0, 2)) !== config.deviceKey) return true
    } catch { /* Preserve an explicit stop if its old device identity cannot be decoded. */ }
  }
  return ApplicationSettings.getBoolean(WANTED, true)
}

function enabled(config = configuration()): boolean {
  return hasCompletedOnboarding() && !isPreviewOnlyMode() && wanted(config) &&
    Boolean(config.ring) && !roleReleaseRequired(config) && isAutomaticR1HealthSyncEnabled()
}

function roleLease(): RoleLease | null {
  try { return JSON.parse(ApplicationSettings.getString(ROLE_LEASE, 'null')) } catch { return null }
}

function saveRoleLease(ringId: string, mode: RingConnectionMode, needsRelease: boolean, message?: string): void {
  ApplicationSettings.setString(ROLE_LEASE, JSON.stringify({ ringId, mode, needsRelease, message } satisfies RoleLease))
}

function roleReleaseRequired(config: Configuration): boolean {
  if (!config.ring) return false
  const lease = roleLease()
  if (config.mode === 'direct') return lease?.ringId === config.ring && lease.mode === 'health' && lease.needsRelease !== false
  return lease?.ringId !== config.ring || (lease.needsRelease !== false && lease.mode !== 'health')
}

function cachedIdentifiers(config: Configuration): { right: string; left: string; ring: string } | null {
  const result = { right: '', left: '', ring: '' }
  for (const role of ['right', 'left', 'ring'] as const) {
    const address = role === 'ring' ? config.ring : config.addresses[role]
    if (!address) continue
    try {
      const saved = JSON.parse(ApplicationSettings.getString(`ios.ble.peripheral.${address}`, '{}'))
      if (saved.role !== role || typeof saved.identifier !== 'string' || !UUID.test(saved.identifier)) return null
      result[role] = saved.identifier.toUpperCase()
    } catch { return null }
  }
  return result.right && result.left ? result : null
}

function savedStatus(): SavedStatus {
  try { return JSON.parse(ApplicationSettings.getString(STATUS, '{}')) ?? {} } catch { return {} }
}

function saveStatus(status: SavedStatus): void {
  ApplicationSettings.setString(STATUS, JSON.stringify(status))
}

function due(): boolean {
  const last = savedStatus().lastCompletedAt ?? 0, age = Date.now() - last
  return !Number.isFinite(last) || last <= 0 || age < 0 || age >= INTERVAL_MS
}

function serial<T>(operation: () => Promise<T>): Promise<T> {
  pendingOperations++
  const run = tail.then(operation, operation)
  tail = run.then(() => undefined, () => undefined)
  return run.finally(() => { pendingOperations-- })
}

function createOwner(config: Configuration, identifiers: { right: string; left: string; ring: string }): Owner {
  // A restart must never inherit a previous session's role-release acknowledgement.
  if (config.ring) saveRoleLease(config.ring, config.mode, true)
  const bridge = new FaceclawCommunicatorBridge({ ...identifiers, glassesType: config.glassesType,
    healthRingId: identifiers.ring ? config.ring : undefined,
    ringRole: identifiers.ring ? config.mode === 'health' ? 'phone' : 'glasses' : undefined,
    independentRingHealth: isAutomaticR1HealthSyncEnabled() })
  const next: Owner = { bridge, key: config.key, config, offs: [], handbackRequest: null, handbackConfirmed: false }
  owner = next
  if (config.glassesType === 'g2' && config.addresses.ring) saveHandback(next, 'pending')
  next.offs.push(
    bridge.onRingHealthPullFinished(result => {
      if (owner !== next) return
      void syncAutomaticR1Health().then(complete => {
        if (owner === next && result.completed && complete) saveStatus({ ...savedStatus(), lastCompletedAt: Date.now() })
      }).catch(() => {}) // Raw pages remain journaled for the next retry.
    }),
    bridge.onBackgroundRingHealthFinished(result => { void finishNativeJob(next, result) }),
    bridge.onSessionRestored(peers => {
      if (owner !== next) return
      saveStatus({ ...savedStatus(), lastRestoration: { at: Date.now(), peers } })
      startJob('restoration', BUDGET_MS, false)
    }),
    bridge.onGlassesRingConnectionState(state => {
      if (!currentOwner(next) || config.mode === 'direct' || state.ringId !== config.addresses.ring) return
      next.handbackConfirmed = state.connected
      if (!state.connected) next.handbackRequest = null
      saveHandback(next, state.connected ? 'confirmed' : 'pending')
    }),
    bridge.onPhoneRingReady(() => {
      if (config.mode === 'health' && currentOwner(next) && bridge.isSessionReady()) void handRingBack(next)
    }),
    bridge.onStateChange(state => {
      if (activeJob?.bridge === bridge && (state.phase === 'connected' || state.phase === 'charging'))
        activeJob.attempt.glassesBecameReady = true
      if (state.phase === 'connected' || state.phase === 'charging') void handRingBack(next)
      else {
        next.handbackRequest = null; next.handbackConfirmed = false
        if (config.mode !== 'direct' && config.addresses.ring) saveHandback(next, 'pending')
      }
    }),
  )
  bridge.setConnectionWanted(wanted(config))
  // Register before UIApplicationMain so a cold Bluetooth wake can restore this owner.
  bridge.configureStateRestoration(wanted(config))
  if (wanted(config)) bridge.startHealthOnly()
  return next
}

function currentOwner(target: Owner): boolean {
  return owner === target && configuration().key === target.key
}

function saveHandback(target: Owner, state: Handback['state'], message?: string): void {
  if (currentOwner(target)) setStringSetting(HANDBACK,
    JSON.stringify({ key: target.key, ringId: target.config.addresses.ring, state, message } satisfies Handback))
}

async function handRingBack(target: Owner): Promise<void> {
  const config = target.config
  if (!currentOwner(target) || !wanted(config) || config.glassesType !== 'g2' || config.mode === 'direct' ||
      !config.addresses.ring || target.handbackRequest || target.handbackConfirmed) return
  const request = {}
  target.handbackRequest = request
  try {
    const authorized = () => currentOwner(target) && wanted(config) && !target.handbackConfirmed && target.handbackRequest === request
    const queued = config.mode === 'health'
      ? await target.bridge.bindGlassesRing(config.addresses, authorized)
      : await target.bridge.connectGlassesRing(config.addresses.ring, authorized)
    if (!authorized()) return
    if (!queued) target.handbackRequest = null
    saveHandback(target, queued ? 'queued' : 'pending')
  } catch (error) {
    if (currentOwner(target) && wanted(config) && !target.handbackConfirmed && target.handbackRequest === request) {
      target.handbackRequest = null
      saveHandback(target, 'failed', error instanceof Error ? error.message : 'Ring connection could not be restored.')
    }
  }
}

function prepareSavedOwner(): Owner | null {
  const config = configuration()
  if (!hasCompletedOnboarding() || isPreviewOnlyMode() || deviceAddressError(config.addresses)) return null
  if (owner) return owner.key === config.key ? owner : null
  if (pendingOperations || roleReleaseRequired(config)) return null
  const ids = cachedIdentifiers(config)
  return ids ? createOwner(config, ids) : null
}

export function initializeIosRingBackground(): void {
  if (initialized) return
  initialized = true
  scheduler = FaceclawRingHealthBackground.shared()
  scheduler.registerWithStartCancel(
    (requestId: string, budget: number) => startJob(String(requestId), Number(budget), true),
    (requestId: string) => { if (activeJob?.attempt.requestId === String(requestId)) cancelJob('system-cancelled') },
  )
  prepareSavedOwner()
  syncIosRingPolicy()
  NSNotificationCenter.defaultCenter.addObserverForNameObjectQueueUsingBlock(
    NSUserDefaultsDidChangeNotification, null, NSOperationQueue.mainQueue, () => syncIosRingPolicy())
  Application.on(Application.resumeEvent, resumeIosRingHealth)
}

export function syncIosRingPolicy(): void {
  const config = configuration(), allow = wanted(config), automatic = isAutomaticR1HealthSyncEnabled()
  const stamp = JSON.stringify([config.key, allow, automatic, hasCompletedOnboarding(), isPreviewOnlyMode(), roleReleaseRequired(config)])
  if (stamp === policyStamp) return
  policyStamp = stamp
  if (owner && owner.key !== config.key) {
    const epoch = ++intentEpoch
    cancelJob('configuration-changed')
    const previous = owner
    previous.bridge.cancelGlassesRingBinding()
    void serial(() => closeOwner(previous, config, epoch)).catch(() => {})
  }
  if (owner?.key === config.key) {
    owner.bridge.setConnectionWanted(allow)
    owner.bridge.setIndependentRingHealthEnabled(automatic)
    owner.bridge.configureStateRestoration(allow)
  }
  if (!enabled(config)) cancelJob('disabled')
  scheduler?.setEnabled(enabled(config))
}

export function setIosSessionConnectionWanted(value: boolean): void {
  intentEpoch++
  ApplicationSettings.setString(DEVICE_SET, configuration().deviceKey)
  ApplicationSettings.setBoolean(WANTED, value)
  if (!value) cancelJob('user-disconnected')
  policyStamp = ''
  syncIosRingPolicy()
}

export function ensureIosSession(options: { userInitiated?: boolean; allowScan?: boolean } = {}): Promise<FaceclawCommunicatorBridge | null> {
  if (options.userInitiated) setIosSessionConnectionWanted(true)
  const config = configuration(), epoch = intentEpoch
  return serial(async () => {
    const current = () => wanted(config) && epoch === intentEpoch && configuration().key === config.key
    if (!current()) return null
    if (owner?.key === config.key) {
      owner.bridge.setConnectionWanted(true)
      owner.bridge.startHealthOnly()
      if (owner.bridge.isSessionReady()) void handRingBack(owner)
      return owner.bridge
    }
    if (owner && !await closeOwner(owner, config, epoch)) return null
    if (!current() || roleReleaseRequired(config)) return null
    const ids = cachedIdentifiers(config) ?? (options.allowScan
      ? await resolveIosPeripherals({ ...config.addresses, ring: config.ring }) : null)
    if (!ids || !current()) return null
    const next = createOwner(config, ids)
    syncIosRingPolicy()
    return next.bridge
  })
}

export function claimIosSessionForUi(bridge: FaceclawCommunicatorBridge, detach: () => void): void {
  consumer?.detach()
  consumer = { bridge, detach }
}

async function closeOwner(target: Owner, requested?: Configuration, epoch?: number): Promise<boolean> {
  if (owner !== target) return true
  const sameRequest = () => requested?.key === configuration().key && epoch === intentEpoch
  if (requested && !sameRequest()) return false
  if (target.config.ring && (target.config.mode === 'health' ||
      requested?.mode === 'health' && wanted(requested) && target.config.mode === 'direct' && target.config.ring === requested.ring)) {
    cancelJob('ring-role-changing')
    let released = false
    try {
      released = await target.bridge.prepareForRingRoleChange(12_000, () => owner === target && (!requested || sameRequest()))
    } catch { /* An uncertain old role must never authorize a PHONE connection. */ }
    saveRoleLease(target.config.ring, target.config.mode, !released, released ? undefined :
      'Pilot could not safely change the ring connection. Keep the ring nearby, reconnect in the current mode, then try again.')
    if (!released) {
      if (requested && sameRequest()) {
        intentEpoch++
        setStringSetting('developer.ringConnectionMode', target.config.mode)
        syncIosRingPolicy()
      }
      if (requested) return false
    }
  }
  cancelJob('session-replaced')
  if (consumer?.bridge === target.bridge) { const old = consumer; consumer = null; old.detach() }
  owner = null
  for (const off of target.offs) off()
  await target.bridge.close()
  return true
}

export function releaseIosSession(bridge: FaceclawCommunicatorBridge, explicitStop = false): Promise<void> {
  if (explicitStop) setIosSessionConnectionWanted(false)
  return serial(async () => { if (owner?.bridge === bridge) await closeOwner(owner) })
}

export function resumeIosRingHealth(): void {
  syncIosRingPolicy()
  if (owner?.bridge.isSessionReady()) void handRingBack(owner)
  scheduler?.setEnabled(enabled()) // Retry a previous scheduling failure after foreground entry.
  startJob('foreground', BUDGET_MS, false)
}

function startJob(requestId: string, budget: number, scheduled: boolean): void {
  if (!enabled() || activeJob || pendingOperations) { if (scheduled) scheduler.completeSuccess(requestId, false); return }
  const processing = syncAutomaticR1Health().catch(() => false)
  if (!due()) {
    void processing.then(complete => {
      if (scheduled) scheduler.completeSuccess(requestId, complete)
    }).catch(() => { if (scheduled) scheduler.completeSuccess(requestId, false) })
    return
  }
  const target = prepareSavedOwner()
  if (!target || !target.bridge.canSyncRingHealth()) {
    void processing.then(() => { if (scheduled) scheduler.completeSuccess(requestId, false) })
    return
  }
  const attempt: Attempt = { requestId, generation: ++generation, source: scheduled ? 'scheduled' : requestId,
    startedAt: Date.now(), glassesReadyAtStart: target.bridge.isSessionReady(), glassesBecameReady: false }
  const job: Job = { attempt, bridge: target.bridge, scheduled }
  activeJob = job
  saveStatus({ ...savedStatus(), lastAttempt: attempt })
  const deadline = Math.max(1, Math.min(BUDGET_MS, Number.isFinite(budget) ? Math.floor(budget) : BUDGET_MS))
  if (!target.bridge.requestBackgroundRingHealth(attempt.generation, deadline))
    void processing.then(() => finishJob(job, 'busy', false))
}

async function finishNativeJob(target: Owner, result: BackgroundRingHealthResult): Promise<void> {
  const job = activeJob
  if (!job || owner !== target || job.bridge !== target.bridge || job.attempt.generation !== result.generation) return
  job.attempt.pages = result.pages
  try {
    const complete = await syncAutomaticR1Health()
    if (activeJob === job) {
      if (complete && result.outcome === 'completed') saveStatus({ ...savedStatus(), lastCompletedAt: Date.now() })
      if (complete) job.attempt.exportCompleted = true
      finishJob(job, complete ? result.outcome : 'processing-deferred', complete && result.outcome === 'completed')
    }
  } catch {
    if (activeJob === job) finishJob(job, 'export-deferred', false)
  }
}

function finishJob(job: Job, outcome: string, success: boolean): void {
  if (activeJob !== job) return
  activeJob = null
  job.attempt.outcome = outcome
  job.attempt.finishedAt = Date.now()
  saveStatus({ ...savedStatus(), lastAttempt: job.attempt })
  if (job.scheduled) scheduler.completeSuccess(job.attempt.requestId, success)
}

function cancelJob(reason: string): void {
  const job = activeJob
  if (!job) return
  job.bridge.cancelBackgroundRingHealth(job.attempt.generation)
  finishJob(job, reason, false)
}

export function iosRingBackgroundStatus(): SavedStatus & { scheduler: Record<string, unknown>;
    ringConnection: { mode: RingConnectionMode; state: Handback['state'] | 'direct' | 'no-ring' | 'disconnected' | 'held'; message?: string } } {
  let status = {}
  try { status = JSON.parse(scheduler?.statusJson() ?? '{}') } catch { /* Status is optional; transfers remain native-owned. */ }
  const config = configuration()
  let handback: Handback | null = null
  try {
    const saved = JSON.parse(ApplicationSettings.getString(HANDBACK, '{}'))
    if (saved.key === config.key && saved.ringId === config.addresses.ring &&
        ['pending', 'queued', 'confirmed', 'failed'].includes(saved.state)) handback = saved
  } catch { /* An interrupted status write never authorizes a connection. */ }
  const lease = roleLease(), held = roleReleaseRequired(config)
  return { ...savedStatus(), scheduler: status, ringConnection: { mode: config.mode,
    state: !wanted(config) ? 'disconnected' : held ? 'held' : config.mode === 'direct' ? 'direct' :
      !config.addresses.ring ? 'no-ring' : handback?.state ?? 'pending',
    message: held ? config.mode === 'direct'
      ? 'The previous phone ring role is unverified. Connect using Via glasses + health sync first, then choose Direct to release it safely.'
      : 'The previous ring role is unverified. Connect in Direct mode first, then choose Via glasses + health sync to release it safely.' :
      lease?.ringId === config.addresses.ring && lease.message ? lease.message : handback?.message } }
}
