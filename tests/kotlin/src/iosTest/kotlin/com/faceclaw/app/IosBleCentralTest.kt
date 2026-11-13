@file:OptIn(kotlinx.cinterop.ExperimentalForeignApi::class)

package com.faceclaw.app

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlinx.cinterop.ByteVar
import kotlinx.cinterop.alloc
import kotlinx.cinterop.memScoped
import kotlinx.cinterop.ptr
import platform.Foundation.NSDate
import platform.Foundation.NSDefaultRunLoopMode
import platform.Foundation.NSFileManager
import platform.Foundation.NSFileProtectionCompleteUntilFirstUserAuthentication
import platform.Foundation.NSFileProtectionKey
import platform.Foundation.NSRecursiveLock
import platform.Foundation.NSRunLoop
import platform.Foundation.NSThread
import platform.Foundation.NSTemporaryDirectory
import platform.Foundation.NSUUID
import platform.Foundation.NSUserDefaults
import platform.Foundation.dateWithTimeIntervalSinceNow
import platform.Foundation.runMode
import platform.darwin.dispatch_async
import platform.darwin.dispatch_get_specific
import platform.darwin.dispatch_queue_set_specific
import platform.darwin.dispatch_sync
import platform.posix.S_IFMT
import platform.posix.S_IFREG
import platform.posix.stat

class IosBleCentralTest {
    @Test
    fun restorationPolicyAdoptsAllowlistedArmsResetsRingRoleAndCancelsUnknownPeers() {
        val allowed = setOf("RIGHT", "LEFT", "RING")
        assertEquals(IosRestoreAction.ADOPT, iosRestoreAction("right", allowed, "RING", true, true))
        assertEquals(IosRestoreAction.RESET_RING, iosRestoreAction("ring", allowed, "RING", true, true))
        assertEquals(IosRestoreAction.CANCEL, iosRestoreAction("unknown", allowed, "RING", true, true))
        assertEquals(IosRestoreAction.CANCEL, iosRestoreAction("RIGHT", allowed, "RING", false, true))
        assertEquals(IosRestoreAction.CANCEL, iosRestoreAction("RIGHT", allowed, "RING", true, false))

        val intent = IosConnectIntent()
        intent.restore(connected = true)
        assertTrue(intent.connected)
        assertFalse(intent.pending)
        assertEquals(IosConnectAction.ACTIVE, intent.begin(closed = false, background = false))
        assertTrue(intent.failed(), "a restored live arm must report its later disconnect")
        intent.restore(connected = false)
        assertFalse(intent.connected)
        assertTrue(intent.pending)
    }

    @Test
    fun persistedExplicitStopKeepsRestorationOffAcrossConfiguration() {
        val central = IosBleCentral()
        val defaults = NSUserDefaults.standardUserDefaults
        val originalPresent = defaults.objectForKey(IOS_CONNECTION_WANTED_KEY) != null
        val original = defaults.boolForKey(IOS_CONNECTION_WANTED_KEY)
        try {
            central.setConnectionWanted(false)
            central.configureStateRestoration(true, setOf("RIGHT"), "RING")
            assertFalse(central.connectionWantedForTest())
            assertFalse(central.restorationConnectionWantedForTest())
            assertFalse(central.restorationActiveForTest())
            assertEquals(0, central.centralCreationCount)
        } finally {
            if (originalPresent) central.setConnectionWanted(original)
            else defaults.removeObjectForKey(IOS_CONNECTION_WANTED_KEY)
            central.close()
        }
    }

