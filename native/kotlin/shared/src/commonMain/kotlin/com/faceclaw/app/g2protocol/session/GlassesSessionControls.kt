package com.faceclaw.app

import com.faceclaw.app.GlassesSessionCore.Companion.DASHBOARD_TILE
import com.faceclaw.app.GlassesSessionCore.Companion.FACECLAW_WAKE_CONTROL_WAIT_MS
import com.faceclaw.app.GlassesSessionCore.Companion.HEAD_UP_ANGLE_WAIT_MS
import com.faceclaw.app.GlassesSessionCore.Companion.TAG

/*
 * GlassesSessionCore, part 3: CFW lease controls, EvenHub shutdown, the bandwidth
 * benchmark stream, transport-failure handling and the listener emits (all
 * marshalled through SessionHost.postToMain, or a subscriber's own dispatcher
 * for compass events).
 */

// ---------------------------------------------------------------------------
// Bandwidth benchmark

/** Pending + in-flight benchmark no-op messages. */
internal fun GlassesSessionCore.benchmarkOutstandingLocked(): Int {
    var count = 0
    for (message in pendingMessages) {
        if ("bandwidth" == message.kind) count++
    }
    for (message in inFlightMessages) {
        if ("bandwidth" == message.kind) count++
    }
    return count
}

/**
 * Keep the benchmark stream fed: top the pending queue up so the send
 * window never starves, stop enqueueing once the run expires (or a message
 * times out), and finish the run when the last outstanding message drains.
 */
internal fun GlassesSessionCore.maintainBenchmarkLocked(now: Long) {
    if (!sessionReady || !fixedLayoutCreated || shutdownRequested) {
        finishBenchmarkLocked(true, "session no longer ready")
        return
    }
    if (benchmarkLinkPending || now < benchmarkReadyAtMs) {
        return
    }
    if (benchmarkAborted || now >= benchmarkDeadlineAtMs) {
        // The run is over: drop queued-but-unsent no-ops (sending them
        // would stretch the run past its deadline) and finish once the
        // in-flight tail has acked or timed out.
        val pendingIterator = pendingMessages.iterator()
        while (pendingIterator.hasNext()) {
            val queued = pendingIterator.next()
            if ("bandwidth" == queued.kind) {
                pendingIterator.remove()
                magicPool.release(queued.sid, queued.magic, queued.label, "benchmark over")
            }
        }
        if (benchmarkOutstandingLocked() == 0) {
            finishBenchmarkLocked(false, "complete")
        }
        return
    }
    // One more than the window so a fresh message is always ready to write
    // the moment an ack frees a slot.
    var outstanding = benchmarkOutstandingLocked()
    while (outstanding <= benchmarkWindowSize) {
        enqueueBenchmarkMessageLocked()
        outstanding++
    }
}

internal fun GlassesSessionCore.finishBenchmarkLocked(aborted: Boolean, reason: String) {
    if (!benchmarkActive) {
        return
    }
    benchmarkActive = false
    benchmarkAborted = benchmarkAborted or aborted
    // Prefer the last ack as the end time so drain lag after the deadline
    // doesn't dilute the throughput figure.
    benchmarkEndAtMs = if (benchmarkLastAckAtMs != 0L) benchmarkLastAckAtMs else now()
    logLine("bandwidth benchmark " + (if (benchmarkAborted) "aborted" else "finished") + " (" + reason + "): "
        + benchmarkMessagesAcked + "/" + benchmarkMessagesSent + " acked, "
        + benchmarkPayloadBytesAcked + "B payload, " + benchmarkTimeouts + " timeouts")
}

internal fun GlassesSessionCore.enqueueBenchmarkMessageLocked() {
    // Fresh bytes per message: the transport's persistent compression history
    // would compress even a random payload if we reused it across the run.
    val payload = ByteArray(benchmarkMessageSize)
    kotlin.random.Random.nextBytes(payload)
    payload[0] = CFW_MSG_DIAGNOSTICS.toByte()             // CFW diagnostic-control mode...
    payload[1] = 0x7f.toByte()   // ...with an unused sub-op: acked, no effect
    // A G1's arms are two links and every frame goes down both, so the run alternates between them.
    val leftArm = if (isG1) benchmarkMessageCounter++ % 2 == 0 else connectionOptions.sendImagesToLeft
    val message = messageBuilder.imagePayload(
        "bandwidth",
        DASHBOARD_TILE,
        nextMapSessionId(),
        payload,
        "bandwidth no-op " + payload.size + "B",
        leftArm)
    if (isG1) message.cfwRequiredLenses = if (leftArm) G1Timings.LENS_LEFT else G1Timings.LENS_RIGHT
    val payloadBytes = payload.size
    // Logical custom-message bytes; excludes length tag and packet framing.
    val wireBytes = message.message.size
    message.onSent = MessageCallback {
        benchmarkMessagesSent++
        if (benchmarkStartAtMs == 0L) {
            benchmarkStartAtMs = now()
            benchmarkDeadlineAtMs = benchmarkStartAtMs + benchmarkDurationMs
        }
    }
    message.onAck = MessageCallback {
        val ackedAtMs = now()
        benchmarkMessagesAcked++
        benchmarkPayloadBytesAcked += payloadBytes
        benchmarkWireBytesAcked += wireBytes
        benchmarkLastAckAtMs = ackedAtMs
        // No-op payloads ride the image path, so the firmware resets its
        // heartbeat timer on them just like real image messages.
        lastHeartbeatAckedAtMs = ackedAtMs
    }
    message.onTimeout = MessageCallback {
        benchmarkTimeouts++
        benchmarkAborted = true
        logLine("bandwidth benchmark ack timeout")
    }
    pendingMessages.addLast(message)
}

