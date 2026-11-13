package com.faceclaw.app

import kotlin.concurrent.Volatile
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

private const val RING = "CC:00:00:00:00:03"
private const val RIGHT = "AA:00:00:00:00:01"

private fun checkedDeviceResponse(command: Int, seq: Int, args: ByteArray = ByteArray(0)): ByteArray {
    val modelLength = 12 + args.size
    val model = byteArrayOf(
        0x64, RingProtocol.CHAN_DEVICE.toByte(), 0x64, seq.toByte(), 0,
        RingProtocol.KIND_RSP.toByte(), 0, command.toByte(),
        modelLength.toByte(), (modelLength ushr 8).toByte(), 0, 0,
    ) + args
    var crc = 0xffff
    for (byte in model) {
        crc = crc xor (byte.toInt() and 0xff)
        repeat(8) { crc = if ((crc and 1) != 0) (crc ushr 1) xor 0xa001 else crc ushr 1 }
    }
    return RingProtocol.buildFrame(RingProtocol.CHAN_DEVICE, RingProtocol.KIND_RSP, 0, command, seq,
        byteArrayOf(crc.toByte(), (crc ushr 8).toByte()) + args)
}

/**
 * A ring that answers health requests through the session's real notification
 * path: each REQ gets DATA page `cmd*10+1`, then its RSP; the ACK for a page
 * ending in 1 triggers page `+1`, so the transfer is ACK-paced like the real
 * ring's backlog.
 */
private class FakeRingLink(private val platform: ProtocolPlatform) : SessionLink {
    lateinit var core: GlassesSessionCore
    private val lock = platform.createLock()
    private val writesList = ArrayList<String>()
    private val subscribedList = ArrayList<String>()
    val framesWritten = ArrayList<RingProtocol.Frame>()
    val writeTimeouts = ArrayList<Int>()
    val notificationChanges = ArrayList<Pair<String, Boolean>>()
    val roleChangeOperations = ArrayList<String>()
    var failLegacyDisable = false
    var failLegacyEnable = false
    var legacyDisableDelayMs = 0L
    var onAuthRequest: ((RingProtocol.Frame) -> Unit)? = null
    @Volatile var failAck = false
    @Volatile var answer = true
    @Volatile var delayRsp = false
    @Volatile var requestStarted = false
    @Volatile var backgroundConnectPending = false
    var allowBackgroundConnect = false
    var onBeginConnect: (() -> Unit)? = null
    var onConnect: (() -> Unit)? = null
    var connectSucceeds = true
    var transportConnected = false
    var disconnectAwaitSucceeds = true
    var disconnectAwaitDelayMs = 0L
    var connectCalls = 0
    var onHealthRequest: ((RingProtocol.Frame) -> Unit)? = null
    var onHealthRequestObserved: ((RingProtocol.Frame) -> Unit)? = null
    var onDeviceCommand: ((RingProtocol.Frame) -> Unit)? = null

    val writes: List<String>
        get() = lock.withLock { writesList.toList() }

    /** Every CCCD enabled, in order, across connections. */
    val subscribed: List<String>
        get() = lock.withLock { subscribedList.toList() }

    @Volatile var disconnects = 0

    fun deliver(frame: ByteArray) = core.onNotification(RING, BleProtocol.R1_NOTIFY_CHAR_UUID, frame)

    private fun page(cmdHi: Int, pageSeq: Int) =
        deliver(RingProtocol.buildFrame(RingProtocol.CHAN_HEALTH, RingProtocol.KIND_DATA, cmdHi,
            RingProtocol.CMD_LO_HEALTH, pageSeq, byteArrayOf(0, 0)))

    private fun rsp(cmdHi: Int, seq: Int) =
        deliver(RingProtocol.buildFrame(RingProtocol.CHAN_HEALTH, RingProtocol.KIND_RSP, cmdHi,
            RingProtocol.CMD_LO_HEALTH, seq, byteArrayOf(0, 0)))

    override fun writeFrames(address: String, characteristicUuid: String, frames: List<ByteArray>, mode: GattWriteMode, timeoutMs: Int): Boolean {
        assertEquals(RING, address)
        assertEquals(BleProtocol.R1_WRITE_CHAR_UUID, characteristicUuid)
        val frame = RingProtocol.parse(frames.single())!!
        framesWritten.add(frame)
        writeTimeouts.add(timeoutMs)
        if (frame.chan == RingProtocol.CHAN_DEVICE && frame.cmdLo == RingProtocol.CMD_LO_PAIR_AUTH) {
            onAuthRequest?.invoke(frame)
        }
        if (frame.chan == RingProtocol.CHAN_DEVICE && frame.cmdLo != RingProtocol.CMD_LO_PAIR_AUTH) {
            onDeviceCommand?.invoke(frame)
        }
        if (frame.kind == RingProtocol.KIND_ACK) {
            if (failAck) return false
            val pageSeq = frame.payload[6].toInt() and 0xff
            val cmdHi = frame.payload[3].toInt() and 0xff
            lock.withLock { writesList.add("ack:$pageSeq") }
            // A write longer than the idle timeout: page two arrives only
            // after page one's ACK has actually completed.
            sleepMs(130)
            if (pageSeq % 10 == 1) {
                startThread("ring-page", true) {
                    sleepMs(5)
                    page(cmdHi, pageSeq + 1)
                }
            }
        } else if (frame.chan == RingProtocol.CHAN_HEALTH && frame.kind == RingProtocol.KIND_REQ) {
            requestStarted = true
            lock.withLock { writesList.add("req:" + frame.cmdHi) }
            onHealthRequestObserved?.invoke(frame)
            if (onHealthRequest != null) {
                onHealthRequest!!.invoke(frame)
            } else if (answer) {
                page(frame.cmdHi, frame.cmdHi * 10 + 1)
                if (delayRsp) {
                    startThread("ring-rsp", true) {
                        sleepMs(20)
                        rsp(frame.cmdHi, frame.seq)
                    }
                } else {
                    rsp(frame.cmdHi, frame.seq)
                }
            }
        }
        // Device-channel pings between health types are not answered.
        return true
    }

    override fun connect(address: String, timeoutMs: Int): Boolean {
        connectCalls++
        onConnect?.invoke()
        return connectSucceeds
    }

    override fun beginConnect(address: String, background: Boolean): Boolean {
        onBeginConnect?.invoke()
        if (!allowBackgroundConnect || !background) return false
        backgroundConnectPending = true
        return true
    }

    override fun isConnected(address: String): Boolean = transportConnected

    override fun requestHighPriority(address: String) {}

    override fun requestMtu(address: String, mtu: Int, timeoutMs: Int): Boolean = true

    override fun negotiatedMtu(address: String): Int = 247

    override fun discoverServices(address: String, timeoutMs: Int): Boolean = true

    override fun enableNotifications(address: String, characteristicUuid: String, enable: Boolean, timeoutMs: Int): Boolean {
        notificationChanges.add(characteristicUuid to enable)
        if (characteristicUuid == BleProtocol.R1_LEGACY_NOTIFY_CHAR_UUID) {
            roleChangeOperations.add("legacy:" + enable)
            if (!enable && legacyDisableDelayMs > 0L) sleepMs(legacyDisableDelayMs)
        }
        if (!enable && characteristicUuid == BleProtocol.R1_LEGACY_NOTIFY_CHAR_UUID && failLegacyDisable) return false
        if (enable && characteristicUuid == BleProtocol.R1_LEGACY_NOTIFY_CHAR_UUID && failLegacyEnable) return false
        lock.withLock { subscribedList.add(characteristicUuid) }
        return true
    }

    override fun disconnect(address: String) {
        backgroundConnectPending = false
        disconnects++
    }

    override fun disconnectAndAwait(address: String, timeoutMs: Int): Boolean {
        roleChangeOperations.add("disconnect-await")
        disconnect(address)
        if (disconnectAwaitDelayMs > 0L) sleepMs(disconnectAwaitDelayMs)
        if (disconnectAwaitSucceeds) transportConnected = false
        return disconnectAwaitSucceeds
    }

    override fun close() {}

    override fun isBonded(address: String): Boolean = true

    override fun prepareBenchmarkLink(address: String, mode: Int) {}

    override fun recordDisplayFrameSent() {}
}

private class RingHost : SessionHost {
    var readOnly = false
    @Volatile var journalFails = false
    var rejectJournalLine: ((String) -> Boolean)? = null
    var beforeJournal: (() -> Unit)? = null
    val journal = ArrayList<String>()
    var deferMain = false
    var beforeReadOnlyCheck: (() -> Unit)? = null
    var armWorkersStarted = 0
    var ringWorkersStarted = 0
    private val mainActions = ArrayList<() -> Unit>()

    override fun postToMain(action: () -> Unit) {
        if (deferMain) mainActions.add(action) else action()
    }

    fun clearMain() = mainActions.clear()

    fun drainMain() {
        val pending = mainActions.toList()
        mainActions.clear()
        pending.forEach { it() }
    }

    override fun currentThreadDispatcher(): SessionDispatcher = SessionDispatcher { it() }

    override fun isPhoneLocked(): Boolean = false

    override fun setScreenWakeLock(on: Boolean) {}

    override fun isEvenAppActive(): Boolean = false

    override fun startWorker(body: () -> Unit) { armWorkersStarted++ }

    override fun startRingWorker(body: () -> Unit) { ringWorkersStarted++ }

    override fun joinWorker(timeoutMs: Long) {}

    override fun supportsRingHealth(): Boolean = true

    override fun ringHealthReadOnly(): Boolean {
        beforeReadOnlyCheck?.invoke()
        return readOnly
    }

    override fun appendRingFrameJournal(line: String) {
        beforeJournal?.invoke()
        if (journalFails || rejectJournalLine?.invoke(line) == true) throw IllegalStateException("disk full")
        synchronizedAdd(line)
    }

    private val lock = testPlatform().createLock()

    private fun synchronizedAdd(line: String) = lock.withLock { journal.add(line) }

    override fun log(level: SessionLogLevel, tag: String, message: String, error: Throwable?) {}
}

private class RingPullListener : FaceclawBleCommunicatorListener {
    data class BackgroundResult(val generation: Long, val outcome: String, val pages: Int, val watermark: Long)
    val pulls = ArrayList<Triple<Boolean, Int, Long>>()
    val background = ArrayList<BackgroundResult>()
    val restoredPeers = ArrayList<Int>()
    val glassesRingConnections = ArrayList<Pair<Boolean, String>>()
    var phoneReadyCount = 0
    var beforePullFinished: (() -> Unit)? = null

    override fun onStateChange(phase: String?, status: String?) {}
    override fun onRingEvent(kind: String?, containerName: String?, eventType: Int, eventSource: Int,
        systemExitReasonCode: Int, frameId: Int, ringTick: Long, ringType: Int, ringAux: Int, ringSpeed: Int) {}
    override fun onBatteryState(headsetBattery: Int, headsetCharging: Int, ringBattery: Int, ringCharging: Int) {}
    override fun onCaseState(caseBattery: Int, caseCharging: Int, caseDocked: Boolean) {}
    override fun onSilentMode(silent: Boolean) {}
    override fun onWearState(wearing: Boolean) {}
    override fun onPhoneLockState(locked: Boolean) {}
    override fun onEvenAppConflict(message: String?) {}
    override fun onFrameMetrics(paintMs: Int, transmitMs: Int, tileCount: Int) {}
    override fun onFrameFinished(frameId: Int, outcome: String?) {}
    override fun onFirmwareInfo(leftVersion: String?, rightVersion: String?, extension: String?) {}
    override fun onRingHealthPullFinished(completed: Boolean, pages: Int, watermark: Long) {
        beforePullFinished?.invoke()
        pulls.add(Triple(completed, pages, watermark))
    }

