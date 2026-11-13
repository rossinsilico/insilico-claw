@file:OptIn(kotlinx.cinterop.ExperimentalForeignApi::class, kotlinx.cinterop.BetaInteropApi::class)

package com.faceclaw.app

import kotlin.concurrent.Volatile
import kotlinx.cinterop.ObjCSignatureOverride
import platform.CoreBluetooth.CBAdvertisementDataIsConnectable
import platform.CoreBluetooth.CBAdvertisementDataLocalNameKey
import platform.CoreBluetooth.CBAdvertisementDataManufacturerDataKey
import platform.CoreBluetooth.CBCentralManager
import platform.CoreBluetooth.CBCentralManagerDelegateProtocol
import platform.CoreBluetooth.CBCentralManagerOptionRestoreIdentifierKey
import platform.CoreBluetooth.CBCentralManagerRestoredStatePeripheralsKey
import platform.CoreBluetooth.CBCentralManagerScanOptionAllowDuplicatesKey
import platform.CoreBluetooth.CBCharacteristic
import platform.CoreBluetooth.CBCharacteristicPropertyIndicate
import platform.CoreBluetooth.CBCharacteristicPropertyNotify
import platform.CoreBluetooth.CBCharacteristicPropertyWrite
import platform.CoreBluetooth.CBCharacteristicPropertyWriteWithoutResponse
import platform.CoreBluetooth.CBCharacteristicWriteType
import platform.CoreBluetooth.CBCharacteristicWriteWithResponse
import platform.CoreBluetooth.CBCharacteristicWriteWithoutResponse
import platform.CoreBluetooth.CBConnectPeripheralOptionRequiresANCS
import platform.CoreBluetooth.CBManager
import platform.CoreBluetooth.CBManagerStateResetting
import platform.CoreBluetooth.CBManagerStateUnknown
import platform.CoreBluetooth.CBManagerStatePoweredOff
import platform.CoreBluetooth.CBManagerStatePoweredOn
import platform.CoreBluetooth.CBManagerStateUnauthorized
import platform.CoreBluetooth.CBManagerStateUnsupported
import platform.CoreBluetooth.CBPeripheral
import platform.CoreBluetooth.CBPeripheralDelegateProtocol
import platform.CoreBluetooth.CBPeripheralStateConnected
import platform.CoreBluetooth.CBPeripheralStateConnecting
import platform.CoreBluetooth.CBPeripheralStateDisconnected
import platform.CoreBluetooth.CBPeripheralStateDisconnecting
import platform.CoreBluetooth.CBService
import platform.Foundation.NSData
import platform.Foundation.NSError
import platform.Foundation.NSNumber
import platform.Foundation.NSUUID
import platform.Foundation.NSUserDefaults
import platform.darwin.NSObject
import platform.darwin.dispatch_async
import platform.darwin.dispatch_get_main_queue
import platform.darwin.dispatch_queue_create
import platform.darwin.dispatch_sync

/** Scan/state events for the phone-side device picker; delivered on the main queue. */
interface IosBleScanListener {
    /** CBManagerState raw value and CBManagerAuthorization raw value. */
    fun onBluetoothState(state: Int, authorization: Int)

    fun onAdvertisement(identifier: String, name: String, manufacturerDataHex: String, rssi: Int, connectable: Boolean)
}

/** ANCS authorization changes for a connected peripheral; delivered on the ordered listener queue. */
fun interface IosAncsAuthorizationListener {
    fun onAncsAuthorization(identifier: String, authorized: Boolean)
}

/** The canonical 8-4-4-4-12 hex form -[NSUUID initWithUUIDString:] accepts. */
private val UUID_STRING = Regex("^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$")

internal fun iosNotificationChangeConfirmed(enable: Boolean, notifying: Boolean, acknowledged: Boolean?, connected: Boolean): Boolean =
    acknowledged == true && connected && notifying == enable

internal enum class IosConnectAction { REJECTED, ACTIVE, START }
internal enum class IosCancelAction { INACTIVE, ACTIVE, START }
internal enum class IosRestoreAction { CANCEL, ADOPT, RESET_RING }
internal const val IOS_CONNECTION_WANTED_KEY = "ios.ble.session.connectionWanted"

internal fun iosDisconnectCallbackApplies(
    callbackDisconnected: Boolean,
    storedDisconnected: Boolean,
    samePeer: Boolean,
    sameEpoch: Boolean,
    connectionPendingWithoutSubmission: Boolean = false,
): Boolean = callbackDisconnected && storedDisconnected && samePeer && sameEpoch && !connectionPendingWithoutSubmission

private fun iosPeripheralStateName(state: Long): String = when (state) {
    CBPeripheralStateDisconnected -> "disconnected"
    CBPeripheralStateConnecting -> "connecting"
    CBPeripheralStateConnected -> "connected"
    CBPeripheralStateDisconnecting -> "disconnecting"
    else -> "unknown"
}

private fun iosManagerStateName(state: Long): String = when (state) {
    CBManagerStateUnknown -> "unknown"
    CBManagerStateResetting -> "resetting"
    CBManagerStateUnsupported -> "unsupported"
    CBManagerStateUnauthorized -> "unauthorized"
    CBManagerStatePoweredOff -> "powered-off"
    CBManagerStatePoweredOn -> "powered-on"
    else -> "unknown"
}

internal fun iosRestoreAction(
    identifier: String,
    allowed: Set<String>,
    ringIdentifier: String,
    enabled: Boolean,
    connectionWanted: Boolean,
): IosRestoreAction = when {
    !enabled || !connectionWanted || identifier.uppercase() !in allowed -> IosRestoreAction.CANCEL
    identifier.equals(ringIdentifier, ignoreCase = true) -> IosRestoreAction.RESET_RING
    else -> IosRestoreAction.ADOPT
}

/** Connection intent guarded by IosBleCentral's condition lock. */
internal class IosConnectIntent {
    var pending = false
        private set
    var connected = false
        private set
    var background = false
        private set
    var cancelling = false
        private set
    var cancellationSubmitted = false
        private set
    var connectionSubmitted = false
        private set
    val active: Boolean get() = pending || connected || cancelling
    private var reported = false

    fun begin(closed: Boolean, background: Boolean): IosConnectAction = when {
        closed || cancelling -> IosConnectAction.REJECTED
        pending || connected -> IosConnectAction.ACTIVE
        else -> {
            pending = true
            this.background = background
            cancellationSubmitted = false
            connectionSubmitted = false
            reported = false
            IosConnectAction.START
        }
    }

    fun acceptConnected(closed: Boolean): Boolean {
        if (closed || !pending) return false
        pending = false
        connected = true
        cancellationSubmitted = false
        connectionSubmitted = true
        reported = true
        return true
    }

    fun failed(): Boolean {
        val wasReported = reported
        pending = false
        connected = false
        background = false
        cancelling = false
        cancellationSubmitted = false
        connectionSubmitted = false
        reported = false
        return wasReported
    }

    fun beginCancel(): IosCancelAction {
        if (cancelling) return IosCancelAction.ACTIVE
        if (!pending && !connected) return IosCancelAction.INACTIVE
        pending = false
        connected = false
        reported = false
        cancelling = true
        cancellationSubmitted = false
        connectionSubmitted = false
        return IosCancelAction.START
    }