// ---------------------------------------------------------------------------
// EvenHub shutdown and audio control waits

internal fun GlassesSessionCore.sendShutdownInternal(exitMode: Int, reconnectOnTimeout: Boolean): Boolean {
    val magic: Int
    val startedAtMs = now()
    monitor.withLock {
        if (!running || !sessionReady) {
            logLine("skip shutdown; session not ready")
            return false
        }
        if (shutdownRequested) {
            return true
        }
        shutdownRequested = true
        // Magic values wrap, so an ACK from a much older suspend must not
        // satisfy this request after enough sleep/wake cycles.
        lastShutdownAckMagic = 0
        clearPendingMessagesLocked("shutdown requested")
        val message = messageBuilder.shutdown(exitMode)
        magic = message.magic
        message.onAck = MessageCallback {
            lastShutdownAckMagic = message.magic
            fixedLayoutCreated = false
            displayedFingerprint = ""
        }
        message.onTimeout = MessageCallback {
            if (reconnectOnTimeout) {
                handleTransportFailure("shutdown ack timeout")
            } else {
                logLine("EvenHub shutdown ack timeout; keeping BLE connected")
            }
        }
        pendingMessages.addFirst(message)
        logLine("queue shutdown")
        // The stock compass keeps the magnetometer sampling independently of
        // the plugin task, so ending the page does not stop it. Force a
        // disable ahead of the shutdown command whenever it may be running:
        // this also covers a disable that was wiped by the queue flush above
        // or whose ack was lost, and the charging-mode/exit paths where the
        // Compass window never got a chance to release it.
        if (compassMaybeOn && fixedLayoutCreated) {
            enqueueCompassControlLocked(true, false)
        }
    }
    interruptibleSleep.interrupt()

    val ackDeadline = now() + ConnectionOptions.ACK_TIMEOUT_MS + 500
    monitor.withLock {
        while (running
                && sessionReady
                && lastShutdownAckMagic != magic
                && lastShutdownExitAtMs < startedAtMs
                && hasPendingOrInflightMagicLocked(magic)) {
            val remaining = ackDeadline - now()
            if (remaining <= 0) {
                break
            }
            monitor.awaitMs(minOf(remaining, 100L))
        }
        val acked = lastShutdownAckMagic == magic
        if (acked) {
            val exitDeadline = now() + ConnectionOptions.ACK_TIMEOUT_MS + 500
            while (running && sessionReady && lastShutdownExitAtMs < startedAtMs) {
                val remaining = exitDeadline - now()
                if (remaining <= 0) {
                    break
                }
                monitor.awaitMs(minOf(remaining, 100L))
            }
        }
        return acked || lastShutdownExitAtMs >= startedAtMs
    }
}

internal fun GlassesSessionCore.waitForAudioControlAck(magic: Int, operation: String): Boolean {
    val deadline = now() + ConnectionOptions.ACK_TIMEOUT_MS + ConnectionOptions.WRITE_TIMEOUT_MS + 500
    monitor.withLock {
        while (running && sessionReady && lastAudioControlAckMagic != magic && hasPendingOrInflightMagicLocked(magic)) {
            val remaining = deadline - now()
            if (remaining <= 0) {
                break
            }
            monitor.awaitMs(minOf(remaining, 100L))
        }
        val acked = lastAudioControlAckMagic == magic
        if (!acked) {
            if ("enable" == operation) {
                audioPacketListener = null
                audioCaptureActive = false
            }
            logLine("G2 mic $operation ack timeout")
        }
        return acked
    }
}

// ---------------------------------------------------------------------------
// CFW wake and framebuffer leases

/**
 * Replace any stale lease control with one right-arm and one left-arm
 * fire-and-forget write. With priority=true the right arm is sent first so
 * CLAIM reaches the lens that originated the deferred wake immediately.
 */