    @Test
    fun absentConnectionIntentDoesNotAuthorizeStateRestoration() {
        val central = IosBleCentral()
        val defaults = NSUserDefaults.standardUserDefaults
        val originalPresent = defaults.objectForKey(IOS_CONNECTION_WANTED_KEY) != null
        val original = defaults.boolForKey(IOS_CONNECTION_WANTED_KEY)
        try {
            defaults.removeObjectForKey(IOS_CONNECTION_WANTED_KEY)

            central.configureStateRestoration(true, setOf("RIGHT"), "RING")

            assertTrue(central.connectionWantedForTest(), "ordinary legacy startup retains its migration default")
            assertFalse(central.restorationConnectionWantedForTest(), "restoration requires positive persisted intent")
            assertFalse(central.restorationActiveForTest())
            assertEquals(0, central.centralCreationCount)
        } finally {
            if (originalPresent) central.setConnectionWanted(original)
            else defaults.removeObjectForKey(IOS_CONNECTION_WANTED_KEY)
            central.close()
        }
    }

    @Test
    fun concurrentSessionStartupCreatesOneCentral() {
        val central = IosBleCentral()
        val release = Latch(1, IosProtocolPlatform)
        val done = Latch(2, IosProtocolPlatform)
        val listener = object : IosBleScanListener {
            override fun onBluetoothState(state: Int, authorization: Int) {}
            override fun onAdvertisement(identifier: String, name: String, manufacturerDataHex: String,
                rssi: Int, connectable: Boolean) {}
        }
        try {
            repeat(2) {
                startThread("restore-start-$it", true) {
                    release.await(2_000)
                    central.setScanListener(listener)
                    done.countDown()
                }
            }
            release.countDown()
            assertTrue(done.await(5_000))
            assertEquals(1, central.centralCreationCount)
        } finally {
            central.close()
        }
    }

    @Test
    fun bleEventJournalKeepsTheNewestPrivateRowsAcrossReopen() = memScoped {
        val folder = NSTemporaryDirectory() + "/faceclaw-ble-events-" + NSUUID().UUIDString
        try {
            val journal = IosBleEventJournal(folder)
            repeat(205) { journal.record("request", background = true, code = it.toLong()) }
            val rows = journal.snapshot()

            assertEquals(200, rows.size)
            assertTrue(rows.first().contains("\"code\":5}"))
            assertTrue(rows.last().contains("\"code\":204}"))
            assertFalse(rows.any { "address" in it || "payload" in it || "error" in it })
            assertEquals(rows, IosBleEventJournal(folder).snapshot())

            val info = alloc<stat>()
            assertEquals(0, stat("$folder/ble-events.jsonl", info.ptr))
            assertEquals(S_IFREG, info.st_mode.toInt() and S_IFMT)
            assertEquals(384, info.st_mode.toInt() and 511, "journal must be mode 0600")
            val attributes = NSFileManager.defaultManager.attributesOfItemAtPath("$folder/ble-events.jsonl", null)
            // The simulator does not expose NSFileProtectionKey for its host filesystem.
            (attributes?.get(NSFileProtectionKey) as? String)?.let { protection ->
                assertEquals(NSFileProtectionCompleteUntilFirstUserAuthentication, protection)
            }
            assertEquals(0, stat(folder, info.ptr))
            assertEquals(448, info.st_mode.toInt() and 511, "folder must be mode 0700")
        } finally {
            NSFileManager.defaultManager.removeItemAtPath(folder, null)
        }
    }

    @Test
    fun bleEventJournalRejectsUnknownFieldsAndContainsWriteFailure() {
        val journal = IosBleEventJournal("/dev/null/faceclaw-ble-events")

        journal.record("not-an-event", background = true, code = 1)
        journal.record("failed", background = true, code = 2)

        assertTrue(journal.snapshot().isEmpty(), "journal failure must stay inside the diagnostics path")
    }

    @Test
    fun backgroundConnectIntentIsIdempotentUntilTheAttemptFinishes() {
        val intent = IosConnectIntent()

        assertEquals(IosConnectAction.START, intent.begin(closed = false, background = true))
        assertEquals(IosConnectAction.ACTIVE, intent.begin(closed = false, background = true))
        assertTrue(intent.pending)
        assertTrue(intent.background)
        assertFalse(intent.connected)

        assertFalse(intent.failed(), "an unreported pending failure must not emit a disconnect")
        assertEquals(IosConnectAction.START, intent.begin(closed = false, background = true))
    }

