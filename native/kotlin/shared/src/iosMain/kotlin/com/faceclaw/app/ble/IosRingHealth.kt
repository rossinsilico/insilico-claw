@file:OptIn(kotlinx.cinterop.ExperimentalForeignApi::class)

package com.faceclaw.app

import kotlinx.cinterop.addressOf
import kotlinx.cinterop.convert
import kotlinx.cinterop.usePinned
import platform.Foundation.NSFileManager
import platform.Foundation.NSFilePosixPermissions
import platform.posix.fchmod
import platform.posix.fclose
import platform.posix.fflush
import platform.posix.fileno
import platform.posix.fopen
import platform.posix.fsync
import platform.posix.fwrite

/** A page may be acknowledged only after its private raw copy reaches disk. */
internal class IosRingHealthJournal(private val folder: String) {
    fun append(line: String) {
        check(NSFileManager.defaultManager.createDirectoryAtPath(
            folder, true, mapOf(NSFilePosixPermissions to 448), null)) { "Cannot create ring journal folder" }
        val file = fopen("$folder/ring-frames.jsonl", "ab") ?: error("Cannot open ring journal")
        try {
            check(fchmod(fileno(file), 384u) == 0) { "Cannot protect ring journal" }
            val bytes = line.encodeToByteArray()
            if (bytes.isNotEmpty()) bytes.usePinned { pinned ->
                check(fwrite(pinned.addressOf(0), 1u, bytes.size.convert(), file).toLong() == bytes.size.toLong()) {
                    "Cannot append ring journal"
                }
            }
            check(fflush(file) == 0 && fsync(fileno(file)) == 0) { "Cannot synchronize ring journal" }
        } finally {
            fclose(file)
        }
    }
}

/** Preserve the native snapshot and dates across the ObjC boundary without Java collection APIs. */
internal fun iosRingHealthBatchJson(batch: RingHealthBatch): String = Json.write(mapOf(
    "watermark" to batch.watermark,
    "ringId" to batch.ringId,
    "records" to batch.records.map(::iosRingHealthRecord),
))

internal fun iosRingHealthRecordsJson(records: List<RingProtocol.HealthRecord>): String =
    Json.write(records.map(::iosRingHealthRecord))

internal fun iosRingHealthJournalJson(text: String, afterReceivedAtMs: Long): String {
    val rows = ArrayList<Map<String, Any?>>()
    for (line in text.lineSequence()) {
        val source = try { Json.parseObject(line) } catch (_: Throwable) { continue }
        val receivedAtMs = (source["receivedAtMs"] as? JsonNumber)?.toLong() ?: continue
        if (receivedAtMs <= afterReceivedAtMs) continue
        val ringId = (source["ringId"] as? String)?.let(::normalizeRingHealthIdentity)
        val raw = source["raw"] as? String ?: continue
        if (raw.length % 2 != 0) continue
        val bytes = try {
            ByteArray(raw.length / 2) { raw.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
        } catch (_: Throwable) {
            continue
        }
        val frame = try { RingProtocol.parse(bytes) } catch (_: Throwable) { null }
        if (frame?.crcOk != true) continue
        val record = try { RingProtocol.decode(frame, receivedAtMs) } catch (_: Throwable) { null } ?: continue
        rows.add(iosRingHealthRecord(record, ringId))
    }
    return Json.write(rows)
}

private fun iosRingHealthRecord(record: RingProtocol.HealthRecord, ringId: String? = null): Map<String, Any?> {
    val row = linkedMapOf<String, Any?>(
        "cmdHi" to record.cmdHi,
        "receivedAtMs" to record.receivedAtMs,
        "ringId" to ringId,
    )
    when (record) {
        is RingProtocol.HourlyRecord -> {
            row["anchorUnixSeconds"] = record.anchorUnixSeconds
            row["tagRaw"] = record.tagRaw
            row["current"] = record.current
            row["valueWidth"] = record.valueWidth
            row["groups"] = record.groups.map { mapOf("hourIndex" to it.hourIndex,
                "avg" to it.avg, "max" to it.max, "min" to it.min, "unixSeconds" to it.unixSeconds) }
        }
        is RingProtocol.StepsRecord -> {
            row["anchorUnixSeconds"] = record.anchorUnixSeconds
            row["buckets"] = record.buckets.map { mapOf("index" to it.index, "steps" to it.steps,
                "calorieLike2" to it.calorieLike2, "calorieLike3" to it.calorieLike3) }
        }
        is RingProtocol.SleepRecord -> {
            row["recordState"] = record.recordState
            row["startTs"] = record.startTs
            row["endTs"] = record.endTs
            row["unknownPrefix"] = RingProtocol.hex(record.unknownPrefix)
            row["unknownTag"] = record.unknownTag
            row["temperatureRaw"] = record.temperatureRaw
            row["utcOffsetMinutes"] = record.utcOffsetMinutes
            row["totalTime"] = record.totalTime
            row["wakeTime"] = record.wakeTime
            row["remTime"] = record.remTime
            row["lightTime"] = record.lightTime
            row["deepTime"] = record.deepTime
            row["segments"] = record.segments.map { mapOf("stage" to it.stage, "halfMinutes" to it.halfMinutes) }
        }
        else -> error("Unsupported ring health record")
    }
    return row
}