internal fun GlassesSessionCore.enqueueFaceclawWakeControlLocked(operation: Int, nonce: Int, priority: Boolean): Int {
    clearMessagesOfKindLocked("wake-lease-control")
    val generation = ++faceclawWakeControlGeneration
    faceclawWakeControlSentCount = 0
    if (operation == BleProtocol.FACECLAW_WAKE_OP_ACQUIRE) {
        lastFaceclawWakeLeaseQueuedAtMs = now()
    }
    val onSent = MessageCallback {
        if (faceclawWakeControlGeneration == generation) {
            faceclawWakeControlSentCount += 1
        }
    }
    val right = messageBuilder.faceclawWakeControl(operation, nonce, false)
    val left = messageBuilder.faceclawWakeControl(operation, nonce, true)
    right.onSent = onSent
    left.onSent = onSent
    if (priority) {
        pendingMessages.addFirst(left)
        pendingMessages.addFirst(right)
    } else {
        pendingMessages.addLast(right)
        pendingMessages.addLast(left)
    }
    logLine("queue " + right.label + " + L")
    return generation
}

internal fun GlassesSessionCore.waitForFaceclawWakeControlDelivery(generation: Int, timeoutMs: Long): Boolean {
    val deadline = now() + maxOf(0L, timeoutMs)
    monitor.withLock {
        while (running
                && sessionReady
                && faceclawWakeControlGeneration == generation
                && faceclawWakeControlSentCount < 2) {
            val remaining = deadline - now()
            if (remaining <= 0) {
                break
            }
            monitor.awaitMs(minOf(remaining, 100L))
        }
        return faceclawWakeControlGeneration == generation
            && faceclawWakeControlSentCount >= 2
    }
}

/**
 * Acquire/renew or release CFW's independent direct-framebuffer repaint
 * guard on both arms. It is separate from the optional idle-wake lease:
 * every Faceclaw display session needs this guard while its EvenHub layout
 * contains swipe-capturing stock widgets.
 */
internal fun GlassesSessionCore.enqueueFaceclawFramebufferControlLocked(operation: Int, priority: Boolean): Int {
    clearMessagesOfKindLocked("framebuffer-lease-control")
    val generation = ++faceclawFramebufferControlGeneration
    faceclawFramebufferControlSentCount = 0
    if (operation == BleProtocol.FACECLAW_FB_OP_ACQUIRE) {
        lastFaceclawFramebufferLeaseQueuedAtMs = now()
    }
    val onSent = MessageCallback {
        if (faceclawFramebufferControlGeneration == generation) {
            faceclawFramebufferControlSentCount += 1
        }
    }
    val right = messageBuilder.faceclawFramebufferControl(operation, false)
    val left = messageBuilder.faceclawFramebufferControl(operation, true)
    right.onSent = onSent
    left.onSent = onSent
    if (priority) {
        pendingMessages.addFirst(left)
        pendingMessages.addFirst(right)
    } else {
        pendingMessages.addLast(right)
        pendingMessages.addLast(left)
    }
    logLine("queue " + right.label + " + L")
    return generation
}

internal fun GlassesSessionCore.waitForFaceclawFramebufferControlDelivery(generation: Int, timeoutMs: Long): Boolean {
    val deadline = now() + maxOf(0L, timeoutMs)
    monitor.withLock {
        while (running
                && sessionReady
                && faceclawFramebufferControlGeneration == generation
                && faceclawFramebufferControlSentCount < 2) {
            val remaining = deadline - now()
            if (remaining <= 0) {
                break
            }
            monitor.awaitMs(minOf(remaining, 100L))
        }
        return faceclawFramebufferControlGeneration == generation
            && faceclawFramebufferControlSentCount >= 2
    }
}

internal fun GlassesSessionCore.readHeadUpAngleExplicit(expectedSessionGeneration: Long? = null): Int {
    val operation = beginHeadUpAngleOperation(expectedSessionGeneration) ?: return -1
    return try {
        readHeadUpAngleForOperation(operation.first, operation.second)
    } finally {
        finishHeadUpAngleOperation(operation.first)
    }
}

internal fun GlassesSessionCore.setHeadUpAngleExplicit(
    angle: Int,
    expectedSessionGeneration: Long? = null,
): Boolean {
    if (angle !in 0..60) return false
    val operation = beginHeadUpAngleOperation(expectedSessionGeneration) ?: return false
    return try {
        if (!writeHeadUpAngleForOperation(angle, operation.first, operation.second)) return false
        readHeadUpAngleForOperation(operation.first, operation.second) == angle
    } finally {
        finishHeadUpAngleOperation(operation.first)
    }
}

private fun GlassesSessionCore.beginHeadUpAngleOperation(
    expectedSessionGeneration: Long?,
): Pair<Long, Long>? = monitor.withLock {
    if (!running || !sessionReady || !isG2 || headUpOperationActive
            || expectedSessionGeneration != null && expectedSessionGeneration != headUpSessionGeneration) return null
    headUpOperationActive = true
    Pair(++headUpOperationGeneration, headUpSessionGeneration)
}

private fun GlassesSessionCore.finishHeadUpAngleOperation(operation: Long) {
    monitor.withLock {
        if (headUpOperationGeneration != operation) return
        clearMessagesOfKindLocked("head-up-angle-write")
        clearMessagesOfKindLocked("head-up-angle-query")
        headUpOperationActive = false
        monitor.signalAll()
    }
}