    fun withdraw() {
        pending = false
        connected = false
        background = false
        cancelling = false
        cancellationSubmitted = false
        connectionSubmitted = false
        reported = false
    }

    fun withdrawPending(): Boolean {
        if (!pending) return false
        withdraw()
        return true
    }

    fun restore(connected: Boolean) {
        pending = !connected
        this.connected = connected
        background = true
        cancelling = false
        cancellationSubmitted = false
        // Restoration describes an operation CoreBluetooth already owns.
        connectionSubmitted = true
        // Adoption emits no connected callback, so it cannot mark the protocol
        // session ready. A later native disconnect must still reach core cleanup.
        reported = connected
    }

    fun markConnectionSubmitted(): Boolean {
        if (!pending || cancelling) return false
        connectionSubmitted = true
        return true
    }

    fun reconcileCancellation(osDisconnected: Boolean, samePeer: Boolean, sameEpoch: Boolean): Boolean {
        if (!cancelling || !osDisconnected || !samePeer || !sameEpoch) return false
        failed()
        return true
    }

    fun reserveCancellationSubmission(
        managerPoweredOn: Boolean,
        osDisconnected: Boolean,
        samePeer: Boolean,
        sameEpoch: Boolean,
    ): Boolean {
        if (!cancelling || cancellationSubmitted || !managerPoweredOn || osDisconnected || !samePeer || !sameEpoch)
            return false
        cancellationSubmitted = true
        return true
    }
}

internal fun awaitIosCancellation(
    intent: IosConnectIntent,
    deadlineMs: Long,
    nowMs: () -> Long,
    attemptCurrent: () -> Boolean,
    awaitMs: (Long) -> Unit,
): Boolean {
    while (intent.cancelling) {
        if (!attemptCurrent()) return false
        val left = deadlineMs - nowMs()
        if (left <= 0L) return false
        awaitMs(left)
    }
    return attemptCurrent()
}

/**
 * CoreBluetooth central used by the shared session and stock-firmware flows on iOS. It is
 * the iOS counterpart of Android's FaceclawBleManager: every [SessionLink]/[StockLink] call
 * blocks the calling (worker) thread until the delegate reports completion or the timeout
 * elapses. CoreBluetooth runs on a private serial queue; the calling thread hands it work
 * with dispatch_sync and waits on a condition the delegate signals. Addresses are peripheral
 * identifier UUID strings (case-insensitive). Inbound notifications and connection-state
 * changes go to the registered listeners on a separate serial queue; scan events go to main.
 *
 * Locking: [cond] (non-reentrant) guards all peer state. It is never held across a
 * dispatch_sync or a listener callback. The BLE queue never calls session/stock/ANCS listeners:
 * they can acquire the session lock or synchronously call back into this transport. Calling
 * them on BLE would deadlock against a worker holding that lock while waiting for BLE, or
 * trap when a notification causes a synchronous disconnect on the same queue.
 */
class IosBleCentral(private val platform: ProtocolPlatform = IosProtocolPlatform) : SessionLink, StockLink {
    companion object {
        const val TAG = "FaceclawBle"
        const val ADVERTISEMENT_CACHE = 512
        private const val READY_TIMEOUT_MS = 30_000
        private const val CANCELLATION_RECHECK_MS = 250L
        private const val DEFAULT_ATT_MTU = 23
        private const val MAX_ATT_MTU = 517
        private const val RESTORATION_IDENTIFIER = "com.rosspingatore.faceclawpilot.session.central"
    }

    private class Peer(val peripheral: CBPeripheral) {
        val identifier: String = peripheral.identifier.UUIDString.uppercase()
        val characteristics = HashMap<String, CBCharacteristic>()
        val connect = IosConnectIntent()
        var failure: String? = null
        var discoverPending = false
        var pendingServices = 0
        var notifyPending: String? = null
        var notifyResult: Boolean? = null
        var writePending = false
        var writeError: String? = null
        var readyForWriteWithoutResponse = false
        var requiresAncs = false
    }

    private class Advertisement(var name: String, var manufacturerDataHex: String)

    internal val queue = dispatch_queue_create("com.faceclaw.ble", null)
    private val listenerQueue = dispatch_queue_create("com.faceclaw.ble.listeners", null)
    private val cond: ProtocolCondition = platform.createCondition()
    /** Serializes lazy manager creation without ever taking the BLE queue from its own callback. */
    private val centralCreationLock: ProtocolLock = platform.createLock()
    private val peers = HashMap<String, Peer>()
    private val cancellationEpochs = HashMap<String, Long>()
    private val advertisements = LinkedHashMap<String, Advertisement>()
    private val delegate = Delegate(this)
    private var central: CBCentralManager? = null

    @Volatile private var bluetoothState: Long = 0
    @Volatile private var scanRequested = false
    @Volatile private var scanListener: IosBleScanListener? = null
    @Volatile private var ancsListener: IosAncsAuthorizationListener? = null
    @Volatile private var sessionListener: FaceclawBleListener? = null
    @Volatile private var stockListener: StockLinkListener? = null
    @Volatile private var closed = false
    @Volatile private var cachedConnectOnly = false
    private var restorationEnabled = false
    private var allowedRestorationIdentifiers = emptySet<String>()
    private var restoredRingIdentifier = ""
    private var restorationListener: ((Int) -> Unit)? = null
    private var pendingRestoredPeers: Int? = null
    internal var centralCreationCount = 0
        private set

    // ----- listeners ------------------------------------------------------------------

    /** The session core (a FaceclawBleListener); called on the ordered listener queue. */
    fun setSessionListener(listener: FaceclawBleListener?) {
        sessionListener = listener
    }

    override fun setListener(listener: StockLinkListener?) {
        stockListener = listener
    }

    fun setAncsAuthorizationListener(listener: IosAncsAuthorizationListener?) {
        ancsListener = listener
    }

    fun setSessionRestorationListener(listener: ((Int) -> Unit)?) {
        val pending = cond.withLock {
            restorationListener = listener
            if (listener == null) null else pendingRestoredPeers.also { pendingRestoredPeers = null }
        }
        if (listener != null && pending != null)
            dispatch_async(listenerQueue) { if (!closed && restorationListener === listener) listener(pending) }
    }

    fun setConnectionWanted(wanted: Boolean) {
        NSUserDefaults.standardUserDefaults.setBool(wanted, IOS_CONNECTION_WANTED_KEY)
    }

    private fun connectionWanted(): Boolean {
        val defaults = NSUserDefaults.standardUserDefaults
        return defaults.objectForKey(IOS_CONNECTION_WANTED_KEY)
            ?.let { defaults.boolForKey(IOS_CONNECTION_WANTED_KEY) } ?: true
    }

    private fun restorationConnectionWanted(): Boolean {
        val defaults = NSUserDefaults.standardUserDefaults
        return defaults.objectForKey(IOS_CONNECTION_WANTED_KEY) != null &&
            defaults.boolForKey(IOS_CONNECTION_WANTED_KEY)
    }

