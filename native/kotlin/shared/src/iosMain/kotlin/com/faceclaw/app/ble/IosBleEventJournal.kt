@file:OptIn(kotlinx.cinterop.ExperimentalForeignApi::class)

package com.faceclaw.app

import kotlinx.cinterop.addressOf
import kotlinx.cinterop.convert
import kotlinx.cinterop.usePinned
import platform.Foundation.NSApplicationSupportDirectory
import platform.Foundation.NSBundle
import platform.Foundation.NSFileManager
import platform.Foundation.NSFilePosixPermissions
import platform.Foundation.NSFileProtectionCompleteUntilFirstUserAuthentication
import platform.Foundation.NSFileProtectionKey
import platform.Foundation.NSSearchPathForDirectoriesInDomains
import platform.Foundation.NSUserDomainMask
import platform.darwin.dispatch_async
import platform.darwin.dispatch_queue_create
import platform.darwin.dispatch_sync
import platform.posix.fchmod
import platform.posix.fclose
import platform.posix.fflush
import platform.posix.fileno
import platform.posix.fopen
import platform.posix.fsync
import platform.posix.fwrite

private val BLE_EVENTS = setOf("request", "connected", "disconnected", "failed", "cancelled", "timeout", "closed")
private const val BLE_EVENT_LIMIT = 200

/** Small private metadata journal for diagnosing background BLE connection loss. */
internal class IosBleEventJournal(private val folder: String) {
    private val queue = dispatch_queue_create("com.faceclaw.ble.events", null)
    private val path = "$folder/ble-events.jsonl"

    fun record(event: String, background: Boolean, code: Long? = null) {
        if (event !in BLE_EVENTS) return
        val timestampMs = currentTimeMillis()
        dispatch_async(queue) {
            try {
                val row = linkedMapOf<String, Any?>(
                    "timestampMs" to timestampMs,
                    "event" to event,
                    "background" to background,
                )
                if (code != null) row["code"] = code
                append(Json.write(row))
            } catch (_: Throwable) {
                PlatformLog.w(IosBleCentral.TAG, "BLE event journal write failed")
            }
        }
    }

    /** An ordered diagnostic snapshot; an unavailable journal is simply empty. */
    fun snapshot(): List<String> {
        var rows = emptyList<String>()
        dispatch_sync(queue) { rows = readRows() }
        return rows
    }

    private fun append(row: String) {
        check(NSFileManager.defaultManager.createDirectoryAtPath(
            folder, true, mapOf(NSFilePosixPermissions to 448), null)) { "Cannot create BLE event journal folder" }
        check(platform.posix.chmod(folder, 448u) == 0) { "Cannot protect BLE event journal folder" }
        val rows = (readRows() + row).takeLast(BLE_EVENT_LIMIT)
        val bytes = (rows.joinToString("\n") + "\n").encodeToByteArray()
        val file = fopen(path, "wb") ?: error("Cannot open BLE event journal")
        try {
            check(fchmod(fileno(file), 384u) == 0) { "Cannot protect BLE event journal" }
            bytes.usePinned { pinned ->
                check(fwrite(pinned.addressOf(0), 1u, bytes.size.convert(), file).toLong() == bytes.size.toLong()) {
                    "Cannot write BLE event journal"
                }
            }
            check(fflush(file) == 0 && fsync(fileno(file)) == 0) { "Cannot synchronize BLE event journal" }
        } finally {
            fclose(file)
        }
        check(NSFileManager.defaultManager.setAttributes(
            mapOf(NSFileProtectionKey to NSFileProtectionCompleteUntilFirstUserAuthentication), path, null,
        )) { "Cannot set BLE event journal data protection" }
    }

    private fun readRows(): List<String> = try {
        readFileData(path).decodeToString().lineSequence().filter(String::isNotBlank).toList()
    } catch (_: Throwable) {
        emptyList()
    }
}

private val defaultBleEventJournal: IosBleEventJournal? by lazy {
    if (NSBundle.mainBundle.infoDictionary?.get("CFBundlePackageType") != "APPL") return@lazy null
    val support = NSSearchPathForDirectoriesInDomains(NSApplicationSupportDirectory, NSUserDomainMask, true)
        .firstOrNull() as? String ?: return@lazy null
    IosBleEventJournal("$support/diagnostics")
}

/** [background] records the persistent native connection intent, not UIApplication state. */
internal fun iosBleEvent(event: String, background: Boolean, code: Long? = null) {
    try {
        defaultBleEventJournal?.record(event, background, code)
    } catch (_: Throwable) {
        PlatformLog.w(IosBleCentral.TAG, "BLE event journal unavailable")
    }
}