private fun GlassesSessionCore.headUpOperationIsCurrent(operation: Long, session: Long): Boolean =
    running && sessionReady && headUpOperationActive &&
        headUpOperationGeneration == operation && headUpSessionGeneration == session

private fun GlassesSessionCore.writeHeadUpAngleForOperation(angle: Int, operation: Long, session: Long): Boolean {
    val done = BooleanArray(2)
    monitor.withLock {
        if (!headUpOperationIsCurrent(operation, session)) return false
        val right = messageBuilder.headUpAngleWrite(angle, false)
        val left = messageBuilder.headUpAngleWrite(angle, true)
        right.onAck = MessageCallback { if (headUpOperationIsCurrent(operation, session)) done[0] = true }
        left.onAck = MessageCallback { if (headUpOperationIsCurrent(operation, session)) done[1] = true }
        right.onTimeout = MessageCallback { if (headUpOperationIsCurrent(operation, session)) done[0] = true }
        left.onTimeout = MessageCallback { if (headUpOperationIsCurrent(operation, session)) done[1] = true }
        pendingMessages.addFirst(left)
        pendingMessages.addFirst(right)
    }
    interruptibleSleep.interrupt()
    return waitForHeadUpAngleOperation(operation, session, done)
}

private fun GlassesSessionCore.readHeadUpAngleForOperation(operation: Long, session: Long): Int {
    val angles = IntArray(2) { Int.MIN_VALUE }
    monitor.withLock {
        if (!headUpOperationIsCurrent(operation, session)) return -1
        val right = messageBuilder.headUpAngleQuery(false)
        val left = messageBuilder.headUpAngleQuery(true)
        right.onAck = MessageCallback {
            if (headUpOperationIsCurrent(operation, session))
                angles[0] = BleProtocol.parseHeadUpAngle(right.ackPayload, right.magic)
        }
        left.onAck = MessageCallback {
            if (headUpOperationIsCurrent(operation, session))
                angles[1] = BleProtocol.parseHeadUpAngle(left.ackPayload, left.magic)
        }
        right.onTimeout = MessageCallback { if (headUpOperationIsCurrent(operation, session)) angles[0] = -1 }
        left.onTimeout = MessageCallback { if (headUpOperationIsCurrent(operation, session)) angles[1] = -1 }
        pendingMessages.addFirst(left)
        pendingMessages.addFirst(right)
    }
    interruptibleSleep.interrupt()
    if (!waitForHeadUpAngleOperation(operation, session, angles, Int.MIN_VALUE)) return -1
    return if (angles[0] >= 0 && angles[0] == angles[1]) angles[0] else -1
}

private fun GlassesSessionCore.waitForHeadUpAngleOperation(
    operation: Long,
    session: Long,
    values: BooleanArray,
): Boolean {
    val deadline = now() + HEAD_UP_ANGLE_WAIT_MS
    monitor.withLock {
        while (headUpOperationIsCurrent(operation, session) && values.any { !it }) {
            val remaining = deadline - now()
            if (remaining <= 0) break
            monitor.awaitMs(minOf(remaining, 100L))
        }
        return headUpOperationIsCurrent(operation, session) && values.all { it }
    }
}

private fun GlassesSessionCore.waitForHeadUpAngleOperation(
    operation: Long,
    session: Long,
    values: IntArray,
    pending: Int,
): Boolean {
    val deadline = now() + HEAD_UP_ANGLE_WAIT_MS
    monitor.withLock {
        while (headUpOperationIsCurrent(operation, session) && values.any { it == pending }) {
            val remaining = deadline - now()
            if (remaining <= 0) break
            monitor.awaitMs(minOf(remaining, 100L))
        }
        return headUpOperationIsCurrent(operation, session) && values.all { it != pending }
    }
}

internal fun GlassesSessionCore.releaseFaceclawFramebufferLease(): Boolean {
    val generation: Int
    monitor.withLock {
        if (!running || !sessionReady) {
            return true
        }
        generation = enqueueFaceclawFramebufferControlLocked(
            BleProtocol.FACECLAW_FB_OP_RELEASE,
            true
        )
    }
    interruptibleSleep.interrupt()
    return waitForFaceclawFramebufferControlDelivery(
        generation,
        FACECLAW_WAKE_CONTROL_WAIT_MS
    )
}

// ---------------------------------------------------------------------------
// Failure handling

/** The address of a configured arm the OS no longer holds a bond for, or null. */
internal fun GlassesSessionCore.firstUnpairedArm(): String? {
    // The iO identifies the phone by its protocol id, not an OS bond.
    if (isIo) return null
    if (!link.isBonded(rightAddress)) return rightAddress
    if (!link.isBonded(leftAddress)) return leftAddress
    return null
}

/**
 * A connect failure while an arm's bond is missing (the pairing was
 * forgotten in the OS settings, or the address was typed in by hand and
 * never paired) will repeat forever, so instead of scheduling a retry,
 * park the worker loop and tell the user to re-pair. Only an explicit
 * connect (which builds a fresh communicator) starts a new attempt.
 */