    @Test
    fun blockingConnectCanJoinAnExistingBackgroundAttempt() {
        val intent = IosConnectIntent()

        assertEquals(IosConnectAction.START, intent.begin(closed = false, background = true))
        assertEquals(IosConnectAction.ACTIVE, intent.begin(closed = false, background = false))
        assertTrue(intent.acceptConnected(closed = false))
        assertTrue(intent.connected)
        assertFalse(intent.pending)
        assertEquals(IosConnectAction.ACTIVE, intent.begin(closed = false, background = false))
    }

    @Test
    fun withdrawnOrClosedIntentRejectsALateConnection() {
        val intent = IosConnectIntent()

        assertEquals(IosConnectAction.START, intent.begin(closed = false, background = true))
        intent.withdraw()
        assertFalse(intent.acceptConnected(closed = false))
        assertFalse(intent.connected)
        assertEquals(IosConnectAction.REJECTED, intent.begin(closed = true, background = true))

        assertEquals(IosConnectAction.START, intent.begin(closed = false, background = true))
        assertFalse(intent.acceptConnected(closed = true))
        assertFalse(intent.connected)
    }

    @Test
    fun cancellationBlocksAReplacementAttemptUntilTheNativeCallback() {
        val intent = IosConnectIntent()

        assertEquals(IosConnectAction.START, intent.begin(closed = false, background = true))
        assertEquals(IosCancelAction.START, intent.beginCancel())
        assertFalse(intent.withdrawPending(), "failed request submission must not clear a concurrent cancellation barrier")
        assertEquals(IosCancelAction.ACTIVE, intent.beginCancel(), "a repeated disconnect must retain the native cancellation barrier")
        assertEquals(IosConnectAction.REJECTED, intent.begin(closed = false, background = true))
        assertFalse(intent.acceptConnected(closed = false), "late didConnect must not revive cancelled intent")

        intent.failed()
        assertEquals(IosConnectAction.START, intent.begin(closed = false, background = true))
    }

    @Test
    fun restoredCancellationWaitsForPoweredOnAndSubmitsExactlyOnce() {
        val intent = IosConnectIntent()
        intent.restore(connected = true)
        assertEquals(IosCancelAction.START, intent.beginCancel())

        assertFalse(intent.reserveCancellationSubmission(
            managerPoweredOn = false,
            osDisconnected = false,
            samePeer = true,
            sameEpoch = true,
        ))
        assertFalse(intent.cancellationSubmitted)
        assertTrue(intent.reserveCancellationSubmission(
            managerPoweredOn = true,
            osDisconnected = false,
            samePeer = true,
            sameEpoch = true,
        ))
        assertTrue(intent.cancellationSubmitted)
        assertFalse(intent.reserveCancellationSubmission(true, false, true, true))
        assertTrue(intent.cancelling, "submission must not settle a still-connected peripheral")

        assertTrue(intent.reconcileCancellation(osDisconnected = true, samePeer = true, sameEpoch = true))
        assertFalse(intent.cancelling)
        assertFalse(intent.cancellationSubmitted)
    }

    @Test
    fun activeUnsubmittedCancellationCanSubmitAfterPowerReturnsButNotAfterIntentChanges() {
        val intent = IosConnectIntent()
        intent.restore(connected = true)
        assertEquals(IosCancelAction.START, intent.beginCancel())
        assertEquals(IosCancelAction.ACTIVE, intent.beginCancel())

        assertTrue(intent.reserveCancellationSubmission(true, false, true, true))
        intent.failed()
        intent.restore(connected = true)
        assertEquals(IosCancelAction.START, intent.beginCancel())

        assertFalse(intent.reserveCancellationSubmission(true, false, true, false),
            "an observation from the prior cancellation epoch mutated the current intent")
        assertFalse(intent.reserveCancellationSubmission(true, false, false, true),
            "a different restored peripheral mutated the stored peer intent")
        assertFalse(intent.cancellationSubmitted)
        assertTrue(intent.reserveCancellationSubmission(true, false, true, true))
    }