    internal fun connectionWantedForTest(): Boolean = connectionWanted()
    internal fun restorationConnectionWantedForTest(): Boolean = restorationConnectionWanted()
    internal fun restorationActiveForTest(): Boolean = restorationEnabled

    fun configureStateRestoration(enabled: Boolean, allowedIdentifiers: Set<String>, ringIdentifier: String) {
        cond.withLock {
            allowedRestorationIdentifiers = allowedIdentifiers.map { it.uppercase() }.toSet()
            restoredRingIdentifier = ringIdentifier.uppercase()
            restorationEnabled = enabled && restorationConnectionWanted()
        }
        if (restorationEnabled && !closed) ensureCentral()
    }

    fun setCachedConnectOnly(enabled: Boolean) {
        cachedConnectOnly = enabled
    }

    /** Connect [identifier] with CBConnectPeripheralOptionRequiresANCS (the right arm relays iPhone notifications). */
    fun setRequiresAncs(identifier: String, required: Boolean) {
        val key = identifier.uppercase()
        cond.withLock { peers[key]?.requiresAncs = required }
        pendingAncs[key] = required
    }

    private val pendingAncs = HashMap<String, Boolean>()

    private data class CancellationSettlement(val settled: Boolean, val state: Long)

    /** Whether the OS granted ANCS for the peripheral (false when unknown or disconnected). */
    fun isAncsAuthorized(identifier: String): Boolean =
        cond.withLock { peers[identifier.uppercase()]?.peripheral?.ancsAuthorized ?: false }

    // ----- readiness and scanning -----------------------------------------------------------

    /** Current CBManagerState raw value (0 until the central reports). */
    fun bluetoothState(): Int = bluetoothState.toInt()

    fun authorization(): Int = CBManager.authorization.toInt()

    /**
     * Creates the central (which triggers the permission prompt on first use) and waits for
     * it to power on. Returns null when ready or a user-facing message (the same texts the
     * TypeScript transport used).
     */
    fun waitForPoweredOn(timeoutMs: Int = READY_TIMEOUT_MS): String? =
        waitForPoweredOn(timeoutMs, null, 0L)

    private fun waitForPoweredOn(timeoutMs: Int, identifier: String?, epoch: Long): String? {
        ensureCentral()
        val deadline = platform.elapsedRealtimeMs() + timeoutMs
        cond.lock()
        try {
            while (true) {
                if (identifier != null && cancellationEpochs.getOrElse(identifier) { 0L } != epoch) return "Cancelled"
                when (bluetoothState) {
                    CBManagerStatePoweredOn -> return null
                    CBManagerStateUnsupported -> return "Bluetooth is unavailable on this device. Use the physical iPhone."
                    CBManagerStateUnauthorized -> return "Allow Faceclaw to use Bluetooth in iPhone Settings."
                    CBManagerStatePoweredOff -> return "Turn on Bluetooth, then try again."
                }
                val left = deadline - platform.elapsedRealtimeMs()
                if (left <= 0) return "Waiting for Bluetooth permission timed out. Try again after allowing Bluetooth."
                cond.awaitMs(left)
            }
        } finally {
            cond.unlock()
        }
    }

    private fun ensureCentral() {
        var created = false
        centralCreationLock.withLock {
            if (central == null) {
                val options = if (restorationEnabled)
                    mapOf<Any?, Any?>(CBCentralManagerOptionRestoreIdentifierKey to RESTORATION_IDENTIFIER) else null
                central = CBCentralManager(delegate = delegate, queue = queue, options = options)
                centralCreationCount++
                created = true
            }
        }
        if (!created) {
            // Re-report the current state so a fresh listener learns it.
            val listener = scanListener
            if (listener != null) {
                val state = bluetoothState.toInt()
                val authorization = authorization()
                dispatch_async(dispatch_get_main_queue()) { listener.onBluetoothState(state, authorization) }
            }
        }
    }

    /**
     * Registers the scan/state listener and creates the central if needed, so a listener that
     * only waits for readiness (no scan) still receives the state report; an existing central's
     * current state is re-reported to the new listener on the main queue.
     */
    fun setScanListener(listener: IosBleScanListener?) {
        scanListener = listener
        if (listener != null && !closed) ensureCentral()
    }

    /** Starts (or keeps) scanning for all peripherals with duplicates; events reach the scan listener on main. */
    fun startScan() {
        scanRequested = true
        ensureCentral()
        dispatch_sync(queue) {
            val manager = central ?: return@dispatch_sync
            if (manager.state == CBManagerStatePoweredOn) beginScan(manager)
        }
    }

    fun stopScan() {
        scanRequested = false
        dispatch_sync(queue) { central?.stopScan() }
    }

    private fun beginScan(manager: CBCentralManager) {
        manager.scanForPeripheralsWithServices(null, mapOf(CBCentralManagerScanOptionAllowDuplicatesKey to true))
    }

    /** Known peripheral identifiers from this process's scans/retrievals (uppercase). */
    fun knownIdentifiers(): List<String> = cond.withLock { peers.keys.toList() }

    // ----- SessionLink / StockLink ----------------------------------------------------------

    override fun connect(address: String, timeoutMs: Int): Boolean {
        val identifier = address.uppercase()
        val epoch = cond.withLock { cancellationEpochs.getOrElse(identifier) { 0L } }
        val deadline = platform.elapsedRealtimeMs() + timeoutMs
        val ready = waitForPoweredOn(minOf(timeoutMs, READY_TIMEOUT_MS), identifier, epoch)
        if (ready != null) {
            log("connect $identifier: $ready")
            return false
        }
        val peer = if (cachedConnectOnly) findCached(identifier) else findOrDiscover(identifier, deadline, epoch)
        if (peer == null) run {
            log("connect $identifier: peripheral not found")
            return false
        }
        val cancellation = awaitPriorCancellation(identifier, peer, epoch, deadline)
        if (!cancellation.settled) {
            log("connect: prior cancellation did not settle state=" + iosPeripheralStateName(cancellation.state))
            return false
        }
        val attempt = cond.withLock {
            if (cancellationEpochs.getOrElse(identifier) { 0L } != epoch) return false
            when (peer.connect.begin(closed, background = false)) {
                IosConnectAction.REJECTED -> return false
                IosConnectAction.ACTIVE -> false to false
                IosConnectAction.START -> {
                    peer.characteristics.clear()
                    peer.failure = null
                    true to (peer.requiresAncs || (pendingAncs[identifier] ?: false))
                }
            }
        }
        if (attempt.first) {
            dispatch_sync(queue) {
                val manager = central ?: return@dispatch_sync
                if (!cond.withLock { !closed && cancellationEpochs.getOrElse(identifier) { 0L } == epoch && peer.connect.markConnectionSubmitted() }) return@dispatch_sync
                manager.connectPeripheral(
                    peer.peripheral,
                    if (attempt.second) mapOf(CBConnectPeripheralOptionRequiresANCS to true) else null,
                )
                iosBleEvent("request", background = false)
            }
        }
        val attemptBackground = cond.withLock { peer.connect.background }
        var timedOut = false
        var cancelTimedAttempt = false
        val connected = cond.withLock {
            while (peer.connect.pending) {
                val left = deadline - platform.elapsedRealtimeMs()
                if (left <= 0) break
                cond.awaitMs(left)
            }
            val ok = peer.connect.connected
            if (!ok && peer.connect.pending) {
                timedOut = true
                if (!peer.connect.background) cancelTimedAttempt = peer.connect.beginCancel() == IosCancelAction.START
            }
            ok
        }
        if (!connected) {
            if (timedOut) iosBleEvent("timeout", attemptBackground)
            log("connect $identifier failed: " + (cond.withLock { peer.failure } ?: "timeout"))
            if (cancelTimedAttempt) {
                var awaitingCallback = false
                dispatch_sync(queue) {
                    if (peer.peripheral.state != CBPeripheralStateDisconnected) {
                        central?.cancelPeripheralConnection(peer.peripheral)
                        awaitingCallback = true
                    }
                }
                if (!awaitingCallback) cond.withLock { peer.connect.failed(); cond.signalAll() }
                iosBleEvent("cancelled", attemptBackground)
            }
        }
        return connected
    }