internal fun GlassesSessionCore.handleUnpairedFailure(address: String) {
    logError("Connect failed and $address is not paired; suspending reconnect")
    ConnectionCounters.increment("g2.unpaired")
    monitor.withLock { haltReconnectLocked("arm not paired: $address") }
    if (!userDisconnectRequested) {
        setStateDisplay(
            "unpaired",
            "The glasses (" + address + ") are not paired with this phone."
                + " Use \"Pair glasses\" to pair them again, then connect."
        )
    }
    interruptibleSleep.interrupt()
}

/**
 * The settings ack reported firmware this app can't run: stock, another
 * project's, or an older Faceclaw revision (see
 * [BleProtocol.FirmwareInfo.isCompatible]). Everything else this session
 * would send is a private-mode message the glasses may misread (stock leaves
 * them unacked until the CFW retry limit drops the link), and a redial would
 * only find the same firmware, so park the worker loop like
 * [handleUnpairedFailure], without any cleanup messages. The firmware info
 * was emitted just before this, so the TS side can explain the mismatch and
 * offer the custom-firmware install.
 */
internal fun GlassesSessionCore.handleIncompatibleFirmware() {
    val info = monitor.withLock {
        val pending = incompatibleFirmware
        incompatibleFirmware = null
        pending
    } ?: return
    ConnectionCounters.increment("g2.incompatible-firmware")
    logError("Glasses report incompatible firmware L=" + info.leftVersion + " R=" + info.rightVersion
        + " ext=\"" + info.extension + "\" (need Faceclaw/" + requiredFirmwareRevision + "); suspending reconnect")
    monitor.withLock { haltReconnectLocked("incompatible firmware") }
    if (!userDisconnectRequested) {
        setStateDisplay(
            "incompatible-firmware",
            "The glasses firmware is not compatible with this version of Faceclaw."
                + " Install the custom firmware, then connect."
        )
    }
    interruptibleSleep.interrupt()
}

/**
 * Park the worker loop for good: drop both arms, discard queued traffic and
 * stop redialing. Only an explicit connect (start() on a fresh communicator)
 * tries again.
 */
internal fun GlassesSessionCore.haltReconnectLocked(reason: String) {
    reconnectHalted = true
    sessionReady = false
    headUpSessionGeneration++
    fixedLayoutCreated = false
    startupProbePending = false
    shutdownRequested = false
    chargingMode = false
    imageRetryAfterMs = 0
    displayedFingerprint = ""
    faceclawWakePendingNonce = -1
    lastFaceclawWakeLeaseQueuedAtMs = 0
    faceclawWakeControlSentCount = 0
    clearAllMessagesLocked(reason)
    reconnectAfterMs = Long.MAX_VALUE
    link.disconnect(rightAddress)
    link.disconnect(leftAddress)
}

/**
 * Tear the session down and schedule a reconnect. [displayStatus], when given, replaces the
 * generic "Reconnecting after <reason>" status line.
 */
internal fun GlassesSessionCore.handleTransportFailure(reason: String?, displayStatus: String? = null) {
    logError("Transport failure: $reason")
    ConnectionCounters.increment("g2.failure." + ConnectionCounters.slug(reason ?: "unknown"))
    val retryDelayMs: Long
    monitor.withLock {
        maybeEmitEvenAppConflictLocked(reason)
        finishBenchmarkLocked(true, "transport failure")
        val sessionWasReady = sessionReady
        if (sessionWasReady) countSessionEnded("failure")
        sessionReady = false
        headUpSessionGeneration++
        fixedLayoutCreated = false
        startupProbePending = false
        shutdownRequested = false
        chargingMode = false
        imageRetryAfterMs = 0
        displayedFingerprint = ""
        faceclawWakePendingNonce = -1
        lastFaceclawWakeLeaseQueuedAtMs = 0
        faceclawWakeControlSentCount = 0
        clearAllMessagesLocked("transport failure: $reason")
        retryDelayMs = scheduleReconnectLocked(sessionWasReady)
        link.disconnect(rightAddress)
        link.disconnect(leftAddress)
    }
    logLine("reconnect attempt in " + retryDelayMs + "ms")
    if (!userDisconnectRequested) {
        setStateDisplay("retrying", when {
            displayStatus != null -> displayStatus + " Retrying in " + ((retryDelayMs + 999) / 1000) + "s."
            reason == null || reason.isEmpty() -> "Reconnecting..."
            else -> "Reconnecting after $reason"
        })
    }
    interruptibleSleep.interrupt()
}

/**
 * Counts a ready session ending, by [cause] and by how long it had been up
 * (for the analytics in app/analytics/).
 */
internal fun GlassesSessionCore.countSessionEnded(cause: String) {
    ConnectionCounters.increment("g2.session-end.$cause")
    val minutes = (now() - lastSessionReadyAtMs) / 60_000
    ConnectionCounters.increment(
        "g2.session-length." + when {
            minutes < 1 -> "under-1m"
            minutes < 10 -> "1m-10m"
            minutes < 60 -> "10m-1h"
            else -> "over-1h"
        }
    )
}