    @Test
    fun authoritativeDisconnectedStateSettlesCancellationWithoutADelegateCallback() {
        val intent = IosConnectIntent()
        assertEquals(IosConnectAction.START, intent.begin(closed = false, background = true))
        assertEquals(IosCancelAction.START, intent.beginCancel())

        assertTrue(intent.reconcileCancellation(osDisconnected = true, samePeer = true, sameEpoch = true))
        assertFalse(intent.cancelling)
        assertEquals(IosConnectAction.START, intent.begin(closed = false, background = true))
    }

    @Test
    fun nonDisconnectedPeripheralRemainsACancellationBarrier() {
        val intent = IosConnectIntent()
        assertEquals(IosConnectAction.START, intent.begin(closed = false, background = true))
        assertEquals(IosCancelAction.START, intent.beginCancel())

        assertFalse(intent.reconcileCancellation(osDisconnected = false, samePeer = true, sameEpoch = true))
        assertTrue(intent.cancelling)
        assertEquals(IosConnectAction.REJECTED, intent.begin(closed = false, background = true))
    }

    @Test
    fun changedCancellationEpochCannotSettleAnOlderCancellationObservation() {
        val intent = IosConnectIntent()
        assertEquals(IosConnectAction.START, intent.begin(closed = false, background = true))
        assertEquals(IosCancelAction.START, intent.beginCancel())

        assertFalse(intent.reconcileCancellation(osDisconnected = true, samePeer = true, sameEpoch = false))
        assertTrue(intent.cancelling)
    }

    @Test
    fun disconnectedCallbackForTheSameIdentifierCannotLeaveADeadLinkReadyBecauseItsWrapperDiffers() {
        val intent = IosConnectIntent()
        intent.begin(closed = false, background = true)
        intent.acceptConnected(closed = false)

        // Both CoreBluetooth objects report Disconnected for the configured UUID,
        // but the callback is not the same Kotlin wrapper as the stored peripheral.
        if (iosDisconnectCallbackApplies(callbackDisconnected = true, storedDisconnected = true,
                samePeer = true, sameEpoch = true)) intent.failed()

        assertFalse(intent.connected, "a disconnected peripheral stayed ready behind a wrapper identity check")
    }

    @Test
    fun lateDisconnectCallbackCannotFailAReplacementConnection() {
        assertFalse(iosDisconnectCallbackApplies(false, true, true, true))
        assertFalse(iosDisconnectCallbackApplies(true, false, true, true), "current connected/connecting peer must survive")
        assertFalse(iosDisconnectCallbackApplies(true, true, false, true))
        assertFalse(iosDisconnectCallbackApplies(true, true, true, false))
        assertTrue(iosDisconnectCallbackApplies(true, true, true, true))
    }

    @Test
    fun disconnectBeforeForegroundOrBackgroundConnectSubmissionCannotConsumeTheNewIntent() {
        for (background in listOf(false, true)) {
            val intent = IosConnectIntent()
            intent.begin(closed = false, background = background)
            assertFalse(iosDisconnectCallbackApplies(true, true, true, true,
                connectionPendingWithoutSubmission = intent.pending && !intent.connectionSubmitted))
            assertTrue(intent.pending)

            assertTrue(intent.markConnectionSubmitted())
            assertTrue(iosDisconnectCallbackApplies(true, true, true, true,
                connectionPendingWithoutSubmission = intent.pending && !intent.connectionSubmitted))
            intent.failed()
            assertFalse(intent.active)
        }
    }