    override fun onBackgroundRingHealthFinished(generation: Long, outcome: String, pages: Int, watermark: Long) {
        background.add(BackgroundResult(generation, outcome, pages, watermark))
    }

    override fun onSessionRestored(restoredPeers: Int) {
        this.restoredPeers.add(restoredPeers)
    }

    override fun onGlassesRingConnectionState(connected: Boolean, ringId: String) {
        glassesRingConnections.add(connected to ringId)
    }

    override fun onPhoneRingReady() { phoneReadyCount++ }
}

/** A core whose ring link is up, without running the glasses worker. */
private class RingSession(
    ringId: String? = null,
    rightAddress: String = "AA:00:00:00:00:01",
    leftAddress: String = "AA:00:00:00:00:02",
) {
    val platform = testPlatform()
    val link = FakeRingLink(platform)
    val host = RingHost()
    val core = GlassesSessionCore(link, host, FrameTimingsCore(platform), platform,
        rightAddress, leftAddress, RING)

    init {
        link.core = core
        if (ringId != null) core.setRingHealthIdentity(ringId)
        core.ringHealthRspTimeoutMs = 500
        core.ringHealthDataIdleMs = 100
        core.monitor.withLock {
            core.running = true
            core.ringConnected = true
            core.ringNotificationsReady = true
        }
    }

    fun outboundSize(): Int = core.monitor.withLock { core.ringOutbound.size }
}

class RingHealthTransferTest {
    @Test fun phoneReadyCallbackRequiresCompletedPermanentPhoneSetup() {
        for (role in listOf(DIRECT_RING_ROLE_PHONE, DIRECT_RING_ROLE_GLASSES)) {
            val s = RingSession()
            val listener = RingPullListener()
            s.host.readOnly = true
            s.core.setListener(listener)
            s.core.monitor.withLock {
                s.core.sessionReady = true
                s.core.ringConnected = false
                s.core.ringNotificationsReady = false
                s.core.directRingRole = role
            }
            s.core.connectRing()
            assertTrue(s.core.ringNotificationsReady)
            assertEquals(if (role == DIRECT_RING_ROLE_PHONE) 1 else 0, listener.phoneReadyCount)
        }
    }

    private fun putUInt16Le(bytes: ByteArray, offset: Int, value: Int) {
        bytes[offset] = value.toByte()
        bytes[offset + 1] = (value ushr 8).toByte()
    }

    private fun putUInt32Le(bytes: ByteArray, offset: Int, value: Long) {
        repeat(4) { bytes[offset + it] = (value ushr (it * 8)).toByte() }
    }

    private fun decodeSleep(payload: ByteArray): RingProtocol.SleepRecord? {
        val raw = RingProtocol.buildFrame(RingProtocol.CHAN_HEALTH, RingProtocol.KIND_DATA,
            RingProtocol.CMD_HI_SLEEP, RingProtocol.CMD_LO_HEALTH, 1, payload)
        return RingProtocol.decode(RingProtocol.parse(raw), 1234L) as RingProtocol.SleepRecord?
    }

    @Test fun sleepHeaderDecodesSourceBackedTemperatureAndSignedUtcOffsetWithTrailer() {
        val payload = ByteArray(37)
        payload[2] = 1
        payload[9] = 0x7a
        putUInt16Le(payload, 10, 0x1234)
        putUInt16Le(payload, 12, -300 and 0xffff)
        putUInt32Le(payload, 14, 1_700_000_000L)
        putUInt32Le(payload, 18, 1_700_003_600L)
        putUInt16Le(payload, 22, 3600)
        putUInt16Le(payload, 24, 300)
        putUInt16Le(payload, 26, 900)
        putUInt16Le(payload, 28, 1500)
        putUInt16Le(payload, 30, 900)
        putUInt16Le(payload, 32, 1)
        payload[34] = 3
        putUInt16Le(payload, 35, 60)

        for (candidate in listOf(payload, payload + byteArrayOf(9, 8, 7, 6))) {
            val record = assertNotNull(decodeSleep(candidate))
            assertEquals(0x1234, record.temperatureRaw)
            assertEquals(-300, record.utcOffsetMinutes)
            assertEquals(1_700_000_000L, record.startTs)
            assertEquals(1_700_003_600L, record.endTs)
            assertEquals(0xd412347aL, record.unknownTag, "legacy overlapping header must remain raw")
            assertEquals(3, record.segments.single().stage)
            assertEquals(60, record.segments.single().halfMinutes)
        }
    }

    @Test fun sleepTemperatureZeroAndEndMarkerDoNotInventHeaderFields() {
        val real = ByteArray(34)
        real[2] = 1
        putUInt16Le(real, 12, 60)
        assertNull(assertNotNull(decodeSleep(real)).temperatureRaw)
        assertEquals(60, assertNotNull(decodeSleep(real)).utcOffsetMinutes)

        val end = ByteArray(13)
        end[2] = 2
        putUInt16Le(end, 10, 0x1234)
        val marker = assertNotNull(decodeSleep(end))
        assertNull(marker.temperatureRaw)
        assertNull(marker.utcOffsetMinutes)
    }

    private fun acceptAuth(s: RingSession) {
        s.link.onAuthRequest = { req ->
            s.link.deliver(checkedDeviceResponse(RingProtocol.CMD_LO_PAIR_AUTH, req.seq, byteArrayOf(0)))
        }
    }

    private fun runBinding(
        s: RingSession,
        timeoutMs: Int = 1_000,
        rightHardwareMac: String = "10:20:30:40:50:60",
        leftHardwareMac: String = "11:21:31:41:51:61",
    ): String {
        val done = Latch(1, s.platform)
        var result = ""
        s.core.monitor.withLock {
            s.core.sessionReady = true
            s.core.directRingRole = DIRECT_RING_ROLE_PHONE
            s.core.ringWorkerStarted = true
        }
        startThread("bind-ring-to-g2", true) {
            result = s.core.bindRingToGlasses(
                rightHardwareMac,
                leftHardwareMac,
                RING,
                "R1",
                timeoutMs,
            )
            done.countDown()
        }
        val deadline = s.core.now() + 1_000L
        while (s.core.now() < deadline && !s.core.monitor.withLock { s.core.ringBindingActive }) sleepMs(1)
        if (s.core.monitor.withLock { s.core.ringBindingActive }) s.core.processRingBindingOperation()
        assertTrue(done.await(timeoutMs.toLong() + 1_000L))
        return result
    }

    @Test fun knownHardwareBindingAuthenticatesThenWritesTargetsBeforeQueuingG2Connect() {
        val s = RingSession(
            ringId = RING,
            rightAddress = "11111111-2222-3333-4444-555555555555",
            leftAddress = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
        )
        s.link.onAuthRequest = { req ->
            s.link.deliver(checkedDeviceResponse(RingProtocol.CMD_LO_PAIR_AUTH, req.seq, byteArrayOf(0)))
        }
        s.link.onDeviceCommand = { req ->
            if (req.cmdLo == RingProtocol.CMD_LO_ADV_START) {
                s.link.deliver(checkedDeviceResponse(req.cmdLo, (req.seq + 1) and 0xff))
                s.link.deliver(checkedDeviceResponse(req.cmdLo, req.seq))
            }
        }

        assertEquals("glasses-connect-queued", runBinding(s))

        assertEquals(
            listOf(RingProtocol.CMD_LO_PAIR_AUTH, RingProtocol.CMD_LO_ADV_START),
            s.link.framesWritten.map { it.cmdLo },
        )
        val adv = s.link.framesWritten.last()
        assertEquals("605040302010615141312111", adv.payload.copyOfRange(2, 14).joinToString("") {
            (it.toInt() and 0xff).toString(16).padStart(2, '0')
        })
        assertTrue(s.core.lastRingLinkCommand.startsWith("connect "))
        assertEquals(2, s.core.pendingMessages.size)
        assertTrue(s.core.cancelRingBinding())
        assertTrue(s.core.pendingMessages.isEmpty(), "cancel left stale G2 connect messages queued")
    }

    @Test fun bindingRejectsBadIdentityOrCrcAndNeverQueuesG2Connect() {
        val invalid = RingSession(ringId = RING)
        invalid.core.monitor.withLock { invalid.core.sessionReady = true }
        assertEquals(
            "failed: hardware addresses must be distinct",
            invalid.core.bindRingToGlasses(RING, "11:21:31:41:51:61", RING, "R1", 1_000),
        )

        val rejected = RingSession(ringId = RING)
        rejected.link.onAuthRequest = { req ->
            rejected.link.deliver(checkedDeviceResponse(RingProtocol.CMD_LO_PAIR_AUTH, req.seq, byteArrayOf(0)))
        }
        rejected.link.onDeviceCommand = { req ->
            if (req.cmdLo == RingProtocol.CMD_LO_ADV_START) {
                val corrupt = checkedDeviceResponse(req.cmdLo, req.seq)
                corrupt[1] = (corrupt[1].toInt() xor 1).toByte()
                rejected.link.deliver(corrupt)
            }
        }

        assertEquals("failed: timed out", runBinding(rejected))
        assertTrue(rejected.core.pendingMessages.isEmpty())
        assertTrue(rejected.core.lastRingLinkCommand.isEmpty())
        assertTrue(rejected.link.framesWritten.none { it.cmdLo == 0x05 || it.cmdLo == 0x0e })
    }

    @Test fun bindingRejectsNamesOutsideFirmwareLimit() {
        val s = RingSession(ringId = RING)
        assertEquals(
            "failed: ring name exceeds firmware limit",
            s.core.bindRingToGlasses("10:20:30:40:50:60", "11:21:31:41:51:61", RING, "x".repeat(17), 1_000),
        )
        s.core.monitor.withLock {
            s.core.glassesRingMac = byteArrayOf(0x10, 0x20, 0x30, 0x40, 0x50, 0x60)
            s.core.glassesRingName = "x".repeat(17)
            assertFalse(s.core.queueGlassesRingLinkCommandLocked("connect", RING, "R1"))
        }
        assertTrue(s.core.pendingMessages.isEmpty())
        assertTrue(s.link.framesWritten.isEmpty())
    }

    @Test fun bindingDistinguishesAMatchedNegativeTargetResponseFromTimeout() {
        val rejected = RingSession(ringId = RING)
        rejected.link.onAuthRequest = { req ->
            rejected.link.deliver(checkedDeviceResponse(RingProtocol.CMD_LO_PAIR_AUTH, req.seq, byteArrayOf(0)))
        }
        rejected.link.onDeviceCommand = { req ->
            if (req.cmdLo == RingProtocol.CMD_LO_ADV_START) {
                rejected.link.deliver(checkedDeviceResponse(req.cmdLo, req.seq, byteArrayOf(1)))
            }
        }

        assertEquals("failed: ring rejected glasses targets", runBinding(rejected))
        assertTrue(rejected.core.pendingMessages.isEmpty())
        assertTrue(rejected.core.lastRingLinkCommand.isEmpty())
    }