/**
 * Set [reconnectAfterMs] for the next attempt after a failure and return the delay. Repeated
 * failures back off along RECONNECT_BACKOFF_MS; a session that stayed up for
 * STABLE_SESSION_MS before failing ([sessionWasReady]) starts the schedule over.
 */
internal fun GlassesSessionCore.scheduleReconnectLocked(sessionWasReady: Boolean): Long {
    val now = now()
    if (sessionWasReady && now - lastSessionReadyAtMs >= ConnectionOptions.STABLE_SESSION_MS) {
        consecutiveReconnects = 0
    }
    val schedule = if (isG1) G1Timings.RECONNECT_BACKOFF_MS else ConnectionOptions.RECONNECT_BACKOFF_MS
    val delayMs = schedule[minOf(consecutiveReconnects, schedule.size - 1)].toLong()
    consecutiveReconnects++
    reconnectAfterMs = now + delayMs
    return delayMs
}

internal fun GlassesSessionCore.resetSessionStateLocked() {
    ringBattery = -1
    ringCharging = -1
    directRingBattery = -1
    directRingCharging = -1
    sessionReady = false
    shutdownRequested = false
    fixedLayoutCreated = false
    chargingMode = false
    rightConnected = false
    leftConnected = false
    ringConnected = false
    ringNotificationsReady = false
    reconnectAfterMs = 0
    consecutiveReconnects = 0
    reconnectHalted = false
    incompatibleFirmware = null
    ringReconnectAfterMs = 0
    lastAckAtMs = 0
    lastIncomingAtMs = 0
    lastHeartbeatSentAtMs = 0
    lastSessionReadyAtMs = 0
    consecutiveAckTimeouts = 0
    lastAudioControlAckMagic = 0
    audioCaptureActive = false
    audioPacketListener = null
    compassControlLastSent = -1
    // A dead transport orphans any glasses-side compass state; the fresh
    // session re-asserts the desired state once its layout is ready.
    compassMaybeOn = false
    faceclawWakePendingNonce = -1
    lastFaceclawWakeLeaseQueuedAtMs = 0
    faceclawWakeControlSentCount = 0
    cfwCleanupDelivered = false
    for (transport in cfwTransports) transport.reset()
    lastCfwCleanupAckMagic = 0
    wearState = -1
    displayedFingerprint = ""
    // Deliberately not clearing silentMode: it is a property of the glasses,
    // not of our session, and silent mode blocks app launches, so it can be
    // the very cause of the session teardown that got us here.
}

// ---------------------------------------------------------------------------
// Listener emits (main thread via the host)

internal fun GlassesSessionCore.emitAmbientLight(body: ByteArray) {
    if (ambientLightListeners.isEmpty()) {
        return
    }
    val copy = body.copyOf()
    host.postToMain {
        for (alsListener in ambientLightListeners) {
            try {
                alsListener.onAmbientLight(copy)
            } catch (t: Throwable) {
                logWarn("ambient light listener failed", t)
            }
        }
    }
}

internal fun GlassesSessionCore.emitMicStatus(body: ByteArray, address: String) {
    if (micStatusListeners.isEmpty()) {
        return
    }
    val arm = if (address.equals(leftAddress, ignoreCase = true)) "L"
        else if (address.equals(rightAddress, ignoreCase = true)) "R" else "?"
    val copy = body.copyOf()
    host.postToMain {
        for (micListener in micStatusListeners) {
            try {
                micListener.onMicStatus(copy, arm)
            } catch (t: Throwable) {
                logWarn("mic status listener failed", t)
            }
        }
    }
}

internal fun GlassesSessionCore.emitAudioMonitorPacket(data: ByteArray, arm: String, arrivalMs: Long) {
    if (audioMonitorListeners.isEmpty()) {
        return
    }
    val copy = data.copyOf()
    host.postToMain {
        for (monitorListener in audioMonitorListeners) {
            try {
                monitorListener.onAudioPacket(copy, arm, arrivalMs)
            } catch (t: Throwable) {
                logWarn("audio monitor listener failed", t)
            }
        }
    }
}

internal fun GlassesSessionCore.emitRingEvent(event: G2Event, frameId: Int) {
    val current = listener
    if (current == null) {
        frameTimings.finishFrame(frameId, "discarded: no listener attached")
        return
    }
    val containerNameSnapshot = event.containerName
    host.postToMain {
        frameTimings.log(frameId, "dispatching input event on main thread")
        try {
            current.onRingEvent(event.kind, containerNameSnapshot, event.eventType, event.eventSource, event.systemExitReasonCode, frameId,
                    event.ringTick, event.ringType, event.ringAux, event.ringSpeed)
        } catch (t: Throwable) {
            logWarn("listener onRingEvent failed", t)
            frameTimings.finishFrame(frameId, "discarded: listener onRingEvent failed")
        }
    }
}