    override fun beginConnect(address: String, background: Boolean): Boolean {
        if (!background || closed) return false
        val identifier = address.uppercase()
        val epoch = cond.withLock { cancellationEpochs.getOrElse(identifier) { 0L } }
        if (!UUID_STRING.matches(identifier)) return false
        val manager = central ?: return false
        var peer = cond.withLock { peers[identifier] }
        if (peer == null) {
            dispatch_sync(queue) {
                if (manager.state != CBManagerStatePoweredOn) return@dispatch_sync
                val uuid = NSUUID(uUIDString = identifier)
                val peripheral = manager.retrievePeripheralsWithIdentifiers(listOf(uuid)).firstOrNull() as? CBPeripheral
                if (peripheral != null) peer = remember(peripheral)
            }
        }
        val target = peer ?: return false
        val attempt = cond.withLock {
            if (cancellationEpochs.getOrElse(identifier) { 0L } != epoch) return false
            when (target.connect.begin(closed, background = true)) {
                IosConnectAction.REJECTED -> return false
                IosConnectAction.ACTIVE -> return true
                IosConnectAction.START -> target.requiresAncs || (pendingAncs[identifier] ?: false)
            }
        }
        var started = false
        dispatch_sync(queue) {
            if (manager.state != CBManagerStatePoweredOn) return@dispatch_sync
            if (!cond.withLock { !closed && cancellationEpochs.getOrElse(identifier) { 0L } == epoch && target.connect.markConnectionSubmitted() }) return@dispatch_sync
            manager.connectPeripheral(
                target.peripheral,
                if (attempt) mapOf(CBConnectPeripheralOptionRequiresANCS to true) else null,
            )
            iosBleEvent("request", background = true)
            started = true
        }
        if (!started) cond.withLock {
            target.connect.withdrawPending()
            cond.signalAll()
        }
        return started
    }

    private fun findOrDiscover(identifier: String, deadline: Long, epoch: Long): Peer? {
        cond.withLock { peers[identifier] }?.let { return it }
        var retrieved: CBPeripheral? = null
        dispatch_sync(queue) {
            val manager = central ?: return@dispatch_sync
            // NSUUID's initializer can return nil, but Kotlin imports it as a
            // non-null constructor: screen out malformed identifiers first.
            if (!UUID_STRING.matches(identifier)) return@dispatch_sync
            val uuid = NSUUID(uUIDString = identifier)
            retrieved = manager.retrievePeripheralsWithIdentifiers(listOf(uuid)).firstOrNull() as? CBPeripheral
        }
        retrieved?.let { return remember(it) }
        // Not known to the system: scan until the identifier shows up.
        val wasScanning = scanRequested
        startScan()
        try {
            cond.lock()
            try {
                while (true) {
                    if (cancellationEpochs.getOrElse(identifier) { 0L } != epoch) return null
                    peers[identifier]?.let { return it }
                    val left = deadline - platform.elapsedRealtimeMs()
                    if (left <= 0) return null
                    cond.awaitMs(left)
                }
            } finally {
                cond.unlock()
            }
        } finally {
            if (!wasScanning) stopScan()
        }
    }

    private fun findCached(identifier: String): Peer? {
        cond.withLock { peers[identifier] }?.let { return it }
        var retrieved: CBPeripheral? = null
        dispatch_sync(queue) {
            val manager = central ?: return@dispatch_sync
            if (!UUID_STRING.matches(identifier)) return@dispatch_sync
            val peripheral = manager.retrievePeripheralsWithIdentifiers(listOf(NSUUID(uUIDString = identifier)))
                .firstOrNull() as? CBPeripheral
            if (peripheral != null) retrieved = peripheral
        }
        return retrieved?.let(::remember)
    }

    override fun requestHighPriority(address: String) {}

    override fun requestMtu(address: String, mtu: Int, timeoutMs: Int): Boolean = true

    override fun prepareLink(address: String, desiredMtu: Int, timeoutMs: Int) {}

    override fun negotiatedMtu(address: String): Int {
        val peer = cond.withLock { peers[address.uppercase()] } ?: return DEFAULT_ATT_MTU
        // CoreBluetooth reports the ATT payload; Android reports the ATT MTU (payload + 3).
        val payload = peer.peripheral.maximumWriteValueLengthForType(CBCharacteristicWriteWithoutResponse).toInt()
        return (payload + 3).coerceIn(DEFAULT_ATT_MTU, MAX_ATT_MTU)
    }

    override fun discoverServices(address: String, timeoutMs: Int): Boolean {
        val peer = connectedPeer(address) ?: return false
        val deadline = platform.elapsedRealtimeMs() + timeoutMs
        cond.withLock {
            peer.discoverPending = true
            peer.pendingServices = 0
            peer.characteristics.clear()
        }
        dispatch_sync(queue) { peer.peripheral.discoverServices(null) }
        return cond.withLock {
            while (peer.discoverPending && peer.connect.connected) {
                val left = deadline - platform.elapsedRealtimeMs()
                if (left <= 0) break
                cond.awaitMs(left)
            }
            !peer.discoverPending && peer.connect.connected && peer.characteristics.isNotEmpty()
        }
    }

    override fun enableNotifications(address: String, characteristicUuid: String, timeoutMs: Int): Boolean =
        enableNotifications(address, characteristicUuid, true, timeoutMs)

