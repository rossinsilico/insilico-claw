package com.faceclaw.app

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFails
import kotlin.test.assertNull
import kotlin.test.assertTrue
import platform.Foundation.NSTemporaryDirectory

class IosRingHealthTest {
    @Test
    fun iosHostAllowsOnlyExplicitReadOnlyHealthRetrieval() {
        val host = IosSessionHost()
        assertTrue(host.supportsRingHealth())
        assertTrue(host.ringHealthReadOnly())
    }

    @Test
    fun journalAppendsAndSurvivesReopeningWithoutTruncatingHistory() {
        val folder = NSTemporaryDirectory().trimEnd('/') + "/ring-health-" + currentTimeMillis()
        val first = IosRingHealthJournal(folder)
        first.append("{\"receivedAtMs\":1}\n")
        IosRingHealthJournal(folder).append("{\"receivedAtMs\":2}\n")
        assertEquals("{\"receivedAtMs\":1}\n{\"receivedAtMs\":2}\n",
            readFileData("$folder/ring-frames.jsonl").decodeToString())
        deleteFile("$folder/ring-frames.jsonl")
    }

    @Test
    fun journalFailureThrowsInsteadOfAllowingAnAcknowledgement() {
        val blocker = NSTemporaryDirectory().trimEnd('/') + "/ring-health-file-" + currentTimeMillis()
        writeFileData(blocker, byteArrayOf(1))
        try {
            assertFails { IosRingHealthJournal(blocker).append("record\n") }
        } finally {
            deleteFile(blocker)
        }
    }

    @Test
    fun productionLineSeparatorKeepsANewPageReplayableAfterAnInterruptedAppend() {
        val folder = NSTemporaryDirectory().trimEnd('/') + "/ring-health-tail-" + currentTimeMillis()
        val journal = IosRingHealthJournal(folder)
        journal.append("{\"receivedAtMs\":999,\"raw\":\"dead")
        val payload = byteArrayOf(0, 0, 1, 0, 0, 0xe8.toByte(), 0x03, 0, 0, 2, 60, 70, 50)
        val raw = RingProtocol.buildFrame(RingProtocol.CHAN_HEALTH, RingProtocol.KIND_DATA,
            RingProtocol.CMD_HI_HEART_RATE, RingProtocol.CMD_LO_HEALTH, 1, payload)
        // Same leading separator as GlassesSessionCore.journalRingFrame.
        journal.append("\n{\"receivedAtMs\":1000,\"raw\":\"${RingProtocol.hex(raw)}\"}\n")
        try {
            val records = RingProtocol.decodeFrameJournal(readFileData("$folder/ring-frames.jsonl").decodeToString(), 0)
            assertEquals(1000L, records.single().receivedAtMs)
            assertEquals(60, (records.single() as RingProtocol.HourlyRecord).groups.single().avg)
        } finally {
            deleteFile("$folder/ring-frames.jsonl")
        }
    }

    @Test
    fun recordJsonPreservesRawDatesAndWatermarkWithoutConsumingTheBatch() {
        val record = RingProtocol.HourlyRecord(
            RingProtocol.CMD_HI_HEART_RATE, 1234L, 1731000000L, 0, 70, 1,
            arrayOf(RingProtocol.HourlyGroup(2, 70, 80, 60, 1731007200L)))
        val batch = RingHealthBatch(listOf(record), 9L, "CC:00:00:00:00:03")
        val json = Json.parseObject(iosRingHealthBatchJson(batch))
        assertEquals(9L, (json["watermark"] as JsonNumber).toLong())
        assertEquals("CC:00:00:00:00:03", json["ringId"])
        val rows = json["records"] as List<*>
        val row = rows.single() as Map<*, *>
        assertEquals(1731000000L, (row["anchorUnixSeconds"] as JsonNumber).toLong())
        assertEquals(1234L, (row["receivedAtMs"] as JsonNumber).toLong())
        assertTrue((row["groups"] as List<*>).isNotEmpty())
        assertEquals(1, batch.records.size)
    }

    @Test
    fun sleepJsonCarriesRawTemperatureAndSignedUtcOffsetWithoutInventingUnavailableValues() {
        val measured = RingProtocol.SleepRecord(1000L, 1, byteArrayOf(1, 2), 3L,
            1_700_000_000L, 1_700_003_600L, 3600, 300, 900, 1500, 900,
            arrayOf(RingProtocol.SleepSegment(2, 60)), 0x1234, -300)
        val unavailable = RingProtocol.SleepRecord(2000L, 2, byteArrayOf(), 0L,
            0, 0, 0, 0, 0, 0, 0, arrayOf())
        val rows = Json.parse(iosRingHealthRecordsJson(listOf(measured, unavailable))) as List<*>
        val measuredRow = rows[0] as Map<*, *>
        val unavailableRow = rows[1] as Map<*, *>

        assertEquals(0x1234L, (measuredRow["temperatureRaw"] as JsonNumber).toLong())
        assertEquals(-300L, (measuredRow["utcOffsetMinutes"] as JsonNumber).toLong())
        assertNull(unavailableRow["temperatureRaw"])
        assertNull(unavailableRow["utcOffsetMinutes"])
    }

    @Test
    fun journalReplayRequiresValidPersistedIdentityAndRawCrc() {
        val payload = byteArrayOf(0, 0, 1, 0, 0, 0xe8.toByte(), 0x03, 0, 0, 2, 60, 70, 50)
        val raw = RingProtocol.buildFrame(RingProtocol.CHAN_HEALTH, RingProtocol.KIND_DATA,
            RingProtocol.CMD_HI_HEART_RATE, RingProtocol.CMD_LO_HEALTH, 1, payload)
        val corrupt = raw.copyOf().also { it[1] = (it[1].toInt() xor 1).toByte() }
        val text = listOf(
            Json.write(mapOf("receivedAtMs" to 1000L, "raw" to RingProtocol.hex(raw))),
            Json.write(mapOf("receivedAtMs" to 1001L, "ringId" to "not-a-mac", "raw" to RingProtocol.hex(raw))),
            Json.write(mapOf("receivedAtMs" to 1002L, "ringId" to "CC:00:00:00:00:03", "raw" to RingProtocol.hex(corrupt))),
            Json.write(mapOf("receivedAtMs" to 1003L, "ringId" to "CC:00:00:00:00:03", "raw" to RingProtocol.hex(raw))),
        ).joinToString("\n")

        val rows = Json.parse(IosGlassesSession.decodeRingHealthJournal(text, 0)) as List<*>
        assertEquals(3, rows.size)
        val legacy = rows[0] as Map<*, *>
        val invalidIdentity = rows[1] as Map<*, *>
        val attributed = rows[2] as Map<*, *>
        assertTrue(legacy.containsKey("ringId"))
        assertTrue(invalidIdentity.containsKey("ringId"))
        assertNull(legacy["ringId"])
        assertNull(invalidIdentity["ringId"])
        assertEquals("CC:00:00:00:00:03", attributed["ringId"])
        assertEquals(1003L, (attributed["receivedAtMs"] as JsonNumber).toLong())
    }
}