    @Test fun bindingWaitsForPhoneReadinessAndCancellationPreventsAllWrites() {
        val s = RingSession(ringId = RING)
        val done = Latch(1, s.platform)
        var result = ""
        s.core.monitor.withLock {
            s.core.sessionReady = true
            s.core.directRingRole = DIRECT_RING_ROLE_PHONE
            s.core.ringConnected = false
            s.core.ringNotificationsReady = false
            s.core.ringWorkerStarted = true
        }
        startThread("cancel-queued-ring-binding", true) {
            result = s.core.bindRingToGlasses(
                "10:20:30:40:50:60",
                "11:21:31:41:51:61",
                RING,
                "R1",
                1_000,
            )
            done.countDown()
        }
        val deadline = s.core.now() + 1_000L
        while (s.core.now() < deadline && !s.core.monitor.withLock { s.core.ringBindingActive }) sleepMs(1)

        assertFalse(s.core.processRingBindingOperation(), "binding did not wait for PHONE readiness")
        val activeGeneration = s.core.monitor.withLock { s.core.ringBindingGeneration }
        assertEquals(-1L, s.core.reserveRingBindingOperation(1_000))
        assertEquals(activeGeneration, s.core.monitor.withLock { s.core.ringBindingGeneration },
            "busy reservation orphaned the active binding generation")
        assertTrue(s.core.cancelRingBinding())
        assertTrue(done.await(1_000))
        assertEquals("failed: cancelled", result)
        assertTrue(s.link.framesWritten.isEmpty())
        assertTrue(s.core.pendingMessages.isEmpty())
    }

    @Test fun cancellationBeforeNativeQueueStartsInvalidatesReservedBinding() {
        val s = RingSession(ringId = RING)
        s.core.monitor.withLock {
            s.core.sessionReady = true
            s.core.directRingRole = DIRECT_RING_ROLE_PHONE
        }
        val reservation = s.core.reserveRingBindingOperation(1_000)

        s.core.cancelRingBinding()
        val result = s.core.bindRingToGlassesOnWorker(
            "10:20:30:40:50:60",
            "11:21:31:41:51:61",
            RING,
            "R1",
            1_000,
            reservation,
        )

        assertEquals("failed: cancelled before start", result)
        assertTrue(s.link.framesWritten.isEmpty())
        assertTrue(s.core.pendingMessages.isEmpty())
    }

    @Test fun nativeQueueWaitCountsAgainstBindingDeadline() {
        val s = RingSession(ringId = RING)
        s.core.monitor.withLock {
            s.core.sessionReady = true
            s.core.directRingRole = DIRECT_RING_ROLE_PHONE
        }
        val reservation = s.core.reserveRingBindingOperation(1)
        sleepMs(2)

        assertEquals(
            "failed: timed out",
            s.core.bindRingToGlassesOnWorker(
                "10:20:30:40:50:60",
                "11:21:31:41:51:61",
                RING,
                "R1",
                1,
                reservation,
            ),
        )
        assertFalse(s.core.ringBindingActive)
        assertTrue(s.link.framesWritten.isEmpty())
    }

    @Test fun sessionChangeAfterValidAdvResponsePreventsG2ConnectQueue() {
        val s = RingSession(ringId = RING)
        s.link.onAuthRequest = { req ->
            s.link.deliver(checkedDeviceResponse(RingProtocol.CMD_LO_PAIR_AUTH, req.seq, byteArrayOf(0)))
        }
        s.link.onDeviceCommand = { req ->
            if (req.cmdLo == RingProtocol.CMD_LO_ADV_START) {
                s.link.deliver(checkedDeviceResponse(req.cmdLo, req.seq))
                s.core.monitor.withLock { s.core.sessionReady = false }
            }
        }

        assertEquals("failed: cancelled", runBinding(s))
        assertTrue(s.core.pendingMessages.isEmpty())
        assertTrue(s.core.lastRingLinkCommand.isEmpty())
    }

    @Test fun healthOnlyStartsNoArmWorkerAndPromotionStartsItExactlyOnce() {
        val platform = testPlatform()
        val link = FakeRingLink(platform)
        val host = RingHost()
        val core = GlassesSessionCore(link, host, FrameTimingsCore(platform), platform,
            "AA:00:00:00:00:01", "AA:00:00:00:00:02", RING)
        link.core = core

        assertTrue(core.startHealthOnly())
        assertEquals(0, host.armWorkersStarted)
        assertEquals(1, host.ringWorkersStarted)
        assertTrue(core.promoteToInteractive())
        assertEquals(1, host.armWorkersStarted)
        assertEquals(1, host.ringWorkersStarted)
        assertFalse(core.promoteToInteractive())
        assertEquals(1, host.armWorkersStarted)
    }

    private fun runRoleChangePreparation(s: RingSession, timeoutMs: Int): Boolean {
        val done = Latch(1, s.platform)
        var result = false
        s.core.monitor.withLock { s.core.ringWorkerStarted = true }
        startThread("prepare-ring-role-change", true) {
            result = s.core.prepareForRingRoleChange(timeoutMs)
            done.countDown()
        }
        val deadline = s.core.now() + 1_000L
        while (s.core.now() < deadline && !s.core.monitor.withLock { s.core.ringRoleChangeRequestActive }) {
            sleepMs(1)
        }
        assertTrue(s.core.processRingRoleChangePreparation(), "ring worker did not receive role-change request")
        assertTrue(done.await(timeoutMs.toLong() + 1_000L))
        return result
    }

    @Test fun roleChangePreparationDisablesLegacyBeforeSettledDisconnectAndFreezesWorker() {
        val s = directSession()
        s.link.transportConnected = true
        val startedAt = s.core.now()

        assertTrue(runRoleChangePreparation(s, 5_000))

        assertTrue(s.core.now() - startedAt >= 3_000L, "interrupted settle returned before three seconds elapsed")
        assertEquals(listOf("legacy:false", "disconnect-await"), s.link.roleChangeOperations)
        assertTrue(s.core.ringRoleChangeFrozen)
        assertFalse(s.core.shouldAttemptRingConnect())
        assertTrue(s.link.framesWritten.isEmpty(), "PHONE authentication or mutation was written before owner replacement")
    }

    @Test fun failedRoleChangePreparationRecoversLegacyAndNeverStartsPhoneAuthentication() {
        for (failure in listOf("disable", "disconnect", "reenable")) {
            val s = directSession()
            s.link.transportConnected = true
            s.link.failLegacyDisable = failure != "disconnect"
            s.link.failLegacyEnable = failure == "reenable"
            s.link.disconnectAwaitSucceeds = failure != "disconnect"

            assertFalse(runRoleChangePreparation(s, 1_000))

            assertFalse(s.core.ringRoleChangeFrozen)
            assertEquals(DIRECT_RING_ROLE_GLASSES, s.core.directRingRole)
            assertTrue(s.link.roleChangeOperations.first() == "legacy:false")
            assertTrue(s.link.roleChangeOperations.contains("legacy:true"), "live Direct legacy subscription was not recovered")
            if (failure == "reenable") {
                assertFalse(s.core.ringNotificationsReady)
                assertTrue(s.link.disconnects > 0, "unverified recovery did not force a clean GLASSES reconnect")
            }
            assertTrue(s.link.framesWritten.isEmpty(), "failed teardown emitted PHONE authentication")
        }
    }

    @Test fun phoneRolePreparationNeverTouchesLegacyAndIdlePhoneStillUsesTransportSettlement() {
        val live = directSession()
        live.core.monitor.withLock { live.core.directRingRole = DIRECT_RING_ROLE_PHONE }
        live.link.transportConnected = true

        assertTrue(runRoleChangePreparation(live, 5_000))
        assertEquals(listOf("disconnect-await"), live.link.roleChangeOperations)
        assertTrue(live.link.framesWritten.isEmpty())

        val idle = directSession()
        idle.core.monitor.withLock {
            idle.core.directRingRole = DIRECT_RING_ROLE_PHONE
            idle.core.ringConnected = false
            idle.core.ringNotificationsReady = false
            idle.core.ringWorkerStarted = true
        }
        assertTrue(runRoleChangePreparation(idle, 5_000))
        assertTrue(idle.core.ringRoleChangeFrozen)
        assertEquals(listOf("disconnect-await"), idle.link.roleChangeOperations)
    }

    @Test fun latePhoneDisconnectAfterDeadlineCannotLeavePhoneMarkedReady() {
        val s = directSession()
        s.core.monitor.withLock { s.core.directRingRole = DIRECT_RING_ROLE_PHONE }
        s.link.transportConnected = true
        s.link.disconnectAwaitDelayMs = 100L

        assertFalse(runRoleChangePreparation(s, 50))

        assertFalse(s.core.ringNotificationsReady)
        assertFalse(s.core.ringConnected)
        assertTrue(s.link.framesWritten.isEmpty(), "late PHONE teardown emitted new GLASSES authentication")
    }

    @Test fun lateLegacyDisableAfterDeadlineCannotLeaveDirectMarkedReady() {
        val s = directSession()
        s.link.transportConnected = true
        s.link.legacyDisableDelayMs = 100L

        assertFalse(runRoleChangePreparation(s, 50))

        assertFalse(s.core.ringNotificationsReady)
        assertFalse(s.core.ringConnected)
        assertTrue(s.link.disconnects > 0)
        assertTrue(s.link.framesWritten.isEmpty())
    }

    @Test fun expiredRoleChangePreparationCannotLaterDisableOrAuthenticate() {
        val s = directSession()
        val done = Latch(1, s.platform)
        var result = true
        s.link.transportConnected = true
        s.core.monitor.withLock { s.core.ringWorkerStarted = true }
        startThread("expire-ring-role-change", true) {
            result = s.core.prepareForRingRoleChange(1)
            done.countDown()
        }

        assertTrue(done.await(1_000))
        assertFalse(result)
        assertFalse(s.core.processRingRoleChangePreparation())
        assertTrue(s.link.roleChangeOperations.isEmpty())
        assertTrue(s.link.framesWritten.isEmpty())
        assertFalse(s.core.ringRoleChangeFrozen)
    }

    @Test fun explicitStopDuringRoleSettleCannotReportSuccess() {
        val s = directSession()
        val prepareDone = Latch(1, s.platform)
        val processDone = Latch(1, s.platform)
        var result = true
        s.link.transportConnected = true
        s.core.monitor.withLock { s.core.ringWorkerStarted = true }
        startThread("prepare-before-explicit-stop", true) {
            result = s.core.prepareForRingRoleChange(5_000)
            prepareDone.countDown()
        }
        val requestDeadline = s.core.now() + 1_000L
        while (s.core.now() < requestDeadline && !s.core.monitor.withLock { s.core.ringRoleChangeRequestActive }) sleepMs(1)
        startThread("settle-before-explicit-stop", true) {
            s.core.processRingRoleChangePreparation()
            processDone.countDown()
        }
        val disconnectDeadline = s.core.now() + 1_000L
        while (s.core.now() < disconnectDeadline && s.link.disconnects == 0) sleepMs(1)
        assertTrue(s.link.disconnects > 0)

        s.core.disconnect()

        assertTrue(prepareDone.await(1_000))
        assertTrue(processDone.await(1_000))
        assertFalse(result)
        assertFalse(s.core.ringRoleChangeFrozen)
    }

    @Test fun restorationMetadataIsForwardedWithoutChangingSessionReadiness() {
        val s = RingSession()
        val listener = RingPullListener()
        s.core.setListener(listener)
        s.core.monitor.withLock { s.core.sessionReady = false }

        s.core.emitSessionRestored(2)

        assertEquals(listOf(2), listener.restoredPeers)
        assertFalse(s.core.sessionReady)
    }