    override fun enableNotifications(address: String, characteristicUuid: String, enable: Boolean, timeoutMs: Int): Boolean {
        val identifier = address.uppercase()
        val epoch = cond.withLock { cancellationEpochs.getOrElse(identifier) { 0L } }
        val peer = connectedPeer(address) ?: return false
        val key = characteristicUuid.lowercase()
        val characteristic = cond.withLock { peer.characteristics[key] } ?: run {
            log("notifications $key: characteristic unavailable")
            return false
        }
        val notifiable = (characteristic.properties and (CBCharacteristicPropertyNotify or CBCharacteristicPropertyIndicate)) != 0uL
        if (!notifiable) {
            log("notifications $key: not notifiable")
            return false
        }
        if (characteristic.isNotifying == enable) return true
        val deadline = platform.elapsedRealtimeMs() + timeoutMs
        cond.withLock {
            peer.notifyPending = key
            peer.notifyResult = null
        }
        var submitted = false
        dispatch_sync(queue) {
            if (!cond.withLock { cancellationEpochs.getOrElse(identifier) { 0L } == epoch && peer.connect.connected }) return@dispatch_sync
            peer.peripheral.setNotifyValue(enable, characteristic)
            submitted = true
        }
        if (!submitted) return false
        return cond.withLock {
            while (peer.notifyPending == key && peer.connect.connected) {
                val left = deadline - platform.elapsedRealtimeMs()
                if (left <= 0) break
                cond.awaitMs(left)
            }
            val result = iosNotificationChangeConfirmed(enable, characteristic.isNotifying, peer.notifyResult, peer.connect.connected)
            if (peer.notifyPending == key) peer.notifyPending = null
            result
        }
    }

    override fun writeFrames(
        address: String,
        characteristicUuid: String,
        frames: List<ByteArray>,
        mode: GattWriteMode,
        timeoutMs: Int,
    ): Boolean {
        val identifier = address.uppercase()
        val epoch = cond.withLock { cancellationEpochs.getOrElse(identifier) { 0L } }
        val peer = connectedPeer(address) ?: return false
        val key = characteristicUuid.lowercase()
        val characteristic = cond.withLock { peer.characteristics[key] } ?: run {
            log("write $key: characteristic unavailable")
            return false
        }
        val writable = (characteristic.properties and (CBCharacteristicPropertyWrite or CBCharacteristicPropertyWriteWithoutResponse)) != 0uL
        if (!writable) return false
        val withoutResponseSupported = (characteristic.properties and CBCharacteristicPropertyWriteWithoutResponse) != 0uL
        val type: CBCharacteristicWriteType =
            if (mode == GattWriteMode.WITHOUT_RESPONSE && withoutResponseSupported) CBCharacteristicWriteWithoutResponse
            else CBCharacteristicWriteWithResponse
        val limit = peer.peripheral.maximumWriteValueLengthForType(type).toInt()
        val deadline = platform.elapsedRealtimeMs() + timeoutMs
        for (frame in frames) {
            if (frame.size > limit) {
                log("write $key: ${frame.size} bytes exceeds the ${limit}-byte limit")
                return false
            }
            val data = frame.data()
            if (type == CBCharacteristicWriteWithResponse) {
                cond.withLock {
                    peer.writePending = true
                    peer.writeError = null
                }
                var submitted = false
                dispatch_sync(queue) {
                    if (!cond.withLock { cancellationEpochs.getOrElse(identifier) { 0L } == epoch && peer.connect.connected }) return@dispatch_sync
                    peer.peripheral.writeValue(data, characteristic, type)
                    submitted = true
                }
                if (!submitted) return false
                val ok = cond.withLock {
                    while (peer.writePending && peer.connect.connected) {
                        val left = deadline - platform.elapsedRealtimeMs()
                        if (left <= 0) break
                        cond.awaitMs(left)
                    }
                    val done = !peer.writePending && peer.writeError == null && peer.connect.connected
                    peer.writePending = false
                    done
                }
                if (!ok) {
                    log("write $key failed: " + (cond.withLock { peer.writeError } ?: "timeout"))
                    return false
                }
                IosBleTraffic.recordWrite(frame.size)
            } else {
                while (true) {
                    var sent = false
                    var connected = true
                    dispatch_sync(queue) {
                        if (!cond.withLock { cancellationEpochs.getOrElse(identifier) { 0L } == epoch && peer.connect.connected }
                            || peer.peripheral.state != CBPeripheralStateConnected) {
                            connected = false
                        } else if (peer.peripheral.canSendWriteWithoutResponse) {
                            peer.peripheral.writeValue(data, characteristic, type)
                            sent = true
                        }
                    }
                    if (!connected) return false
                    if (sent) {
                        IosBleTraffic.recordWrite(frame.size)
                        break
                    }
                    // Pace on the controller's buffer: wait for peripheralIsReadyToSendWriteWithoutResponse.
                    val ready = cond.withLock {
                        peer.readyForWriteWithoutResponse = false
                        while (!peer.readyForWriteWithoutResponse && peer.connect.connected) {
                            val left = deadline - platform.elapsedRealtimeMs()
                            if (left <= 0) break
                            cond.awaitMs(minOf(left, 50))
                            // canSendWriteWithoutResponse may flip without a callback; re-check.
                            if (peer.peripheral.canSendWriteWithoutResponse) break
                        }
                        peer.connect.connected && (peer.readyForWriteWithoutResponse || peer.peripheral.canSendWriteWithoutResponse)
                    }
                    if (!ready) {
                        if (platform.elapsedRealtimeMs() >= deadline) {
                            log("write $key: timed out waiting for the write buffer")
                            return false
                        }
                        if (!cond.withLock { peer.connect.connected }) return false
                    }
                }
            }
        }
        return true
    }

    override fun isConnected(address: String): Boolean =
        cond.withLock { peers[address.uppercase()]?.connect?.connected ?: false }

    override fun bondState(address: String): BondState = BondState.UNKNOWN

    override fun isBonded(address: String): Boolean = true

    /** CoreBluetooth pairs by itself when an attribute needs it. */
    override fun requestBond(address: String) {}

    /** Only iOS Settings can remove a pairing. */
    override fun removeBond(address: String): Boolean = false

    override fun hasCharacteristic(address: String, characteristicUuid: String): Boolean {
        val peer = connectedPeer(address) ?: return false
        return cond.withLock { peer.characteristics.containsKey(characteristicUuid.lowercase()) }
    }

    /** CoreBluetooth follows Service Changed itself; discovering again is all there is. */
    override fun refreshServices(address: String, timeoutMs: Int): Boolean = discoverServices(address, timeoutMs)

    override fun prepareBenchmarkLink(address: String, mode: Int) {}

    override fun recordDisplayFrameSent() {
        IosBleTraffic.recordDisplayFrame()
    }

    override fun disconnect(address: String) {
        val identifier = address.uppercase()
        val entry = cond.withLock {
            cancellationEpochs[identifier] = cancellationEpochs.getOrElse(identifier) { 0L } + 1L
            cond.signalAll()
            peers[identifier] to cancellationEpochs.getOrElse(identifier) { 0L }
        }
        val peer = entry.first ?: return
        val epoch = entry.second
        var cancelAction = IosCancelAction.INACTIVE
        val background = cond.withLock {
            val value = peer.connect.background
            cancelAction = peer.connect.beginCancel()
            cond.signalAll()
            value
        }
        if (cancelAction == IosCancelAction.INACTIVE) {
            reconcileCancelledPeer(identifier, peer, epoch)
            return
        }
        var submitted = false
        dispatch_sync(queue) {
            val manager = central ?: return@dispatch_sync
            val state = peer.peripheral.state
            submitted = submitCancellationIfNeeded(manager, identifier, peer, epoch, state)
        }
        if (submitted) iosBleEvent("cancelled", background)
    }