    @Test
    fun restoredPendingConnectionsAndCancellationCanAcceptRealDisconnectCompletion() {
        val restored = IosConnectIntent()
        restored.restore(connected = false)
        assertTrue(restored.connectionSubmitted)
        assertTrue(iosDisconnectCallbackApplies(true, true, true, true,
            connectionPendingWithoutSubmission = restored.pending && !restored.connectionSubmitted))

        val cancelling = IosConnectIntent()
        cancelling.begin(closed = false, background = true)
        cancelling.beginCancel()
        assertFalse(cancelling.markConnectionSubmitted(), "cancelled connect must never be submitted")
        assertTrue(iosDisconnectCallbackApplies(true, true, true, true,
            connectionPendingWithoutSubmission = cancelling.pending && !cancelling.connectionSubmitted))
        cancelling.failed()
        assertFalse(cancelling.active)
    }

    @Test
    fun restoredRingCancellationSettlesBeforeReplacementConnectWithinItsDeadline() {
        val intent = IosConnectIntent()
        intent.restore(connected = true)
        assertEquals(IosCancelAction.START, intent.beginCancel())
        var awaited = 0

        assertTrue(awaitIosCancellation(
            intent,
            deadlineMs = 100,
            nowMs = { 0 },
            attemptCurrent = { true },
            awaitMs = {
                awaited++
                intent.failed()
            },
        ))
        assertEquals(1, awaited)
        assertEquals(IosConnectAction.START, intent.begin(closed = false, background = true))

        intent.beginCancel()
        assertFalse(awaitIosCancellation(intent, 100, { 0 }, { false }, {}),
            "explicit cancellation epoch must reject replacement connect")
    }

    @Test
    fun notificationDisableRequiresConfirmationAndMatchingState() {
        assertFalse(iosNotificationChangeConfirmed(false, true, false, true), "failed disable on connected ring")
        assertFalse(iosNotificationChangeConfirmed(false, false, null, true), "timeout is not confirmation")
        assertFalse(iosNotificationChangeConfirmed(false, true, true, true), "callback still says notifying")
        assertFalse(iosNotificationChangeConfirmed(false, false, true, false), "disconnect is not confirmation")
        assertTrue(iosNotificationChangeConfirmed(false, false, true, true))
        assertTrue(iosNotificationChangeConfirmed(true, true, true, true))
        assertFalse(iosNotificationChangeConfirmed(true, false, true, true))
    }

    @Test
    fun notificationAndAuthorizationCallbacksPreserveOrderAndAllowSynchronousBleCalls() {
        val central = IosBleCentral()
        val done = Latch(1, IosProtocolPlatform)
        val events = ArrayList<String>()
        central.setSessionListener(object : FaceclawBleListener {
            override fun onNotification(address: String?, characteristicUuid: String?, data: ByteArray?) {
                central.stopScan()
                events.add("notification:$address:$characteristicUuid:${data?.get(0)}")
            }
            override fun onConnectionStateChange(address: String?, connected: Boolean) {
                events.add("connected:$connected")
            }
        })
        central.setAncsAuthorizationListener(IosAncsAuthorizationListener { _, authorized ->
            central.stopScan()
            events.add("ancs:$authorized")
            done.countDown()
        })
        dispatch_sync(central.queue) {
            central.emitConnectionState("test", true)
            central.emitNotification("test", "value", byteArrayOf(42))
            central.emitAncsAuthorization("test", true)
        }
        assertTrue(done.await(2_000))
        central.close()
        assertEquals(listOf("connected:true", "notification:test:value:42", "ancs:true"), events)
    }

    @Test
    fun queuedEventsDoNotReachAReplacementListener() {
        val central = IosBleCentral()
        val started = Latch(1, IosProtocolPlatform)
        val release = Latch(1, IosProtocolPlatform)
        val finished = Latch(1, IosProtocolPlatform)
        var calls = 0
        val listener = object : FaceclawBleListener {
            override fun onNotification(address: String?, characteristicUuid: String?, data: ByteArray?) { calls++ }
            override fun onConnectionStateChange(address: String?, connected: Boolean) {
                started.countDown()
                release.await(2_000)
            }
        }
        central.setSessionListener(listener)
        central.emitConnectionState("test", true)
        assertTrue(started.await(2_000))
        central.emitNotification("test", "value", byteArrayOf(1))
        central.setSessionListener(object : FaceclawBleListener {
            override fun onNotification(address: String?, characteristicUuid: String?, data: ByteArray?) { calls++ }
            override fun onConnectionStateChange(address: String?, connected: Boolean) {}
        })
        // ANCS is an ordered barrier after the stale notification.
        central.setAncsAuthorizationListener(IosAncsAuthorizationListener { _, _ -> finished.countDown() })
        central.emitAncsAuthorization("test", true)
        release.countDown()
        assertTrue(finished.await(2_000))
        assertEquals(0, calls)
        central.close()
    }