    @Test fun backgroundHealthRejectsOverlapAndAcceptedJobFinishesExactlyOnce() {
        val s = RingSession()
        val listener = RingPullListener()
        s.host.readOnly = true
        s.core.setIndependentRingHealthEnabled(true)
        s.core.setListener(listener)
        acceptAuth(s)

        assertTrue(s.core.requestBackgroundRingHealth(41, 25_000))
        assertFalse(s.core.requestBackgroundRingHealth(42, 25_000))
        s.core.runRequestedRingHealthPull()

        assertEquals(listOf(RingPullListener.BackgroundResult(41, "completed", 10, 0)), listener.background)
        assertFalse(s.core.cancelBackgroundRingHealth(41))
    }

    @Test fun permanentPhoneBackgroundPullKeepsGlassesLiveAndUsesReadOnlyWirePath() {
        val s = RingSession()
        val listener = RingPullListener()
        var mutationCommands = 0
        s.host.readOnly = true
        s.core.setIndependentRingHealthEnabled(true)
        s.core.setListener(listener)
        acceptAuth(s)
        s.link.onDeviceCommand = { frame ->
            if (frame.cmdLo == 0x05 || frame.cmdLo == 0x0e) mutationCommands++
        }
        s.link.onHealthRequestObserved = {
            s.core.onNotification(
                RIGHT,
                BleProtocol.NOTIFY_CHAR_UUID,
                BleProtocol.framePb(
                    BleProtocol.encodeVarintField(1, 99),
                    BleProtocol.SID_SECURITY_AUTH,
                    1,
                    7,
                ).single(),
            )
        }

        assertFalse(s.core.sessionReady, "fixture must model cased glasses")
        assertEquals(DIRECT_RING_ROLE_PHONE, s.core.directRingRole)
        assertTrue(s.core.requestBackgroundRingHealth(42, 25_000))
        s.core.runRequestedRingHealthPull()

        assertEquals(listOf(RingPullListener.BackgroundResult(42, "completed", 10, 0)), listener.background)
        assertEquals(DIRECT_RING_ROLE_PHONE, s.core.directRingRole)
        assertFalse(s.core.ringHealthWindowActive)
        assertEquals(0, s.link.disconnects)
        assertEquals(0, mutationCommands, "PHONE read-only pull wrote clock, recording, or binding commands")
        assertTrue(s.core.lastIncomingAtMs > 0L, "G2 input was not handled during the ring pull")
    }

    @Test fun permanentPhoneBackgroundPullKeepsFiveMinuteFloorWhileManualKeepsOneMinuteFloor() {
        val background = RingSession()
        val backgroundListener = RingPullListener()
        background.host.readOnly = true
        background.core.setIndependentRingHealthEnabled(true)
        background.core.setListener(backgroundListener)
        background.core.ringHealthLastRequestedAtMs = background.core.now() - 2L * 60L * 1000L
        assertTrue(background.core.requestBackgroundRingHealth(46, 25_000))

        background.core.runRequestedRingHealthPull()

        assertTrue(background.core.ringHealthPullRequested, "background pull bypassed the five-minute floor")
        assertTrue(background.link.framesWritten.isEmpty())
        assertTrue(background.core.cancelBackgroundRingHealth(46))

        val manual = RingSession()
        manual.host.readOnly = true
        manual.core.setIndependentRingHealthEnabled(true)
        acceptAuth(manual)
        manual.core.ringHealthLastRequestedAtMs = manual.core.now() - 2L * 60L * 1000L
        manual.core.requestRingHealthNow()

        manual.core.runRequestedRingHealthPull()

        assertTrue(manual.link.requestStarted, "manual pull lost its one-minute floor")
    }

    @Test fun glassesRingConnectionCallbackUsesReportedIdentityAndRejectsAckOrMalformedReports() {
        val s = directSession()
        val listener = RingPullListener()
        s.core.setListener(listener)
        fun report(mac: ByteArray, code: Int, magic: Int, flag: Int = BleProtocol.FLAG_NOTIFY): ByteArray {
            val info = BleProtocol.encodeBytesField(1, byteArrayOf(1)) +
                BleProtocol.encodeBytesField(2, mac) + BleProtocol.encodeVarintField(4, code)
            val pb = BleProtocol.encodeVarintField(1, 6) + BleProtocol.encodeVarintField(2, magic) +
                byteArrayOf(0x2a, info.size.toByte()) + info
            return BleProtocol.framePb(pb, BleProtocol.SID_SECURITY_AUTH, flag, magic).single()
        }
        val reportedOtherRing = byteArrayOf(1, 2, 3, 4, 5, 6)

        s.core.onNotification(RIGHT, BleProtocol.NOTIFY_CHAR_UUID, report(reportedOtherRing, 0, 31))
        s.core.onNotification(RIGHT, BleProtocol.NOTIFY_CHAR_UUID, report(reportedOtherRing, 90, 32))
        s.core.onNotification(RIGHT, BleProtocol.NOTIFY_CHAR_UUID, report(ByteArray(6), 0, 33))
        s.core.monitor.withLock {
            s.core.inFlightMessages.addLast(OutboundMessage(
                "test", "own ack", BleProtocol.SID_SECURITY_AUTH, 1, 34, ByteArray(0), 1_000, -1, false,
            ))
        }
        s.core.onNotification(RIGHT, BleProtocol.NOTIFY_CHAR_UUID, report(reportedOtherRing, 0, 34))
        s.core.onNotification(RIGHT, BleProtocol.NOTIFY_CHAR_UUID, report(reportedOtherRing, 0, 35, 0))

        assertEquals(
            listOf(true to "06:05:04:03:02:01", false to "06:05:04:03:02:01"),
            listener.glassesRingConnections,
        )
    }

    @Test fun backgroundHealthRejectsManualAndFreshWorkWithoutCallback() {
        val manual = directSession()
        val manualListener = RingPullListener()
        manual.host.readOnly = true
        manual.core.setIndependentRingHealthEnabled(true)
        manual.core.setListener(manualListener)
        manual.core.requestRingHealthNow()
        assertFalse(manual.core.requestBackgroundRingHealth(43, 25_000))
        assertTrue(manualListener.background.isEmpty())

        val fresh = directSession()
        val freshListener = RingPullListener()
        fresh.host.readOnly = true
        fresh.core.setIndependentRingHealthEnabled(true)
        fresh.core.setListener(freshListener)
        fresh.core.requestRingHealthStartFresh()
        assertFalse(fresh.core.requestBackgroundRingHealth(44, 25_000))
        assertTrue(freshListener.background.isEmpty())
    }

    @Test fun backgroundConnectFailureAbortsExactlyOnceWithoutStoppingArms() {
        val s = directSession()
        val listener = RingPullListener()
        s.host.readOnly = true
        s.core.setIndependentRingHealthEnabled(true)
        s.core.setListener(listener)
        s.link.connectSucceeds = false
        s.core.monitor.withLock {
            s.core.ringConnected = false
            s.core.ringNotificationsReady = false
        }

        assertTrue(s.core.requestBackgroundRingHealth(45, 25_000))
        s.core.runRequestedRingHealthPull()
        s.core.finishBackgroundRingHealth("aborted")

        assertEquals(listOf(RingPullListener.BackgroundResult(45, "aborted", 0, 0)), listener.background)
        assertTrue(s.core.running)
        assertTrue(s.core.sessionReady)
    }

    @Test fun backgroundCancellationIsGenerationScopedAndDoesNotStopInteractiveArms() {
        val s = directSession()
        val listener = RingPullListener()
        s.host.readOnly = true
        s.core.setIndependentRingHealthEnabled(true)
        s.core.setListener(listener)
        assertTrue(s.core.requestBackgroundRingHealth(51, 25_000))
        assertFalse(s.core.cancelBackgroundRingHealth(50))

        assertTrue(s.core.cancelBackgroundRingHealth(51))

        assertTrue(s.core.running)
        assertTrue(s.core.sessionReady)
        assertEquals(listOf(RingPullListener.BackgroundResult(51, "cancelled", 0, 0)), listener.background)
        assertTrue(s.core.requestBackgroundRingHealth(52, 25_000))
        assertFalse(s.core.cancelBackgroundRingHealth(51))
    }

    @Test fun cancelledPullCleanupCannotFinishANewerBackgroundGeneration() {
        val s = RingSession()
        val listener = RingPullListener()
        val pullFinishing = Latch(1, s.platform)
        val releaseOldPull = Latch(1, s.platform)
        val oldPullDone = Latch(1, s.platform)
        s.host.readOnly = true
        s.core.setIndependentRingHealthEnabled(true)
        s.core.setListener(listener)
        acceptAuth(s)
        listener.beforePullFinished = {
            pullFinishing.countDown()
            releaseOldPull.await(2_000)
        }
        assertTrue(s.core.requestBackgroundRingHealth(54, 25_000))
        startThread("old-background-pull", true) {
            s.core.runRequestedRingHealthPull()
            oldPullDone.countDown()
        }
        assertTrue(pullFinishing.await(2_000))

        assertTrue(s.core.cancelBackgroundRingHealth(54))
        assertTrue(s.core.requestBackgroundRingHealth(55, 25_000))
        releaseOldPull.countDown()
        assertTrue(oldPullDone.await(2_000))

        assertTrue(s.core.cancelBackgroundRingHealth(55), "old pull cleanup consumed the newer job")
        assertEquals(
            listOf(
                RingPullListener.BackgroundResult(54, "cancelled", 10, 0),
                RingPullListener.BackgroundResult(55, "cancelled", 0, 0),
            ),
            listener.background,
        )
    }

    @Test fun explicitDisconnectCancelsAcceptedBackgroundJobExactlyOnce() {
        val s = directSession()
        val listener = RingPullListener()
        s.host.readOnly = true
        s.core.setIndependentRingHealthEnabled(true)
        s.core.setListener(listener)
        assertTrue(s.core.requestBackgroundRingHealth(53, 25_000))

        s.core.disconnect()
        s.core.finishBackgroundRingHealth("aborted")

        assertEquals(listOf(RingPullListener.BackgroundResult(53, "cancelled", 0, 0)), listener.background)
        assertFalse(s.core.running)
    }

    @Test fun backgroundDeadlineIncludesQueuedIdleWaitAndExpiresExactlyOnce() {
        val s = directSession()
        val listener = RingPullListener()
        s.host.readOnly = true
        s.core.setIndependentRingHealthEnabled(true)
        s.core.setListener(listener)
        s.core.monitor.withLock { s.core.lastDirectRingInputAtMs = s.core.now() }
        assertTrue(s.core.requestBackgroundRingHealth(61, 1))
        sleepMs(2)

        s.core.expireBackgroundRingHealthJob()
        s.core.expireBackgroundRingHealthJob()

        assertEquals(listOf(RingPullListener.BackgroundResult(61, "expired", 0, 0)), listener.background)
        assertFalse(s.core.ringHealthWindowActive)
        assertTrue(s.core.sessionReady)
    }

    @Test fun backgroundDeadlineIncludesAntiSpamFloorWait() {
        val s = directSession()
        val listener = RingPullListener()
        s.host.readOnly = true
        s.core.setIndependentRingHealthEnabled(true)
        s.core.setListener(listener)
        s.core.ringHealthLastRequestedAtMs = s.core.now()
        assertTrue(s.core.requestBackgroundRingHealth(62, 1))

        s.core.runRequestedRingHealthPull()
        sleepMs(2)
        s.core.expireBackgroundRingHealthJob()

        assertEquals(listOf(RingPullListener.BackgroundResult(62, "expired", 0, 0)), listener.background)
        assertFalse(s.core.ringHealthWindowActive)
        assertTrue(s.core.sessionReady)
    }