    override fun disconnectAndAwait(address: String, timeoutMs: Int): Boolean {
        val identifier = address.uppercase()
        disconnect(identifier)
        val deadline = platform.elapsedRealtimeMs() + timeoutMs
        val entry = cond.withLock {
            val peer = peers[identifier] ?: return@withLock null
            peer to cancellationEpochs.getOrElse(identifier) { 0L }
        }
        if (entry == null) return true
        if (!awaitPriorCancellation(identifier, entry.first, entry.second, deadline).settled) return false
        return cond.withLock {
            peers[identifier] === entry.first &&
                cancellationEpochs.getOrElse(identifier) { 0L } == entry.second &&
                !entry.first.connect.active
        }
    }

    override fun close() {
        closed = true
        scanRequested = false
        val all = cond.withLock { peers.values.toList() }
        val background = cond.withLock { all.any { it.connect.background } }
        cond.withLock {
            for (peer in all) peer.connect.beginCancel()
            cond.signalAll()
        }
        dispatch_sync(queue) {
            central?.stopScan()
            for (peer in all) if (peer.peripheral.state != CBPeripheralStateDisconnected) central?.cancelPeripheralConnection(peer.peripheral)
        }
        for (peer in all) failPeer(peer, "Closed", notifyListeners = false)
        iosBleEvent("closed", background)
    }

    // ----- internals ------------------------------------------------------------------

    private fun connectedPeer(address: String): Peer? {
        val peer = cond.withLock { peers[address.uppercase()]?.takeIf { it.connect.connected } }
        if (peer == null) log("$address is not connected")
        return peer
    }

    private fun remember(peripheral: CBPeripheral): Peer {
        val identifier = peripheral.identifier.UUIDString.uppercase()
        return cond.withLock {
            peers.getOrPut(identifier) {
                peripheral.delegate = delegate
                Peer(peripheral).also { it.requiresAncs = pendingAncs[identifier] ?: false }
            }
        }
    }

    private fun peripheralState(peer: Peer): Long {
        var state = CBPeripheralStateDisconnected
        dispatch_sync(queue) { state = peer.peripheral.state }
        return state
    }

    private fun reconcileCancelledPeer(identifier: String, peer: Peer, epoch: Long, state: Long = peripheralState(peer)): Boolean =
        cond.withLock {
            val samePeer = peers[identifier] === peer
            val sameEpoch = cancellationEpochs.getOrElse(identifier) { 0L } == epoch
            val reconciled = peer.connect.reconcileCancellation(
                osDisconnected = state == CBPeripheralStateDisconnected,
                samePeer = samePeer,
                sameEpoch = sameEpoch,
            )
            if (reconciled) {
                peer.failure = null
                cond.signalAll()
            }
            reconciled
        }

    /** Called only on the BLE queue, with CoreBluetooth state read before taking [cond]. */
    private fun submitCancellationIfNeeded(
        manager: CBCentralManager,
        identifier: String,
        peer: Peer,
        epoch: Long,
        state: Long,
    ): Boolean {
        var settled = false
        val submit = cond.withLock {
            val samePeer = peers[identifier] === peer
            val sameEpoch = cancellationEpochs.getOrElse(identifier) { 0L } == epoch
            if (peer.connect.reconcileCancellation(
                    osDisconnected = state == CBPeripheralStateDisconnected,
                    samePeer = samePeer,
                    sameEpoch = sameEpoch,
                )) {
                peer.failure = null
                cond.signalAll()
                settled = true
                return@withLock false
            }
            peer.connect.reserveCancellationSubmission(
                managerPoweredOn = manager.state == CBManagerStatePoweredOn,
                osDisconnected = state == CBPeripheralStateDisconnected,
                samePeer = samePeer,
                sameEpoch = sameEpoch,
            )
        }
        if (settled) log("cancellation settled state=disconnected")
        if (submit) {
            manager.cancelPeripheralConnection(peer.peripheral)
            log("cancellation submitted managerState=" + iosManagerStateName(manager.state) +
                " storedState=" + iosPeripheralStateName(state))
        }
        return submit
    }

    private fun awaitPriorCancellation(identifier: String, peer: Peer, epoch: Long, deadlineMs: Long): CancellationSettlement {
        var state = peripheralState(peer)
        while (true) {
            cond.withLock {
                val samePeer = peers[identifier] === peer
                val sameEpoch = cancellationEpochs.getOrElse(identifier) { 0L } == epoch
                if (peer.connect.reconcileCancellation(
                        osDisconnected = state == CBPeripheralStateDisconnected,
                        samePeer = samePeer,
                        sameEpoch = sameEpoch,
                    )) {
                    peer.failure = null
                    cond.signalAll()
                }
                if (!closed && samePeer && sameEpoch && !peer.connect.cancelling)
                    return CancellationSettlement(true, state)
                if (closed || !samePeer || !sameEpoch)
                    return CancellationSettlement(false, state)
                val left = deadlineMs - platform.elapsedRealtimeMs()
                if (left <= 0L) return CancellationSettlement(false, state)
                cond.awaitMs(minOf(left, CANCELLATION_RECHECK_MS))
            }
            state = peripheralState(peer)
        }
    }

    /** Marks the peer disconnected, wakes every waiter and (optionally) tells the listeners. */
    private fun failPeer(peer: Peer, reason: String, notifyListeners: Boolean): Boolean {
        val wasReported = cond.withLock { failPeerLocked(peer, reason) }
        if (notifyListeners && wasReported) emitConnectionState(peer.identifier, false)
        return wasReported
    }

    /** Caller holds [cond], so callback admission and failure form one transition. */
    private fun failPeerLocked(peer: Peer, reason: String): Boolean {
        val reported = peer.connect.failed()
        peer.failure = reason
        peer.discoverPending = false
        peer.notifyPending = null
        peer.writePending = false
        peer.readyForWriteWithoutResponse = false
        peer.characteristics.clear()
        cond.signalAll()
        return reported
    }

    internal fun emitConnectionState(identifier: String, connected: Boolean) {
        val session = sessionListener
        val stock = stockListener
        dispatch_async(listenerQueue) {
            if (!closed && sessionListener === session) session?.onConnectionStateChange(identifier, connected)
            if (!closed && stockListener === stock) stock?.onConnectionStateChange(identifier, connected)
        }
    }

    internal fun emitNotification(identifier: String, uuid: String, data: ByteArray) {
        val session = sessionListener
        val stock = stockListener
        dispatch_async(listenerQueue) {
            if (!closed && sessionListener === session) session?.onNotification(identifier, uuid, data)
            if (!closed && stockListener === stock) stock?.onNotification(identifier, uuid, data)
        }
    }

    internal fun emitAncsAuthorization(identifier: String, authorized: Boolean) {
        val listener = ancsListener
        dispatch_async(listenerQueue) {
            if (!closed && ancsListener === listener) listener?.onAncsAuthorization(identifier, authorized)
        }
    }

    private fun log(message: String) = PlatformLog.i(TAG, message)

    // ----- delegate callbacks (BLE queue) ----------------------------------------------------