/** Finish a frame owned by the communicator and tell the TS side, which may be awaiting it. */
internal fun GlassesSessionCore.finishFrame(frameId: Int, outcome: String) {
    if (frameId <= 0) {
        return
    }
    frameTimings.finishFrame(frameId, outcome)
    val current = listener ?: return
    host.postToMain {
        try {
            current.onFrameFinished(frameId, outcome)
        } catch (t: Throwable) {
            logWarn("listener onFrameFinished failed", t)
        }
    }
}

internal fun GlassesSessionCore.emitRingHealthPullFinished(completed: Boolean, pages: Int, watermark: Long) {
    val current = listener ?: return
    host.postToMain {
        try {
            current.onRingHealthPullFinished(completed, pages, watermark)
        } catch (t: Throwable) {
            logWarn("listener onRingHealthPullFinished failed", t)
        }
    }
}

internal fun GlassesSessionCore.emitBackgroundRingHealthFinished(
    generation: Long,
    outcome: String,
    pages: Int,
    watermark: Long,
) {
    val current = listener ?: return
    host.postToMain {
        try {
            current.onBackgroundRingHealthFinished(generation, outcome, pages, watermark)
        } catch (t: Throwable) {
            logWarn("listener onBackgroundRingHealthFinished failed", t)
        }
    }
}

internal fun GlassesSessionCore.emitSessionRestored(restoredPeers: Int) {
    val current = listener ?: return
    host.postToMain {
        try {
            current.onSessionRestored(restoredPeers)
        } catch (t: Throwable) {
            logWarn("listener onSessionRestored failed", t)
        }
    }
}

internal fun GlassesSessionCore.emitGlassesRingConnectionState(connected: Boolean, ringId: String) {
    val current = listener ?: return
    host.postToMain {
        try {
            current.onGlassesRingConnectionState(connected, ringId)
        } catch (t: Throwable) {
            logWarn("listener onGlassesRingConnectionState failed", t)
        }
    }
}

internal fun GlassesSessionCore.emitPhoneRingReady() {
    val current = listener ?: return
    host.postToMain {
        try {
            current.onPhoneRingReady()
        } catch (t: Throwable) {
            logWarn("listener onPhoneRingReady failed", t)
        }
    }
}

internal fun GlassesSessionCore.emitImuData(x: Double, y: Double, z: Double, eventSource: Int) {
    if (imuListeners.isEmpty()) {
        return
    }
    host.postToMain {
        for (imuListener in imuListeners) {
            try {
                imuListener.onImuData(x, y, z, eventSource)
            } catch (t: Throwable) {
                logWarn("listener onImuData failed", t)
            }
        }
    }
}

internal fun GlassesSessionCore.emitCompassEvent(event: BleProtocol.CompassEvent) {
    if (event.diagnosticFlags >= 0) {
        val sources = arrayOf("unknown", "GRV", "GMRV", "RV")
        host.log(SessionLogLevel.INFO, "FaceclawCompass", "heading=" + event.headingDegrees
            + " magneticAccuracy=" + event.magneticAccuracy
            + " magneticAnomalies=" + event.magneticAnomalies
            + " orientationSource=" + sources[event.orientationSource]
            + " flags=0x" + event.diagnosticFlags.toString(16)
            + " sampleTimeMs=" + event.sampleTimeMs, null)
    }
    for (subscription in compassSubscriptions) {
        subscription.dispatcher.post {
            try {
                subscription.listener.onCompassEvent(event.command, event.headingDegrees,
                    event.magneticAccuracy, event.magneticAnomalies, event.orientationSource,
                    event.diagnosticFlags, event.sampleTimeMs)
            } catch (t: Throwable) {
                logWarn("listener onCompassEvent failed", t)
            }
        }
    }
}

internal fun GlassesSessionCore.emitSilentMode(silent: Boolean) {
    val current = listener ?: return
    host.postToMain {
        try {
            current.onSilentMode(silent)
        } catch (t: Throwable) {
            logWarn("listener onSilentMode failed", t)
        }
    }
}

internal fun GlassesSessionCore.emitWearState(wearing: Boolean) {
    val current = listener ?: return
    host.postToMain {
        try {
            current.onWearState(wearing)
        } catch (t: Throwable) {
            logWarn("listener onWearState failed", t)
        }
    }
}

internal fun GlassesSessionCore.emitPhoneLockStateIfChanged(force: Boolean) {
    val locked: Boolean
    monitor.withLock {
        val now = now()
        if (!force && now - lastPhoneLockCheckAtMs < 1_000) return
        lastPhoneLockCheckAtMs = now
        locked = host.isPhoneLocked()
        val value = if (locked) 1 else 0
        if (!force && value == phoneLockState) return
        phoneLockState = value
    }
    val current = listener ?: return
    host.postToMain {
        try {
            current.onPhoneLockState(locked)
        } catch (t: Throwable) {
            logWarn("listener onPhoneLockState failed", t)
        }
    }
}