    @Test fun readOnlyPolicyDoesNotPullOrConfigureOnConnectOrFirstWorkerTick() {
        val s = directSession()
        s.host.readOnly = true
        s.core.runRequestedRingHealthPull()
        assertFalse(s.core.ringHealthWindowActive, "automatic first window")
        s.core.directRingRole = DIRECT_RING_ROLE_PHONE
        s.core.onRingDataChannelReady()
        assertTrue(s.link.framesWritten.isEmpty(), "unsolicited auth/configuration/pull")
        s.core.ringHealthAbortedRetries = 1
        s.core.ringHealthLastRequestedAtMs = s.core.now() - 120_000
        s.core.resumeAbortedRingHealthPull()
        assertTrue(s.link.framesWritten.isEmpty(), "automatic retry")
        s.link.deliver(RingProtocol.buildFrame(RingProtocol.CHAN_HEALTH, RingProtocol.KIND_DATA,
            1, 1, 41, byteArrayOf(0, 0)))
        assertEquals(0, s.outboundSize(), "unsolicited health page acknowledged")
    }

    @Test fun readOnlyExplicitPullAuthenticatesAndNeverWritesClockRecordingOrBinding() {
        val s = RingSession()
        s.host.readOnly = true
        s.core.monitor.withLock { s.core.sessionReady = true }
        acceptAuth(s)
        s.core.requestRingHealthNow()
        s.core.runRequestedRingHealthPull()
        assertTrue(s.core.lastRingHealthPullResult.startsWith("completed"), s.core.lastRingHealthPullResult)
        assertEquals(RingProtocol.CMD_LO_PAIR_AUTH, s.link.framesWritten.first().cmdLo)
        assertEquals(RingProtocol.HEALTH_COMMANDS.toList(),
            s.link.framesWritten.filter { it.chan == RingProtocol.CHAN_HEALTH }.map { it.cmdHi })
        assertTrue(s.link.framesWritten.all { frame ->
            frame.kind == RingProtocol.KIND_ACK || (frame.kind == RingProtocol.KIND_REQ &&
                (frame.chan == RingProtocol.CHAN_HEALTH || frame.cmdLo in listOf(1, 2, 8, 11)))
        }, "mutating frame emitted")
        assertFalse(s.core.ringHealthTransferActive)
    }

    @Test fun explicitFreshStartVerifiesSettingsBeforeAndAfterAndUsesUtcSeconds() {
        val s = directSession()
        s.host.readOnly = true
        acceptAuth(s)
        var settingsTime = 0L
        var enabled = false
        s.link.onDeviceCommand = { request ->
            when {
                request.cmdLo == 0x0e && request.kind == RingProtocol.KIND_REQ -> {
                    val args = byteArrayOf(
                        settingsTime.toByte(), (settingsTime ushr 8).toByte(),
                        (settingsTime ushr 16).toByte(), (settingsTime ushr 24).toByte(),
                        if (enabled) 1 else 0, 0, 0, 0, 0, 0, 0, 0,
                    )
                    s.link.deliver(checkedDeviceResponse(0x0e, request.seq, args))
                }
                request.cmdLo == 0x0e && request.kind == RingProtocol.KIND_DATA -> {
                    settingsTime = request.payload.copyOfRange(2, 6).foldIndexed(0L) { index, value, byte ->
                        value or ((byte.toLong() and 0xff) shl (index * 8))
                    }
                    enabled = request.payload[6].toInt() != 0
                    s.link.deliver(checkedDeviceResponse(0x0e, request.seq))
                }
                request.cmdLo == 0x05 -> s.link.deliver(checkedDeviceResponse(0x05, request.seq))
            }
        }

        val generation = s.core.requestRingHealthStartFresh()
        s.core.runRequestedRingHealthPull()
        assertTrue(s.core.ringHealthWindowActive)
        s.core.restartRingLinkForRoleChange()
        s.core.connectRing()

        val commands = s.link.framesWritten.filter { it.chan == RingProtocol.CHAN_DEVICE }
        assertEquals(listOf(0x08, 0x0e, 0x0e, 0x05, 0x0e), commands.map { it.cmdLo })
        assertEquals(listOf(RingProtocol.KIND_REQ, RingProtocol.KIND_REQ, RingProtocol.KIND_DATA,
            RingProtocol.KIND_DATA, RingProtocol.KIND_REQ), commands.map { it.kind })
        val healthSet = commands[2]
        val clockSet = commands[3]
        val healthUtc = healthSet.payload.copyOfRange(2, 6).foldIndexed(0L) { index, value, byte ->
            value or ((byte.toLong() and 0xff) shl (index * 8))
        }
        val clockUtc = clockSet.payload.copyOfRange(4, 8).foldIndexed(0L) { index, value, byte ->
            value or ((byte.toLong() and 0xff) shl (index * 8))
        }
        assertEquals(healthUtc, clockUtc)
        assertTrue(kotlin.math.abs(currentTimeMillis() / 1000L - clockUtc) <= 2L,
            "clock was not UTC epoch seconds")
        assertEquals(generation, s.core.ringHealthStartFreshGeneration)
        assertEquals("succeeded", s.core.ringHealthStartFreshState)
        assertEquals(healthUtc, settingsTime, "fresh settings timestamp was not verified by GET-after")
        assertTrue(s.core.lastRingHealthStartFreshResult.contains("recording enabled"),
            s.core.lastRingHealthStartFreshResult)
        assertFalse(s.core.ringHealthWindowActive)
        assertTrue(s.core.ringRoleReconnectPending)
    }