    private fun onStateUpdated(manager: CBCentralManager) {
        val state = manager.state
        bluetoothState = state
        cond.withLock { cond.signalAll() }
        val listener = scanListener
        if (listener != null) {
            val authorization = authorization()
            dispatch_async(dispatch_get_main_queue()) { listener.onBluetoothState(state.toInt(), authorization) }
        }
        if (state != CBManagerStatePoweredOn) {
            val all = cond.withLock { peers.values.toList() }
            for (peer in all) {
                val status = cond.withLock { Triple(peer.connect.active, peer.connect.background, peer.connect.cancelling) }
                if (!status.first) continue
                if (status.third) {
                    val epoch = cond.withLock { cancellationEpochs.getOrElse(peer.identifier) { 0L } }
                    reconcileCancelledPeer(peer.identifier, peer, epoch, peer.peripheral.state)
                } else {
                    val reported = failPeer(peer, "Bluetooth is unavailable", notifyListeners = true)
                    iosBleEvent(if (reported) "disconnected" else "failed", status.second)
                }
            }
        } else {
            val pending = cond.withLock {
                peers.values.map { it to cancellationEpochs.getOrElse(it.identifier) { 0L } }
            }
            for ((peer, epoch) in pending) {
                val stateNow = peer.peripheral.state
                submitCancellationIfNeeded(manager, peer.identifier, peer, epoch, stateNow)
            }
            if (scanRequested) beginScan(manager)
        }
    }

    private fun onRestored(manager: CBCentralManager, state: Map<Any?, *>) {
        val peripherals = state[CBCentralManagerRestoredStatePeripheralsKey] as? List<*> ?: emptyList<Any?>()
        val policy = cond.withLock {
            Triple(allowedRestorationIdentifiers, restoredRingIdentifier, restorationEnabled)
        }
        var restored = 0
        for (item in peripherals) {
            val peripheral = item as? CBPeripheral ?: continue
            val identifier = peripheral.identifier.UUIDString.uppercase()
            when (iosRestoreAction(identifier, policy.first, policy.second, policy.third,
                    restorationConnectionWanted())) {
                IosRestoreAction.CANCEL -> {
                    manager.cancelPeripheralConnection(peripheral)
                    continue
                }
                IosRestoreAction.RESET_RING -> {
                    restored++
                    val peer = remember(peripheral)
                    val restoredState = peripheral.state
                    val storedState = peer.peripheral.state
                    val samePeripheral = peer.peripheral === peripheral
                    log("restore ring reset managerState=" + iosManagerStateName(manager.state) +
                        " restoredState=" + iosPeripheralStateName(restoredState) +
                        " storedState=" + iosPeripheralStateName(storedState) +
                        " samePeripheral=" + samePeripheral)
                    val reset = cond.withLock {
                        val shouldCancel = if (samePeripheral && restoredState == CBPeripheralStateDisconnected &&
                            storedState == CBPeripheralStateDisconnected) {
                            peer.connect.withdraw()
                            false
                        } else {
                            if (!peer.connect.active)
                                peer.connect.restore(storedState == CBPeripheralStateConnected)
                            peer.connect.beginCancel()
                            true
                        }
                        cond.signalAll()
                        shouldCancel to cancellationEpochs.getOrElse(identifier) { 0L }
                    }
                    if (reset.first && samePeripheral)
                        submitCancellationIfNeeded(manager, identifier, peer, reset.second, storedState)
                    else if (reset.first)
                        log("cancellation deferred samePeripheral=false")
                    else
                        log("cancellation settled state=disconnected")
                    continue
                }
                IosRestoreAction.ADOPT -> restored++
            }
            val peer = remember(peripheral)
            val restoredState = peripheral.state
            cond.withLock {
                peer.connect.restore(restoredState == CBPeripheralStateConnected)
                peer.characteristics.clear()
                for (service in peripheral.services?.mapNotNull { it as? CBService } ?: emptyList()) {
                    for (entry in service.characteristics ?: emptyList<Any?>()) {
                        val characteristic = entry as? CBCharacteristic ?: continue
                        peer.characteristics[characteristic.UUID.UUIDString.lowercase()] = characteristic
                    }
                }
                cond.signalAll()
            }
        }
        val listener = cond.withLock {
            restorationListener.also { if (it == null) pendingRestoredPeers = restored }
        }
        if (listener != null)
            dispatch_async(listenerQueue) { if (!closed && restorationListener === listener) listener(restored) }
    }

    private fun onDiscovered(peripheral: CBPeripheral, advertisementData: Map<Any?, *>, rssi: NSNumber) {
        val peer = remember(peripheral)
        cond.withLock { cond.signalAll() } // findOrDiscover may be waiting for this identifier
        val listener = scanListener ?: return
        val manufacturer = (advertisementData[CBAdvertisementDataManufacturerDataKey] as? NSData)?.byteArray()
        val advertisedName = advertisementData[CBAdvertisementDataLocalNameKey] as? String
        val connectable = (advertisementData[CBAdvertisementDataIsConnectable] as? NSNumber)?.boolValue ?: true
        val merged = cond.withLock {
            val previous = advertisements.remove(peer.identifier)
            val name = advertisedName ?: peripheral.name ?: previous?.name ?: ""
            val hex = if (manufacturer != null) BinaryEncoding.bytesToHex(manufacturer) else previous?.manufacturerDataHex ?: ""
            if (advertisements.size >= ADVERTISEMENT_CACHE) advertisements.remove(advertisements.keys.first())
            Advertisement(name, hex).also { advertisements[peer.identifier] = it }
        }
        val identifier = peer.identifier
        val level = rssi.intValue
        dispatch_async(dispatch_get_main_queue()) {
            listener.onAdvertisement(identifier, merged.name, merged.manufacturerDataHex, level, connectable)
        }
    }

    private fun onConnected(peripheral: CBPeripheral) {
        val peer = remember(peripheral)
        val background = cond.withLock { peer.connect.background }
        val accepted = cond.withLock {
            if (!peer.connect.acceptConnected(closed)) return@withLock false
            peer.failure = null
            cond.signalAll()
            true
        }
        if (!accepted) {
            central?.cancelPeripheralConnection(peripheral)
            iosBleEvent("cancelled", background)
            return
        }
        iosBleEvent("connected", background)
        emitConnectionState(peer.identifier, true)
    }

    private fun onDisconnected(peripheral: CBPeripheral, error: NSError?) {
        val identifier = peripheral.identifier.UUIDString.uppercase()
        val entry = cond.withLock {
            peers[identifier]?.let { it to cancellationEpochs.getOrElse(identifier) { 0L } }
        } ?: return
        val (peer, epoch) = entry
        // CoreBluetooth may deliver a different object/wrapper for the same UUID.
        // Its callback cannot retire a newer stored connection that is still live.
        // These state reads run on the BLE queue, outside the condition lock.
        val callbackState = peripheral.state
        val storedState = peer.peripheral.state
        val sameWrapper = peer.peripheral === peripheral
        val outcome = cond.withLock {
            if (!iosDisconnectCallbackApplies(
                    callbackDisconnected = callbackState == CBPeripheralStateDisconnected,
                    storedDisconnected = storedState == CBPeripheralStateDisconnected,
                    samePeer = peers[identifier] === peer,
                    sameEpoch = cancellationEpochs.getOrElse(identifier) { 0L } == epoch,
                    connectionPendingWithoutSubmission = peer.connect.pending && !peer.connect.connectionSubmitted,
                )) null
            else peer.connect.background to failPeerLocked(peer, error?.localizedDescription ?: "Disconnected")
        }
        if (outcome == null) {
            log("disconnect callback ignored callbackState=" + iosPeripheralStateName(callbackState) +
                " storedState=" + iosPeripheralStateName(storedState) + " sameWrapper=" + sameWrapper)
            return
        }
        log("disconnect callback accepted callbackState=disconnected storedState=disconnected sameWrapper=" + sameWrapper)
        if (error != null) ConnectionCounters.increment("ble.ios-disconnect-error." + error.code)
        if (outcome.second) emitConnectionState(peer.identifier, false)
        iosBleEvent(if (outcome.second) "disconnected" else "failed", outcome.first, error?.code)
    }

