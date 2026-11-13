package com.faceclaw.app

import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

private const val HEAD_UP_RIGHT = "AA:00:00:00:00:01"
private const val HEAD_UP_LEFT = "AA:00:00:00:00:02"

class HeadUpAngleTest {
    @Test
    fun angleWritesMatchStockWireContractAndValidateRange() {
        assertContentEquals(hex("080110071a0422021000"), BleProtocol.buildSetHeadUpAngle(7, 0))
        assertContentEquals(hex("080110071a042202101e"), BleProtocol.buildSetHeadUpAngle(7, 30))
        assertContentEquals(hex("080110071a042202103c"), BleProtocol.buildSetHeadUpAngle(7, 60))
        assertFailsWith<IllegalArgumentException> { BleProtocol.buildSetHeadUpAngle(7, -1) }
        assertFailsWith<IllegalArgumentException> { BleProtocol.buildSetHeadUpAngle(7, 61) }
    }

    @Test
    fun fullStatusAngleRequiresValidCorrelatedResponse() {
        assertEquals(30, BleProtocol.parseHeadUpAngle(response(2, 7, BleProtocol.encodeVarintField(8, 30)), 7))
        assertEquals(0, BleProtocol.parseHeadUpAngle(response(2, 7, ByteArray(0)), 7))
        assertEquals(-1, BleProtocol.parseHeadUpAngle(response(1, 7, BleProtocol.encodeVarintField(8, 30)), 7))
        assertEquals(-1, BleProtocol.parseHeadUpAngle(response(2, 8, BleProtocol.encodeVarintField(8, 30)), 7))
        assertEquals(-1, BleProtocol.parseHeadUpAngle(framedPb(hex("08021007220240")), 7))
        assertEquals(-1, BleProtocol.parseHeadUpAngle(framedPb(hex("08021007")), 7))
    }

    @Test
    fun readRequiresMatchingAnglesFromBothArms() {
        val session = Session()
        session.startAndAwaitLayout()
        try {
            session.link.headUpAngles[HEAD_UP_RIGHT] = 30
            session.link.headUpAngles[HEAD_UP_LEFT] = 30
            assertEquals(30, session.core.readHeadUpAngle())

            session.link.headUpAngles[HEAD_UP_LEFT] = 31
            assertEquals(-1, session.core.readHeadUpAngle())
        } finally {
            session.core.close()
        }
    }

    @Test
    fun setWritesBothArmsThenVerifiesIndependentReadback() {
        val session = Session()
        session.startAndAwaitLayout()
        try {
            val before = session.link.writes.size
            assertTrue(session.core.setHeadUpAngle(60))
            val operation = session.link.writes.drop(before).filter {
                it.kind == "head-up-angle-write" || it.kind == "head-up-angle-query"
            }
            assertEquals(listOf(HEAD_UP_RIGHT, HEAD_UP_LEFT), operation.filter { it.kind == "head-up-angle-write" }.map { it.address })
            assertEquals(listOf(HEAD_UP_RIGHT, HEAD_UP_LEFT), operation.filter { it.kind == "head-up-angle-query" }.map { it.address })
            assertEquals(60, session.link.headUpAngles[HEAD_UP_RIGHT])
            assertEquals(60, session.link.headUpAngles[HEAD_UP_LEFT])

            val writesAfterSuccess = session.link.writes.size
            assertFalse(session.core.setHeadUpAngle(61))
            assertEquals(writesAfterSuccess, session.link.writes.size)
        } finally {
            session.core.close()
        }
    }

    @Test
    fun setFailsOnWrongResultOrDisconnect() {
        val wrong = Session()
        wrong.startAndAwaitLayout()
        try {
            wrong.link.headUpQueryReply = { address, magic ->
                wrong.link.headUpStatusFrame(magic, if (address == HEAD_UP_LEFT) 29 else 30)
            }
            assertFalse(wrong.core.setHeadUpAngle(30))
        } finally {
            wrong.core.close()
        }

        val disconnected = Session()
        disconnected.startAndAwaitLayout()
        try {
            disconnected.link.disconnectOnHeadUpQueryAddress = HEAD_UP_RIGHT
            assertFalse(disconnected.core.setHeadUpAngle(30))
        } finally {
            disconnected.core.close()
        }
    }

    @Test
    fun queuedOperationCannotStartAfterReconnect() {
        val session = Session()
        session.startAndAwaitLayout()
        try {
            val oldGeneration = session.core.captureHeadUpSessionGeneration()
            session.core.onConnectionStateChange(HEAD_UP_RIGHT, false)
            assertTrue(waitUntil(5_000) {
                session.core.isSessionReady() &&
                    session.core.captureHeadUpSessionGeneration() != oldGeneration
            })

            val before = session.link.writes.size
            assertEquals(-1, session.core.readHeadUpAngleForSession(oldGeneration))
            assertFalse(session.core.setHeadUpAngleForSession(30, oldGeneration))
            assertEquals(0, session.link.writes.drop(before).count {
                it.kind == "head-up-angle-write" || it.kind == "head-up-angle-query"
            })
        } finally {
            session.core.close()
        }
    }

    private fun response(command: Int, magic: Int, status: ByteArray): ByteArray = framedPb(
        BleProtocol.encodeVarintField(1, command) + BleProtocol.encodeVarintField(2, magic) +
            BleProtocol.encodeBytesField(4, status)
    )

    private fun framedPb(payload: ByteArray): ByteArray = BleProtocol.parseFrame(
        BleProtocol.framePb(payload, BleProtocol.SID_UI_SETTING, 0x00, 1)[0]
    ).pb

    private fun hex(value: String): ByteArray = value.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
}