    @Test fun explicitFreshStartNeverReportsSuccessWithoutTheClockResponse() {
        val s = directSession()
        s.host.readOnly = true
        acceptAuth(s)
        s.core.ringHealthRspTimeoutMs = 20
        var settingsGets = 0
        s.link.onDeviceCommand = { request ->
            when {
                request.cmdLo == 0x0e && request.kind == RingProtocol.KIND_REQ -> {
                    settingsGets++
                    val args = byteArrayOf(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
                    s.link.deliver(checkedDeviceResponse(0x0e, request.seq, args))
                }
                request.cmdLo == 0x0e && request.kind == RingProtocol.KIND_DATA ->
                    s.link.deliver(checkedDeviceResponse(0x0e, request.seq))
                // Deliberately no 00:05 response.
            }
        }

        s.core.requestRingHealthStartFresh()
        s.core.runRequestedRingHealthPull()
        s.core.restartRingLinkForRoleChange()
        s.core.connectRing()

        assertEquals(1, settingsGets, "post-write verification ran without a clock response")
        assertEquals("failed", s.core.ringHealthStartFreshState)
        assertFalse(s.core.lastRingHealthStartFreshResult.contains("succeeded"))
        assertFalse(s.core.ringHealthWindowActive)
        assertTrue(s.core.ringRoleReconnectPending)
    }

    @Test fun explicitFreshStartAcceptsThePersistedTimestampWhenRecordingWasAlreadyEnabled() {
        val s = directSession()
        s.host.readOnly = true
        acceptAuth(s)
        val persistedSettingsTime = 1_700_000_000L
        s.link.onDeviceCommand = { request ->
            when {
                request.cmdLo == 0x0e && request.kind == RingProtocol.KIND_REQ -> {
                    val args = byteArrayOf(
                        persistedSettingsTime.toByte(), (persistedSettingsTime ushr 8).toByte(),
                        (persistedSettingsTime ushr 16).toByte(), (persistedSettingsTime ushr 24).toByte(),
                        1, 0, 0, 0, 0, 0, 0, 0,
                    )
                    s.link.deliver(checkedDeviceResponse(0x0e, request.seq, args))
                }
                request.cmdLo == 0x0e && request.kind == RingProtocol.KIND_DATA ->
                    s.link.deliver(checkedDeviceResponse(0x0e, request.seq))
                request.cmdLo == 0x05 -> s.link.deliver(checkedDeviceResponse(0x05, request.seq))
            }
        }

        s.core.requestRingHealthStartFresh()
        s.core.runRequestedRingHealthPull()
        s.core.restartRingLinkForRoleChange()
        s.core.connectRing()

        assertEquals("succeeded", s.core.ringHealthStartFreshState)
        assertTrue(s.core.lastRingHealthStartFreshResult.contains(persistedSettingsTime.toString()))
    }

    @Test fun queuedFreshStartExpiresAndCanNeverWriteWhenTheSessionLaterBecomesReady() {
        val s = directSession()
        s.host.readOnly = true
        s.core.monitor.withLock {
            s.core.sessionReady = false
            s.core.lastDirectRingInputAtMs = s.core.now()
        }
        s.core.requestRingHealthStartFresh()
        s.core.runRequestedRingHealthPull()
        assertTrue(s.core.ringHealthStartFreshRequested)
        assertTrue(s.link.framesWritten.isEmpty())

        s.core.monitor.withLock { s.core.ringHealthStartFreshDeadlineMs = s.core.now() - 1 }
        s.core.runRequestedRingHealthPull()
        s.core.monitor.withLock {
            assertFalse(s.core.ringHealthStartFreshRequested)
            assertFalse(s.core.ringHealthStartFreshActive)
            assertEquals("failed", s.core.ringHealthStartFreshState)
            s.core.sessionReady = true
            s.core.lastDirectRingInputAtMs = 0
        }
        s.core.runRequestedRingHealthPull()

        assertFalse(s.core.ringHealthWindowActive)
        assertTrue(s.link.framesWritten.isEmpty(), "expired request wrote after later readiness")
    }

    @Test fun readOnlyAuthRequiresMatchingSuccessfulDurableResponse() {
        for (bad in listOf("missing", "seq", "command", "channel", "status", "payload", "journal")) {
            val s = directSession()
            s.host.readOnly = true
            s.core.ringHealthRspTimeoutMs = 20
            s.core.ringHealthDataIdleMs = 1
            s.link.onAuthRequest = { req ->
                if (bad != "missing") {
                    s.host.journalFails = bad == "journal"
                    s.link.deliver(RingProtocol.buildFrame(
                        if (bad == "channel") RingProtocol.CHAN_HEALTH else RingProtocol.CHAN_DEVICE,
                        if (bad == "status") 7 else RingProtocol.KIND_RSP,
                        0, if (bad == "command") 2 else RingProtocol.CMD_LO_PAIR_AUTH,
                        if (bad == "seq") req.seq + 1 else req.seq,
                        if (bad == "payload") byteArrayOf(0, 0, 1) else byteArrayOf(0, 0, 0)))
                }
            }
            s.core.requestRingHealthNow()
            s.core.runRequestedRingHealthPull()
            s.core.onRingDataChannelReady()
            assertTrue(s.link.writes.isEmpty(), "health requested after $bad auth")
            assertFalse(s.core.ringHealthWindowActive, "window not closed after $bad auth")
            assertTrue(s.core.ringRoleReconnectPending, "Direct not restored after $bad auth")
            assertEquals(DIRECT_RING_ROLE_GLASSES, s.core.effectiveRingRoleLocked())
        }
    }

    @Test fun activeWindowDeadlineBoundsRspWaitAndWriteTimeoutAndRestoresDirect() {
        for (responds in listOf(false, true)) {
        val s = directSession()
        s.host.readOnly = true
        acceptAuth(s)
        s.link.answer = false
        if (responds) s.link.onHealthRequest = { req ->
            s.link.deliver(RingProtocol.buildFrame(RingProtocol.CHAN_HEALTH, RingProtocol.KIND_RSP,
                req.cmdHi, req.cmdLo, req.seq, byteArrayOf(0, 0)))
        }
        s.core.ringHealthRspTimeoutMs = 10_000
        s.core.ringHealthDataIdleMs = 10_000
        s.core.requestRingHealthNow()
        s.core.runRequestedRingHealthPull()
        s.core.ringHealthWindowDeadlineMs = s.core.now() + 60
        val start = s.core.now()
        s.core.onRingDataChannelReady()
        assertTrue(s.core.now() - start < 300, "deadline ignored during response wait")
        assertTrue(s.link.writeTimeouts.all { it in 1..60 }, "write not capped to window")
        assertEquals(listOf("req:1"), s.link.writes)
        assertFalse(s.core.ringHealthWindowActive)
        assertTrue(s.core.ringRoleReconnectPending)
        assertTrue(s.core.lastRingHealthPullResult.startsWith("aborted"))
        }
    }

    @Test fun readOnlyDirectWindowReturnsToGlassesAfterSuccessfulPull() {
        val s = directSession()
        s.host.readOnly = true
        acceptAuth(s)
        s.core.requestRingHealthNow()
        s.core.runRequestedRingHealthPull()
        s.core.restartRingLinkForRoleChange()
        s.core.connectRing()
        assertEquals(listOf(BleProtocol.R1_LEGACY_NOTIFY_CHAR_UUID to false,
            BleProtocol.R1_LEGACY_NOTIFY_CHAR_UUID to false, BleProtocol.R1_NOTIFY_CHAR_UUID to true),
            s.link.notificationChanges)
        assertTrue(s.core.lastRingHealthPullResult.startsWith("completed"))
        assertFalse(s.core.ringHealthWindowActive)
        assertTrue(s.core.ringRoleReconnectPending)
        val writeCount = s.link.framesWritten.size
        s.core.restartRingLinkForRoleChange()
        s.core.connectRing()
        assertEquals(2, s.link.disconnects)
        assertEquals(listOf(BleProtocol.R1_LEGACY_NOTIFY_CHAR_UUID to true,
            BleProtocol.R1_NOTIFY_CHAR_UUID to true), s.link.notificationChanges.takeLast(2))
        assertEquals(writeCount, s.link.framesWritten.size, "GLASSES reconnect performed health writes")
        assertEquals(DIRECT_RING_ROLE_GLASSES, s.core.effectiveRingRoleLocked())
    }

    @Test fun failedLegacyRestorationReconnectsOnlyAsGlasses() {
        val s = directSession()
        s.host.readOnly = true
        s.link.failLegacyDisable = true
        s.link.failLegacyEnable = true
        s.core.requestRingHealthNow()
        s.core.runRequestedRingHealthPull()
        s.core.restartRingLinkForRoleChange()
        assertFalse(s.core.ringHealthWindowActive)
        assertEquals(DIRECT_RING_ROLE_GLASSES, s.core.effectiveRingRoleLocked())
        assertEquals(1, s.link.disconnects)
        assertTrue(s.link.framesWritten.isEmpty())
    }

    @Test fun readOnlySwitchDisablesLegacyBeforeDisconnectAndRestoresItOnFailure() {
        for (fails in listOf(false, true)) {
            val s = directSession()
            s.host.readOnly = true
            s.link.failLegacyDisable = fails
            s.core.requestRingHealthNow()
            s.core.runRequestedRingHealthPull()
            s.core.restartRingLinkForRoleChange()
            assertEquals(BleProtocol.R1_LEGACY_NOTIFY_CHAR_UUID to false, s.link.notificationChanges.first())
            if (fails) {
                assertEquals(0, s.link.disconnects, "switched roles despite CCCD failure")
                assertEquals(BleProtocol.R1_LEGACY_NOTIFY_CHAR_UUID to true, s.link.notificationChanges.last())
                assertFalse(s.core.ringHealthWindowActive)
                assertFalse(s.core.ringRoleReconnectPending)
                assertTrue(s.core.ringNotificationsReady)
            } else {
                assertEquals(1, s.link.disconnects)
                assertTrue(s.core.ringHealthWindowActive)
                assertFalse(s.core.ringNotificationsReady)
            }
        }
    }

    @Test fun aPageBeingJournaledCannotLookLikeAnIdleTransfer() {
        val s = RingSession()
        val entered = Latch(1, s.platform)
        val release = Latch(1, s.platform)
        val done = Latch(1, s.platform)
        s.core.ringHealthDataIdleMs = 10
        s.link.onHealthRequest = { req ->
            s.link.deliver(RingProtocol.buildFrame(RingProtocol.CHAN_HEALTH, RingProtocol.KIND_RSP,
                req.cmdHi, req.cmdLo, req.seq, byteArrayOf(0, 0)))
            if (req.cmdHi == 1) {
                s.host.beforeJournal = { entered.countDown(); release.await(1000) }
                startThread("slow-ring-journal", true) {
                    s.link.deliver(RingProtocol.buildFrame(RingProtocol.CHAN_HEALTH, RingProtocol.KIND_DATA,
                        req.cmdHi, req.cmdLo, 40, byteArrayOf(0, 0)))
                }
                assertTrue(entered.await(300))
            }
        }
        startThread("ring-pull", true) {
            try { s.core.requestRingHealth() } finally { done.countDown() }
        }
        try {
            assertTrue(entered.await(300))
            sleepMs(50)
            assertEquals(listOf("req:1"), s.link.writes, "advanced while page durability was pending")
        } finally {
            release.countDown()
            assertTrue(done.await(1500))
        }
    }

    @Test fun unrelatedResponsesCannotAdvanceThePull() {
        for (mismatch in listOf("command", "sequence", "subcommand", "channel")) {
            val s = RingSession()
            s.core.ringHealthRspTimeoutMs = 30
            s.core.ringHealthDataIdleMs = 1
            s.link.onHealthRequest = { req ->
                s.link.deliver(RingProtocol.buildFrame(
                    if (mismatch == "channel") RingProtocol.CHAN_DEVICE else RingProtocol.CHAN_HEALTH,
                    RingProtocol.KIND_RSP,
                    if (mismatch == "command") req.cmdHi + 1 else req.cmdHi,
                    if (mismatch == "subcommand") req.cmdLo + 1 else req.cmdLo,
                    if (mismatch == "sequence") req.seq + 1 else req.seq, byteArrayOf(0, 0)))
            }
            assertFalse(s.core.requestRingHealth(), "$mismatch response completed pull")
            assertEquals(listOf("req:1"), s.link.writes, "advanced after $mismatch response")
        }
    }

    @Test fun corruptPageAfterRspAbortsBeforeTheNextMetric() {
        val s = RingSession()
        s.core.ringHealthDataIdleMs = 1
        s.link.onHealthRequest = { req ->
            s.link.deliver(RingProtocol.buildFrame(RingProtocol.CHAN_HEALTH, RingProtocol.KIND_RSP,
                req.cmdHi, req.cmdLo, req.seq, byteArrayOf(0, 0)))
            val page = RingProtocol.buildFrame(RingProtocol.CHAN_HEALTH, RingProtocol.KIND_DATA,
                req.cmdHi, req.cmdLo, 41, byteArrayOf(0, 0))
            page[1] = (page[1].toInt() xor 1).toByte()
            s.link.deliver(page)
        }
        assertFalse(s.core.requestRingHealth(), "corrupt page completed pull")
        assertEquals(listOf("req:1"), s.link.writes, "advanced after corrupt page")
        assertEquals(0, s.outboundSize())
    }

    @Test fun journalFailureAfterRspAbortsBeforeTheNextMetric() {
        val s = RingSession()
        s.core.ringHealthDataIdleMs = 1
        s.link.onHealthRequest = { req ->
            s.link.deliver(RingProtocol.buildFrame(RingProtocol.CHAN_HEALTH, RingProtocol.KIND_RSP,
                req.cmdHi, req.cmdLo, req.seq, byteArrayOf(0, 0)))
            s.host.journalFails = true
            s.link.deliver(RingProtocol.buildFrame(RingProtocol.CHAN_HEALTH, RingProtocol.KIND_DATA,
                req.cmdHi, req.cmdLo, 41, byteArrayOf(0, 0)))
            s.host.journalFails = false
        }
        assertFalse(s.core.requestRingHealth(), "unjournaled page completed pull")
        assertEquals(listOf("req:1"), s.link.writes, "advanced after journal failure")
        assertEquals(0, s.outboundSize())
    }

    @Test fun shutdownCancelsAnRspWait() {
        val s = RingSession()
        s.link.answer = false
        s.core.ringHealthRspTimeoutMs = 10_000
        val done = Latch(1, s.platform)
        startThread("ring-pull", true) {
            s.core.requestRingHealth()
            done.countDown()
        }
        val deadline = s.platform.elapsedRealtimeMs() + 1000
        while (!s.link.requestStarted && s.platform.elapsedRealtimeMs() < deadline) sleepMs(5)
        assertTrue(s.link.requestStarted, "no request")
        val start = s.platform.elapsedRealtimeMs()
        s.core.monitor.withLock {
            s.core.running = false
            s.core.monitor.signalAll()
        }
        assertTrue(done.await(300), "ring pull did not stop")
        assertTrue(s.platform.elapsedRealtimeMs() - start < 300, "session lock blocked")
    }

    @Test fun ackPacedPagesDrainBeforeTheNextType() {
        val s = RingSession()
        s.link.delayRsp = true
        assertTrue(s.core.requestRingHealth(), "pull failed")
        val expected = RingProtocol.HEALTH_COMMANDS.flatMap { command ->
            listOf("req:$command", "ack:" + (command * 10 + 1), "ack:" + (command * 10 + 2))
        }
        assertEquals(expected, s.link.writes, "premature next type")
        // Every intact frame (each page and each RSP) was journaled.
        assertEquals(expected.count { it.startsWith("ack:") } + RingProtocol.HEALTH_COMMANDS.size, s.host.journal.size)
    }

    @Test fun failedAckAbortsAndStaysQueuedForRetry() {
        val s = RingSession()
        s.link.failAck = true
        assertFalse(s.core.requestRingHealth(), "failed ACK completed pull")
        assertEquals(1, s.link.writes.size, "advanced after failed ACK")
        assertEquals(1, s.outboundSize(), "failed ACK was discarded")
        s.link.failAck = false
        // The failure paused ring writes; the retry must not touch the link yet.
        assertEquals(-1, s.core.flushRingOutbound(), "retried inside the write backoff")
        assertEquals(1, s.outboundSize(), "backoff dropped the queued ACK")
        s.core.monitor.withLock { s.core.ringWriteBlockedUntilMs = 0L }
        assertTrue(s.core.awaitRingHealthDataIdle(s.core.ringHealthDataIdleMs), "retry failed")
        assertEquals(0, s.outboundSize(), "retry did not drain ACKs")
    }

    @Test fun writeBackoffGrowsAndResetsOnSuccess() {
        val s = RingSession()
        s.link.failAck = true
        s.core.queueRingPageAck(RingProtocol.parse(RingProtocol.buildFrame(RingProtocol.CHAN_HEALTH,
            RingProtocol.KIND_DATA, RingProtocol.CMD_HI_HEART_RATE, RingProtocol.CMD_LO_HEALTH, 1, byteArrayOf(0, 0)))!!)
        fun pausedForMs() = s.core.monitor.withLock { s.core.ringWriteBlockedUntilMs - s.core.now() }
        assertEquals(-1, s.core.flushRingOutbound())
        val first = pausedForMs()
        s.core.monitor.withLock { s.core.ringWriteBlockedUntilMs = 0L }
        assertEquals(-1, s.core.flushRingOutbound())
        assertTrue(pausedForMs() > first, "backoff did not grow")
        s.link.failAck = false
        s.core.monitor.withLock { s.core.ringWriteBlockedUntilMs = 0L }
        assertEquals(1, s.core.flushRingOutbound())
        assertEquals(0, s.core.monitor.withLock { s.core.ringWriteFailures }, "success did not reset the backoff")
    }

    @Test fun missingRspAbortsWithoutAdvancing() {
        val s = RingSession()
        s.link.answer = false
        assertFalse(s.core.requestRingHealth(), "missing RSP completed pull")
        assertEquals(1, s.link.writes.size, "advanced without RSP")
    }

    @Test fun disconnectFailsTheDataWait() {
        val s = RingSession()
        s.core.monitor.withLock { s.core.ringConnected = false }
        assertFalse(s.core.awaitRingHealthDataIdle(100), "disconnect completed transfer")
    }

    @Test fun unjournaledPageIsNotAcknowledged() {
        val s = RingSession()
        s.host.journalFails = true
        s.core.onNotification(RING, BleProtocol.R1_NOTIFY_CHAR_UUID,
            RingProtocol.buildFrame(RingProtocol.CHAN_HEALTH, RingProtocol.KIND_DATA, RingProtocol.CMD_HI_HEART_RATE,
                RingProtocol.CMD_LO_HEALTH, 7, byteArrayOf(0, 0)))
        assertEquals(0, s.outboundSize())
    }

    @Test fun batchWatermarkOnlyClearsWhatWasTaken() {
        val s = RingSession()
        // A decodable one-group heart-rate page: count 1, tz 0, anchor 1000, then [hour][avg][max][min].
        val payload = byteArrayOf(0, 0, 1, 0, 0, 0xe8.toByte(), 0x03, 0, 0, 2, 60, 70, 50)
        fun deliver(seq: Int) = s.core.onNotification(RING, BleProtocol.R1_NOTIFY_CHAR_UUID,
            RingProtocol.buildFrame(RingProtocol.CHAN_HEALTH, RingProtocol.KIND_DATA, RingProtocol.CMD_HI_HEART_RATE,
                RingProtocol.CMD_LO_HEALTH, seq, payload))
        deliver(1)
        deliver(2)
        val batch = s.core.takeRingHealthBatch()
        assertEquals(2, batch.records.size)
        assertEquals(2L, batch.watermark)
        deliver(3)
        assertEquals(2, s.core.clearRingHealthRecordsBelow(batch.watermark))
        val rest = s.core.getRingHealthRecords()
        assertEquals(1, rest.size)
        val record = rest.single() as RingProtocol.HourlyRecord
        assertEquals(60, record.groups.single().avg)
        assertEquals(1000L + 2 * 3600L, record.groups.single().unixSeconds)
    }

    @Test fun configuredRingIdentityIsImmutableAndJournaledBeforeAcknowledgement() {
        val s = RingSession("cc:00:00:00:00:03")
        assertEquals("CC:00:00:00:00:03", s.core.takeRingHealthBatch().ringId)
        assertFailsWith<IllegalStateException> { s.core.setRingHealthIdentity("CC:00:00:00:00:04") }

        s.core.onNotification(RING, BleProtocol.R1_NOTIFY_CHAR_UUID,
            RingProtocol.buildFrame(RingProtocol.CHAN_HEALTH, RingProtocol.KIND_DATA,
                RingProtocol.CMD_HI_HEART_RATE, RingProtocol.CMD_LO_HEALTH, 7, byteArrayOf(0, 0)))
        assertTrue(s.host.journal.single().contains("\"ringId\":\"CC:00:00:00:00:03\""))
        assertEquals(1, s.outboundSize())
    }

    @Test fun pullCompletionPostsOnceToTheCapturedListener() {
        val s = RingSession()
        val original = RingPullListener()
        val replacement = RingPullListener()
        s.host.deferMain = true
        s.core.setListener(original)
        s.host.clearMain()

        s.core.runRingHealthPull()
        s.core.listener = replacement
        s.host.drainMain()

        assertEquals(1, original.pulls.size)
        assertTrue(original.pulls.single().first)
        assertEquals(10, original.pulls.single().second)
        assertEquals(0L, original.pulls.single().third)
        assertTrue(replacement.pulls.isEmpty())
    }

    @Test fun abortedPartialPullReportsItsPagesAndWatermark() {
        val s = RingSession()
        val listener = RingPullListener()
        s.core.setListener(listener)
        s.link.onHealthRequest = { request ->
            val payload = byteArrayOf(0, 0, 1, 0, 0, 0xe8.toByte(), 0x03, 0, 0, 2, 60, 70, 50)
            s.link.deliver(RingProtocol.buildFrame(RingProtocol.CHAN_HEALTH, RingProtocol.KIND_DATA,
                request.cmdHi, request.cmdLo, 41, payload))
        }

        s.core.runRingHealthPull()

        assertEquals(listOf(Triple(false, 2, 1L)), listener.pulls)
    }

    @Test fun thrownPullStillReportsItsPartialSnapshotOnceAndRethrows() {
        val s = RingSession()
        val listener = RingPullListener()
        s.core.setListener(listener)
        var checks = 0
        s.host.beforeReadOnlyCheck = {
            checks++
            if (checks == 2) {
                s.core.monitor.withLock {
                    s.core.ringHealthPageCounter += 2
                    s.core.ringHealthTotalAdded++
                }
                throw IllegalStateException("transfer exploded")
            }
        }

        val error = assertFailsWith<IllegalStateException> { s.core.runRingHealthPull() }

        assertEquals("transfer exploded", error.message)
        assertEquals(listOf(Triple(false, 2, 1L)), listener.pulls)
        assertTrue(s.core.lastRingHealthPullResult.startsWith("aborted"))
    }
    /** A Direct-mode (glasses-role) session whose direct link is up. */
    private fun directSession(): RingSession {
        val s = RingSession()
        s.core.monitor.withLock {
            s.core.directRingRole = DIRECT_RING_ROLE_GLASSES
            s.core.sessionReady = true
        }
        return s
    }

    @Test fun independentReadOnlyConsentAdmitsOnlyAnExplicitPhoneRoleWindowWithoutGlasses() {
        val s = directSession()
        s.host.readOnly = true
        s.core.monitor.withLock {
            s.core.sessionReady = false
            s.core.ringConnected = false
            s.core.ringNotificationsReady = false
        }

        assertFalse(s.core.canSyncRingHealth())
        s.core.requestRingHealthNow()
        s.core.runRequestedRingHealthPull()
        assertFalse(s.core.ringHealthWindowActive)
        assertFalse(s.core.shouldAttemptRingConnect())

        s.core.setIndependentRingHealthEnabled(true)
        assertTrue(s.core.canSyncRingHealth())
        val status = Json.parseObject(s.core.getRingStatus())
        assertEquals(true, status["independentHealthEnabled"])
        assertEquals("independent-read-only", status["healthAdmissionMode"])
        assertEquals(false, status["sessionReady"])
        s.core.requestRingHealthNow()
        s.core.runRequestedRingHealthPull()

        assertTrue(s.core.ringHealthWindowActive)
        assertEquals(DIRECT_RING_ROLE_PHONE, s.core.effectiveRingRoleLocked())
        assertTrue(s.core.shouldAttemptRingConnect())
        assertTrue(s.link.framesWritten.isEmpty(), "ring-only admission mutated R1 state")
        assertTrue(s.link.notificationChanges.isEmpty(), "ring-only admission configured GLASSES")

        acceptAuth(s)
        s.core.connectRing()
        assertTrue(s.core.lastRingHealthPullResult.startsWith("completed"), s.core.lastRingHealthPullResult)
        assertTrue(s.link.framesWritten.all { frame ->
            frame.kind == RingProtocol.KIND_ACK || frame.kind == RingProtocol.KIND_REQ &&
                (frame.chan == RingProtocol.CHAN_HEALTH || frame.cmdLo in listOf(1, 2, 11, RingProtocol.CMD_LO_PAIR_AUTH))
        }, "ring-only retrieval emitted recording, clock, or binding commands")
    }

    @Test fun armLossDuringAnAuthorizedReadOnlyPullDoesNotAbortTheRingTransfer() {
        val s = directSession()
        s.host.readOnly = true
        s.core.setIndependentRingHealthEnabled(true)
        acceptAuth(s)
        s.link.onHealthRequest = { request ->
            s.core.monitor.withLock { s.core.sessionReady = false }
            s.link.deliver(RingProtocol.buildFrame(RingProtocol.CHAN_HEALTH, RingProtocol.KIND_RSP,
                request.cmdHi, request.cmdLo, request.seq, byteArrayOf(0, 0)))
        }
        s.core.requestRingHealthNow()
        s.core.runRequestedRingHealthPull()

        s.core.onRingDataChannelReady()

        assertTrue(s.core.lastRingHealthPullResult.startsWith("completed"), s.core.lastRingHealthPullResult)
        assertFalse(s.core.ringHealthWindowActive)
    }

    @Test fun independentConsentRevocationCancelsPendingDialAndAbortsAnActivePull() {
        val s = directSession()
        s.host.readOnly = true
        s.link.allowBackgroundConnect = true
        s.core.monitor.withLock {
            s.core.sessionReady = false
            s.core.ringConnected = false
            s.core.ringNotificationsReady = false
        }
        s.core.setIndependentRingHealthEnabled(true)
        s.core.requestRingHealthNow()
        s.core.runRequestedRingHealthPull()
        s.core.tryConnectRing("test")
        assertTrue(s.link.backgroundConnectPending)

        s.core.setIndependentRingHealthEnabled(false)

        assertFalse(s.link.backgroundConnectPending)
        assertFalse(s.core.ringHealthWindowActive)
        assertFalse(s.core.ringHealthPullRequested)
        assertFalse(s.core.shouldAttemptRingConnect())
        assertFalse(s.core.canSyncRingHealth())

        val active = directSession()
        active.host.readOnly = true
        active.core.setIndependentRingHealthEnabled(true)
        active.core.monitor.withLock { active.core.sessionReady = false }
        acceptAuth(active)
        active.link.onHealthRequest = { request ->
            active.core.setIndependentRingHealthEnabled(false)
            active.link.deliver(RingProtocol.buildFrame(RingProtocol.CHAN_HEALTH, RingProtocol.KIND_RSP,
                request.cmdHi, request.cmdLo, request.seq, byteArrayOf(0, 0)))
        }
        active.core.requestRingHealthNow()
        active.core.runRequestedRingHealthPull()
        active.core.onRingDataChannelReady()

        assertTrue(active.core.lastRingHealthPullResult.startsWith("aborted"))
        assertEquals(1, active.link.framesWritten.count { it.chan == RingProtocol.CHAN_HEALTH && it.kind == RingProtocol.KIND_REQ })
        assertFalse(active.core.ringHealthTransferActive)
    }

    @Test fun independentWindowTimeoutCancelsPendingDialAndDoesNotRedialGlassesUntilTheyReturn() {
        val s = directSession()
        s.host.readOnly = true
        s.link.allowBackgroundConnect = true
        s.core.monitor.withLock {
            s.core.sessionReady = false
            s.core.ringConnected = false
            s.core.ringNotificationsReady = false
        }
        s.core.setIndependentRingHealthEnabled(true)
        s.core.requestRingHealthNow()
        s.core.runRequestedRingHealthPull()
        s.core.tryConnectRing("test")
        s.core.monitor.withLock { s.core.ringHealthWindowDeadlineMs = s.core.now() - 1 }

        s.core.expireRingHealthWindow()

        assertFalse(s.link.backgroundConnectPending)
        assertFalse(s.core.shouldAttemptRingConnect(), "ring-only completion redialed GLASSES")
        s.core.monitor.withLock {
            s.core.sessionReady = true
            s.core.ringReconnectAfterMs = 0
        }
        assertTrue(s.core.shouldAttemptRingConnect(), "returning glasses did not restore Direct GLASSES")
        assertEquals(DIRECT_RING_ROLE_GLASSES, s.core.effectiveRingRoleLocked())
    }

    @Test fun revocationAndTimeoutCancelAnIndependentConnectionThatLandedBeforeNotifications() {
        for (timeout in listOf(false, true)) {
            val s = directSession()
            s.host.readOnly = true
            s.core.monitor.withLock {
                s.core.sessionReady = false
                s.core.ringConnected = false
                s.core.ringNotificationsReady = false
            }
            s.core.setIndependentRingHealthEnabled(true)
            s.core.requestRingHealthNow()
            s.core.runRequestedRingHealthPull()
            s.core.monitor.withLock {
                s.core.ringConnected = true
                s.core.ringBackgroundConnectPending = false
                if (timeout) s.core.ringHealthWindowDeadlineMs = s.core.now() - 1
            }

            if (timeout) s.core.expireRingHealthWindow() else s.core.setIndependentRingHealthEnabled(false)

            assertEquals(1, s.link.disconnects, "landed connection survived " + if (timeout) "timeout" else "revocation")
            assertFalse(s.core.ringHealthWindowActive)
        }
    }

    @Test fun permanentPhoneRoleRetainsItsRequestUntilTheIndependentLinkIsUsable() {
        val s = RingSession()
        s.host.readOnly = true
        s.core.monitor.withLock {
            s.core.directRingRole = DIRECT_RING_ROLE_PHONE
            s.core.sessionReady = false
            s.core.ringConnected = false
            s.core.ringNotificationsReady = false
        }
        s.core.setIndependentRingHealthEnabled(true)
        s.core.requestRingHealthNow()

        s.core.runRequestedRingHealthPull()

        assertTrue(s.core.ringHealthPullRequested)
        assertTrue(s.core.shouldAttemptRingConnect())
        assertTrue(s.core.canSyncRingHealth())
    }

    @Test fun mutableHealthHostKeepsItsExistingDropWhenRingNotReadyBehavior() {
        val s = RingSession()
        s.core.monitor.withLock {
            s.core.sessionReady = true
            s.core.ringConnected = false
            s.core.ringNotificationsReady = false
        }
        s.core.requestRingHealthNow()

        s.core.runRequestedRingHealthPull()

        assertFalse(s.core.ringHealthPullRequested)
    }

    @Test fun permanentPhoneIndependentLinkCannotRunQueuedFreshRecordingWithoutGlasses() {
        val s = RingSession()
        s.host.readOnly = true
        s.core.monitor.withLock {
            s.core.directRingRole = DIRECT_RING_ROLE_PHONE
            s.core.sessionReady = false
        }
        s.core.setIndependentRingHealthEnabled(true)
        s.core.requestRingHealthStartFresh()

        s.core.runRequestedRingHealthPull()

        assertTrue(s.core.ringHealthStartFreshRequested)
        assertTrue(s.link.framesWritten.isEmpty(), "fresh recording ran on an independent PHONE link")
    }

    @Test fun revocationDuringBackgroundSubmissionOrBlockingFallbackCannotSetUpGlassesRole() {
        for (background in listOf(true, false)) {
            val s = directSession()
            s.host.readOnly = true
            s.link.allowBackgroundConnect = background
            s.core.monitor.withLock {
                s.core.sessionReady = false
                s.core.ringConnected = false
                s.core.ringNotificationsReady = false
            }
            s.core.setIndependentRingHealthEnabled(true)
            s.core.requestRingHealthNow()
            s.core.runRequestedRingHealthPull()
            s.link.onBeginConnect = { s.core.setIndependentRingHealthEnabled(false) }

            s.core.tryConnectRing("revocation race")

            assertFalse(s.link.backgroundConnectPending)
            assertTrue(s.link.notificationChanges.isEmpty(), "revoked attempt configured a ring role")
            assertFalse(s.core.ringNotificationsReady)
            assertTrue(s.link.disconnects > 0, "revoked attempt was not cancelled")
            assertEquals(0, s.link.connectCalls, "revoked beginConnect fallback started blocking connect")
        }
    }

    @Test fun revokedIndependentPhoneLinkCannotRunALaterReadOnlyRequest() {
        val s = RingSession()
        s.host.readOnly = true
        s.core.monitor.withLock {
            s.core.directRingRole = DIRECT_RING_ROLE_PHONE
            s.core.sessionReady = false
        }
        s.core.setIndependentRingHealthEnabled(true)
        s.core.setIndependentRingHealthEnabled(false)
        acceptAuth(s)

        s.core.requestRingHealthNow()
        s.core.runRequestedRingHealthPull()

        assertTrue(s.link.framesWritten.isEmpty(), "revoked independent PHONE link ran a health request")
    }

    @Test fun revocationBetweenPhoneAdmissionAndTransferActivationPreventsAuthentication() {
        val s = RingSession()
        s.host.readOnly = true
        s.core.monitor.withLock { s.core.directRingRole = DIRECT_RING_ROLE_PHONE }
        s.core.setIndependentRingHealthEnabled(true)
        var checks = 0
        s.host.beforeReadOnlyCheck = {
            checks++
            if (checks == 2) s.core.setIndependentRingHealthEnabled(false)
        }
        s.core.requestRingHealthNow()

        s.core.runRequestedRingHealthPull()

        assertTrue(s.link.framesWritten.isEmpty(), "revocation race emitted PHONE authentication")
        assertFalse(s.core.ringHealthTransferActive)
    }

    @Test fun independentAdmissionNeverStartsFreshRecordingAndDisconnectIsTerminal() {
        val s = directSession()
        s.host.readOnly = true
        s.core.monitor.withLock {
            s.core.sessionReady = false
            s.core.ringConnected = false
            s.core.ringNotificationsReady = false
        }
        s.core.setIndependentRingHealthEnabled(true)
        s.core.requestRingHealthStartFresh()
        s.core.runRequestedRingHealthPull()
        assertTrue(s.core.ringHealthStartFreshRequested)
        assertFalse(s.core.ringHealthWindowActive)
        assertTrue(s.link.framesWritten.isEmpty())

        s.core.disconnect()
        s.core.onConnectionStateChange(RING, true)
        assertFalse(s.core.canSyncRingHealth())
        assertFalse(s.core.shouldAttemptRingConnect())
    }

    @Test fun directModePullBorrowsThePhoneRoleAndHandsItBack() {
        val s = directSession()
        // Not the first pull this session, so only the request opens the window.
        s.core.monitor.withLock { s.core.ringHealthLastRequestedAtMs = s.core.now() - 10 * 60_000L }
        s.core.runRequestedRingHealthPull()
        assertFalse(s.core.monitor.withLock { s.core.ringHealthWindowActive }, "opened without a request")

        s.core.requestRingHealthNow()
        s.core.runRequestedRingHealthPull()
        s.core.monitor.withLock {
            assertTrue(s.core.ringHealthWindowActive, "request did not open a health window")
            assertTrue(s.core.ringRoleReconnectPending, "glasses-role link was not dropped")
            assertEquals(DIRECT_RING_ROLE_PHONE, s.core.effectiveRingRoleLocked())
        }
        s.core.restartRingLinkForRoleChange()
        assertEquals(1, s.link.disconnects)
        s.core.monitor.withLock {
            assertFalse(s.core.ringNotificationsReady)
            assertTrue(s.core.ringReconnectAfterMs > s.core.now(), "redialed before the old link could end")
        }

        // Phone-role setup: data CCCD only, then the handshake and the pull.
        s.core.connectRing()
        assertEquals(listOf(BleProtocol.R1_NOTIFY_CHAR_UUID), s.link.subscribed, "phone role took the legacy CCCD")
        val requests = RingProtocol.HEALTH_COMMANDS.map { "req:$it" }
        assertEquals(requests, s.link.writes.filter { it.startsWith("req:") }, "pull did not run")
        s.core.monitor.withLock {
            assertFalse(s.core.ringHealthWindowActive, "window left open after the pull")
            assertTrue(s.core.ringRoleReconnectPending, "link not handed back to the glasses role")
            assertTrue(s.core.lastRingHealthPullResult.startsWith("completed"), s.core.lastRingHealthPullResult)
        }
        // Back in the glasses role: legacy CCCD again, and no further health traffic.
        s.core.restartRingLinkForRoleChange()
        s.core.connectRing()
        assertEquals(listOf(BleProtocol.R1_LEGACY_NOTIFY_CHAR_UUID, BleProtocol.R1_NOTIFY_CHAR_UUID),
            s.link.subscribed.drop(1), "glasses role not restored")
        assertEquals(requests, s.link.writes.filter { it.startsWith("req:") }, "glasses-role link pulled")
    }

    @Test fun directModeWindowWaitsForAnIdleRingAndRespectsItsFloor() {
        val s = directSession()
        s.core.monitor.withLock {
            s.core.ringHealthLastRequestedAtMs = s.core.now() - 10 * 60_000L
            s.core.lastDirectRingInputAtMs = s.core.now()
        }
        s.core.requestRingHealthNow()
        s.core.runRequestedRingHealthPull()
        s.core.monitor.withLock {
            assertFalse(s.core.ringHealthWindowActive, "took the ring away mid-gesture")
            assertTrue(s.core.ringHealthPullRequested, "deferred request was dropped")
            s.core.lastDirectRingInputAtMs = s.core.now() - 60_000L
        }
        s.core.runRequestedRingHealthPull()
        assertTrue(s.core.monitor.withLock { s.core.ringHealthWindowActive }, "idle ring did not open a window")

        // A second request inside the floor is dropped rather than bouncing the link again.
        s.core.monitor.withLock { s.core.endRingHealthWindowLocked("test") }
        s.core.requestRingHealthNow()
        s.core.runRequestedRingHealthPull()
        s.core.monitor.withLock {
            assertFalse(s.core.ringHealthWindowActive, "window floor ignored")
            assertFalse(s.core.ringHealthPullRequested, "request inside the floor stayed pending")
        }
    }

    @Test fun directModeFirstPullWaitsForTheGlassesAndGivesUpOnAnUnreachableRing() {
        val s = directSession()
        s.core.monitor.withLock {
            s.core.ringConnected = false
            s.core.ringNotificationsReady = false
            s.core.sessionReady = false
        }
        s.core.runRequestedRingHealthPull()
        assertFalse(s.core.monitor.withLock { s.core.ringHealthWindowActive }, "opened before the glasses session")
        s.core.monitor.withLock { s.core.sessionReady = true }
        s.core.runRequestedRingHealthPull()
        s.core.monitor.withLock {
            assertTrue(s.core.ringHealthWindowActive, "no first pull this session")
            // Nothing set up to drop: the next connection sets up in the phone role.
            assertFalse(s.core.ringRoleReconnectPending)
            s.core.ringHealthWindowDeadlineMs = s.core.now() - 1
        }
        s.core.expireRingHealthWindow()
        s.core.monitor.withLock {
            assertFalse(s.core.ringHealthWindowActive, "window outlived its deadline")
            assertEquals(DIRECT_RING_ROLE_GLASSES, s.core.effectiveRingRoleLocked())
            assertTrue(s.core.lastRingHealthPullResult.startsWith("not run"), s.core.lastRingHealthPullResult)
        }
        // Not retried until something asks for it.
        s.core.runRequestedRingHealthPull()
        assertFalse(s.core.monitor.withLock { s.core.ringHealthWindowActive }, "retried without a request")
    }
}