    private fun onServicesDiscovered(peripheral: CBPeripheral, error: NSError?) {
        val peer = remember(peripheral)
        val services = peripheral.services?.mapNotNull { it as? CBService } ?: emptyList()
        if (error != null || services.isEmpty()) {
            cond.withLock {
                peer.discoverPending = false
                cond.signalAll()
            }
            return
        }
        cond.withLock { peer.pendingServices = services.size }
        for (service in services) peripheral.discoverCharacteristics(null, service)
    }

    private fun onCharacteristicsDiscovered(peripheral: CBPeripheral, service: CBService, error: NSError?) {
        val peer = remember(peripheral)
        cond.withLock {
            if (error == null) {
                for (item in service.characteristics ?: emptyList<Any?>()) {
                    val characteristic = item as? CBCharacteristic ?: continue
                    peer.characteristics[characteristic.UUID.UUIDString.lowercase()] = characteristic
                }
            }
            peer.pendingServices--
            if (peer.pendingServices <= 0) peer.discoverPending = false
            cond.signalAll()
        }
    }

    private fun onNotificationState(peripheral: CBPeripheral, characteristic: CBCharacteristic, error: NSError?) {
        val peer = remember(peripheral)
        val key = characteristic.UUID.UUIDString.lowercase()
        cond.withLock {
            if (peer.notifyPending == key) {
                peer.notifyResult = error == null
                peer.notifyPending = null
            }
            cond.signalAll()
        }
    }

    private fun onValue(peripheral: CBPeripheral, characteristic: CBCharacteristic, error: NSError?) {
        if (error != null) {
            log("notification error: " + error.localizedDescription)
            return
        }
        val data = characteristic.value?.byteArray() ?: return
        val identifier = peripheral.identifier.UUIDString.uppercase()
        val uuid = characteristic.UUID.UUIDString.lowercase()
        IosBleTraffic.recordRead(data.size)
        emitNotification(identifier, uuid, data)
    }

    private fun onWrote(peripheral: CBPeripheral, error: NSError?) {
        val peer = remember(peripheral)
        cond.withLock {
            peer.writeError = error?.localizedDescription
            peer.writePending = false
            cond.signalAll()
        }
    }

    private fun onReadyForWriteWithoutResponse(peripheral: CBPeripheral) {
        val peer = remember(peripheral)
        cond.withLock {
            peer.readyForWriteWithoutResponse = true
            cond.signalAll()
        }
    }

    private fun onAncsAuthorization(peripheral: CBPeripheral) {
        val identifier = peripheral.identifier.UUIDString.uppercase()
        emitAncsAuthorization(identifier, peripheral.ancsAuthorized)
    }

    private class Delegate(private val owner: IosBleCentral) : NSObject(), CBCentralManagerDelegateProtocol, CBPeripheralDelegateProtocol {
        override fun centralManagerDidUpdateState(central: CBCentralManager) = owner.onStateUpdated(central)

        override fun centralManager(central: CBCentralManager, willRestoreState: Map<Any?, *>) =
            owner.onRestored(central, willRestoreState)

        override fun centralManager(central: CBCentralManager, didDiscoverPeripheral: CBPeripheral, advertisementData: Map<Any?, *>, RSSI: NSNumber) =
            owner.onDiscovered(didDiscoverPeripheral, advertisementData, RSSI)

        @ObjCSignatureOverride
        override fun centralManager(central: CBCentralManager, didConnectPeripheral: CBPeripheral) = owner.onConnected(didConnectPeripheral)

        @ObjCSignatureOverride
        override fun centralManager(central: CBCentralManager, didFailToConnectPeripheral: CBPeripheral, error: NSError?) =
            owner.onDisconnected(didFailToConnectPeripheral, error)

        @ObjCSignatureOverride
        override fun centralManager(central: CBCentralManager, didDisconnectPeripheral: CBPeripheral, error: NSError?) =
            owner.onDisconnected(didDisconnectPeripheral, error)

        @ObjCSignatureOverride
        override fun centralManager(central: CBCentralManager, didUpdateANCSAuthorizationForPeripheral: CBPeripheral) =
            owner.onAncsAuthorization(didUpdateANCSAuthorizationForPeripheral)

        override fun peripheral(peripheral: CBPeripheral, didDiscoverServices: NSError?) = owner.onServicesDiscovered(peripheral, didDiscoverServices)

        @ObjCSignatureOverride
        override fun peripheral(peripheral: CBPeripheral, didDiscoverCharacteristicsForService: CBService, error: NSError?) =
            owner.onCharacteristicsDiscovered(peripheral, didDiscoverCharacteristicsForService, error)

        @ObjCSignatureOverride
        override fun peripheral(peripheral: CBPeripheral, didUpdateNotificationStateForCharacteristic: CBCharacteristic, error: NSError?) =
            owner.onNotificationState(peripheral, didUpdateNotificationStateForCharacteristic, error)

        @ObjCSignatureOverride
        override fun peripheral(peripheral: CBPeripheral, didUpdateValueForCharacteristic: CBCharacteristic, error: NSError?) =
            owner.onValue(peripheral, didUpdateValueForCharacteristic, error)

        @ObjCSignatureOverride
        override fun peripheral(peripheral: CBPeripheral, didWriteValueForCharacteristic: CBCharacteristic, error: NSError?) =
            owner.onWrote(peripheral, error)

        override fun peripheralIsReadyToSendWriteWithoutResponse(peripheral: CBPeripheral) = owner.onReadyForWriteWithoutResponse(peripheral)
    }
}

/** Process-wide BLE traffic counters (the TypeScript ios-ble-traffic counters' successor). */
object IosBleTraffic {
    private val lock = IosProtocolPlatform.createLock()
    private var bytesWritten = 0L
    private var bytesRead = 0L
    private var displayFrames = 0L

    fun recordWrite(bytes: Int) = lock.withLock { bytesWritten += bytes }

    fun recordRead(bytes: Int) = lock.withLock { bytesRead += bytes }

    fun recordDisplayFrame() = lock.withLock { displayFrames++ }

    /** [bytesWritten, bytesRead, displayFrames] and resets the counters. */
    fun sample(): LongArray = lock.withLock {
        val out = longArrayOf(bytesWritten, bytesRead, displayFrames)
        bytesWritten = 0
        bytesRead = 0
        displayFrames = 0
        out
    }
}