internal fun GlassesSessionCore.emitBatteryState(headsetBattery: Int, headsetCharging: Int) {
    // A missing glasses-side report must not erase a verified direct
    // reading. Fall back to the glasses cache when the direct link drops.
    val useDirect = ringConnected && directRingBattery >= 0
    val reportedRingBattery = if (useDirect) directRingBattery else ringBattery
    val reportedRingCharging = if (useDirect) directRingCharging else ringCharging
    val current = listener ?: return
    host.postToMain {
        try {
            current.onBatteryState(headsetBattery, headsetCharging, reportedRingBattery, reportedRingCharging)
        } catch (t: Throwable) {
            logWarn("listener onBatteryState failed", t)
        }
    }
}

/**
 * Report a charging-case reading when it differs from the last one. Docked, a reading counts
 * only once it carries a level (docking pushes {inCaseStatus=1} first and the level about 0.7 s
 * later). Undocked -- the empty reply to a read, or an undock push -- it is reported even without
 * a level, so the listener learns the case's charge state is no longer known.
 */
internal fun GlassesSessionCore.updateCaseInfoLocked(info: BleProtocol.CaseInfoSnapshot) {
    if (info.errorCode != 0) {
        return
    }
    val docked = info.isDocked()
    if (docked && !info.hasLevel()) {
        return
    }
    val level = if (info.hasLevel()) info.soc else -1
    // Out of the case the glasses can't see the case's USB state.
    val charging = if (docked && info.isCaseCharging()) 1 else 0
    val dockedState = if (docked) 1 else 0
    if (level == caseBattery && charging == caseCharging && dockedState == caseDocked) {
        return
    }
    val wasOutOfCase = caseDocked == 0
    caseBattery = level
    caseCharging = charging
    caseDocked = dockedState
    logLine("charging case: $info")
    if (docked && wasOutOfCase && !chargingMode) {
        // The glasses just went into the case. Only the battery reply says
        // they are charging, and the regular poll is minutes away (and skipped
        // altogether while the display is suspended, as it is once they come
        // off the face), so read it shortly: charging mode then follows.
        dockedBatteryCheckAtMs = now() + ConnectionOptions.DOCKED_BATTERY_CHECK_DELAY_MS
        logLine("glasses docked; battery check scheduled")
    }
    val current = listener ?: return
    host.postToMain {
        try {
            current.onCaseState(level, charging, docked)
        } catch (t: Throwable) {
            logWarn("listener onCaseState failed", t)
        }
    }
}

internal fun GlassesSessionCore.emitFirmwareInfo(info: BleProtocol.FirmwareInfo) {
    val current = listener ?: return
    host.postToMain {
        try {
            current.onFirmwareInfo(info.leftVersion, info.rightVersion, info.extension)
        } catch (t: Throwable) {
            logWarn("listener onFirmwareInfo failed", t)
        }
    }
}

internal fun GlassesSessionCore.emitFrameMetrics(paintMs: Int, transmitMs: Int, tileCount: Int) {
    val current = listener ?: return
    host.postToMain {
        try {
            current.onFrameMetrics(paintMs, transmitMs, tileCount)
        } catch (t: Throwable) {
            logWarn("listener onFrameMetrics failed", t)
        }
    }
}

internal fun GlassesSessionCore.maybeEmitEvenAppConflictLocked(reason: String?) {
    if ("write failed" != reason) {
        return
    }
    val now = now()
    if (lastSessionReadyAtMs <= 0 || now - lastSessionReadyAtMs > ConnectionOptions.EVEN_APP_WRITE_FAILURE_WINDOW_MS) {
        return
    }
    if (lastEvenAppConflictAtMs > 0 && now - lastEvenAppConflictAtMs < 60_000) {
        return
    }
    if (!host.isEvenAppActive()) {
        return
    }
    lastEvenAppConflictAtMs = now
    ConnectionCounters.increment("g2.even-app-conflict")
    emitEvenAppConflict("The Even Realities app still appears to be running. It can hold the glasses BLE link and cause Faceclaw write failures. Open its app settings and force stop it, then reconnect Faceclaw.")
}

internal fun GlassesSessionCore.emitEvenAppConflict(message: String?) {
    val current = listener ?: return
    val messageSnapshot = message ?: ""
    host.postToMain {
        try {
            current.onEvenAppConflict(messageSnapshot)
        } catch (t: Throwable) {
            logWarn("listener onEvenAppConflict failed", t)
        }
    }
}

internal fun GlassesSessionCore.setStateDisplay(nextPhase: String, nextStatus: String) {
    monitor.withLock {
        phase = nextPhase
        status = nextStatus
    }
    emitState()
}

internal fun GlassesSessionCore.emitState() {
    val current = listener ?: return
    val phaseSnapshot: String
    val statusSnapshot: String
    monitor.withLock {
        phaseSnapshot = phase
        statusSnapshot = status
    }
    host.postToMain {
        try {
            current.onStateChange(phaseSnapshot, statusSnapshot)
        } catch (t: Throwable) {
            logWarn("listener onStateChange failed", t)
        }
    }
}