    @Test
    fun connectionCallbackCanSynchronouslyCloseWithoutOwningBleQueue() = memScoped {
        val central = IosBleCentral()
        val key = alloc<ByteVar>().ptr
        dispatch_queue_set_specific(central.queue, key, key, null)
        val done = Latch(1, IosProtocolPlatform)
        var onBleQueue = true
        central.setSessionListener(object : FaceclawBleListener {
            override fun onNotification(address: String?, characteristicUuid: String?, data: ByteArray?) {}
            override fun onConnectionStateChange(address: String?, connected: Boolean) {
                onBleQueue = dispatch_get_specific(key) == key
                // Avoid deliberately crashing the test executable on the old implementation.
                if (!onBleQueue) central.close()
                done.countDown()
            }
        })
        dispatch_sync(central.queue) { central.emitConnectionState("test", false) }
        assertTrue(done.await(2_000), "connection callback did not complete")
        dispatch_queue_set_specific(central.queue, key, null, null)
        central.close()
        assertFalse(onBleQueue, "callback owns BLE queue; synchronous close would trap")
    }

    @Test
    fun sessionLockDoesNotBlockTheBleQueueNeededByItsOwner() {
        val central = IosBleCentral()
        val sessionLock = NSRecursiveLock()
        val done = Latch(1, IosProtocolPlatform)
        var acquired = false
        central.setListener(object : StockLinkListener {
            override fun onNotification(address: String, characteristicUuid: String, data: ByteArray) {}
            override fun onConnectionStateChange(address: String, connected: Boolean) {
                acquired = sessionLock.lockBeforeDate(NSDate.dateWithTimeIntervalSinceNow(0.5))
                if (acquired) sessionLock.unlock()
                done.countDown()
            }
        })
        sessionLock.lock()
        try {
            dispatch_async(central.queue) { central.emitConnectionState("test", false) }
            // Mirrors the session worker holding its monitor while synchronously disconnecting.
            central.stopScan()
        } finally {
            sessionLock.unlock()
        }
        assertTrue(done.await(2_000), "callback did not complete")
        central.close()
        assertTrue(acquired, "BLE queue waited for the session lock while its owner waited for BLE")
    }

    /** Registering a state listener must create the central and report a state without any scan. */
    @Test
    fun scanListenerAloneReceivesABluetoothStateReport() {
        val central = IosBleCentral(IosProtocolPlatform)
        val states = ArrayList<Int>()
        var offMain = 0
        central.setScanListener(object : IosBleScanListener {
            override fun onBluetoothState(state: Int, authorization: Int) {
                if (!NSThread.isMainThread) offMain++
                states.add(state)
            }

            override fun onAdvertisement(identifier: String, name: String, manufacturerDataHex: String, rssi: Int, connectable: Boolean) {}
        })
        val deadline = IosProtocolPlatform.elapsedRealtimeMs() + 5_000
        while (IosProtocolPlatform.elapsedRealtimeMs() < deadline && states.none { it != 0 }) {
            NSRunLoop.mainRunLoop.runMode(NSDefaultRunLoopMode, NSDate.dateWithTimeIntervalSinceNow(0.02))
        }
        // The simulator reports unsupported/powered-off; a real phone powered-on. Any non-unknown state proves the central exists.
        assertTrue(states.any { it != 0 }, "no CBManagerState reported: $states")
        assertTrue(offMain == 0, "state reports must arrive on the main queue")
        central.close()
    }
}
