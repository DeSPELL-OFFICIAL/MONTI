package app.monti.hce

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 같은 APDU 벡터가 `plugins/hce-android/src/apduVectors.test.ts`에도 있다. 이 기계에는
 * Android SDK가 없어 이 파일은 아직 컴파일된 적이 없으므로, 그 TS 파일이 같은 요청/응답
 * 벡터를 오늘 실행해 준다.
 */
class ApduStateMachineTest {

    private fun bytes(vararg v: Int): ByteArray = ByteArray(v.size) { v[it].toByte() }

    private fun hex(b: ByteArray): String = b.joinToString("") { String.format("%02X", it.toInt() and 0xFF) }

    /** 데이터 없이 상태어만 담긴 응답인지 본다(2바이트). */
    private fun assertStatus(expected: Int, response: ByteArray) {
        assertEquals(String.format("%04X", expected), hex(response))
    }

    /** 데이터가 실린 응답의 꼬리 두 바이트를 본다. */
    private fun assertTrailingStatus(expected: Int, response: ByteArray) {
        assertEquals(
            String.format("%04X", expected),
            hex(response.copyOfRange(response.size - 2, response.size)),
        )
    }

    /** monti.app:g 외부 타입 레코드 한 개, 페이로드 4바이트. 파일 전체는 NLEN 포함 20바이트. */
    private val shortRecord = bytes(
        0xD4, 0x0B, 0x04, // MB|ME|SR|TNF=4(external), TYPE_LENGTH=11, PAYLOAD_LENGTH=4
        0x6D, 0x6F, 0x6E, 0x74, 0x69, 0x2E, 0x61, 0x70, 0x70, 0x3A, 0x67, // "monti.app:g"
        0x01, 0x02, 0x03, 0x04,
    )

    /** 길이가 다른 두 번째 레코드. 페이로드 교체가 실제로 보이는지 보려고 쓴다. */
    private val otherRecord = bytes(0xD4, 0x03, 0x02, 0x66, 0x6F, 0x6F, 0xAA, 0xBB)

    /**
     * 진짜 게이트 코드의 모양: ~389바이트 CBOR이 실리면 SR 비트가 꺼져 헤더가 long form(0xC4,
     * 4바이트 payload length)이 되고 레코드가 406바이트가 된다. MLe(255)를 넘으므로 리더가
     * 나눠 읽어야 한다.
     */
    private fun gateRecord(payloadSize: Int = 389): ByteArray {
        val type = "monti.app:g".toByteArray(Charsets.US_ASCII)
        val record = ByteArray(6 + type.size + payloadSize)
        record[0] = 0xC4.toByte() // MB|ME|TNF=4, SR=0 → payload length 가 4바이트
        record[1] = type.size.toByte()
        record[2] = ((payloadSize shr 24) and 0xFF).toByte()
        record[3] = ((payloadSize shr 16) and 0xFF).toByte()
        record[4] = ((payloadSize shr 8) and 0xFF).toByte()
        record[5] = (payloadSize and 0xFF).toByte()
        type.copyInto(record, 6)
        // 위치가 그대로 보이도록 페이로드를 0,1,2,… 로 채운다. 오프셋이 틀리면 창이 어긋난다.
        for (i in 0 until payloadSize) record[6 + type.size + i] = (i and 0xFF).toByte()
        return record
    }

    private fun machine(
        payload: ByteArray = shortRecord,
        sink: MutableList<ByteArray> = mutableListOf(),
    ): ApduStateMachine {
        val m = ApduStateMachine { sink.add(it) }
        m.setPendingPayload(payload)
        return m
    }

    // iOS: 00 A4 04 00 07 D2760000850101 00 (Le 바이트 포함)
    private fun ApduStateMachine.selectApplication(): ByteArray =
        process(bytes(0x00, 0xA4, 0x04, 0x00, 0x07, 0xD2, 0x76, 0x00, 0x00, 0x85, 0x01, 0x01, 0x00))

    // iOS: 00 A4 00 0C 02 E1xx (P2 = 0x0C, Le 없음)
    private fun ApduStateMachine.selectFile(fileIdLow: Int): ByteArray =
        process(bytes(0x00, 0xA4, 0x00, 0x0C, 0x02, 0xE1, fileIdLow))

    private fun ApduStateMachine.readBinary(offset: Int, le: Int): ByteArray =
        process(bytes(0x00, 0xB0, (offset shr 8) and 0xFF, offset and 0xFF, le))

    @Test
    fun selectAidAnswersNineThousandWithNoFci() {
        val r = machine().selectApplication()
        // 두 바이트뿐이어야 한다. FCI가 붙으면 아이폰이 세션을 끊는다.
        assertEquals(2, r.size)
        assertEquals("9000", hex(r))
    }

    @Test
    fun theFullIosCoreNfcReadSequenceSucceeds() {
        val m = machine()
        assertStatus(ApduStatus.SW_OK, m.selectApplication())
        // SELECT CC file E103
        assertStatus(ApduStatus.SW_OK, m.selectFile(0x03))
        // READ BINARY CC, 15 bytes
        val cc = m.readBinary(0x0000, 0x0F)
        assertEquals(17, cc.size)
        assertArrayEquals(Type4Files.capabilityContainer(), cc.copyOfRange(0, 15))
        assertTrailingStatus(ApduStatus.SW_OK, cc)
        // SELECT NDEF file E104
        assertStatus(ApduStatus.SW_OK, m.selectFile(0x04))
        // READ BINARY NLEN (2 bytes)
        assertEquals("0012" + "9000", hex(m.readBinary(0x0000, 0x02)))
        // NLEN 다음(오프셋 2)부터가 메시지다. 18바이트를 달라고 하면 레코드 전체가 온다.
        val msg = m.readBinary(0x0002, 0x12)
        assertEquals(shortRecord.size + 2, msg.size)
        assertArrayEquals(shortRecord, msg.copyOfRange(0, shortRecord.size))
        assertTrailingStatus(ApduStatus.SW_OK, msg)
    }

    @Test
    fun aLongFormGateRecordIsReadBackInMleSizedWindows() {
        val record = gateRecord()
        assertEquals(406, record.size)
        assertEquals(0xC4.toByte(), record[0]) // short record 가 아니다
        val m = machine(record)
        m.selectApplication()
        m.selectFile(0x04)

        val nlen = m.readBinary(0x0000, 0x02)
        assertEquals("0196" + "9000", hex(nlen))
        val declared = ((nlen[0].toInt() and 0xFF) shl 8) or (nlen[1].toInt() and 0xFF)
        assertEquals(record.size, declared)

        // 리더처럼 MLe(255)씩 끊어 읽어 파일을 그대로 복원한다.
        val assembled = ArrayList<Byte>(declared)
        var offset = 2
        while (assembled.size < declared) {
            val chunk = m.readBinary(offset, 0xFF)
            val dataLength = chunk.size - 2
            assertTrue("한 번에 MLe(255) 를 넘겨 주면 안 된다", dataLength in 1..255)
            assertTrailingStatus(ApduStatus.SW_OK, chunk)
            for (i in 0 until dataLength) assembled.add(chunk[i])
            offset += dataLength
        }
        assertArrayEquals(record, assembled.toByteArray())
        assertEquals(2 + declared, offset)
    }

    @Test
    fun aReadWindowStraddlesTheRecordsTwoHundredFiftyFifthByte() {
        val record = gateRecord()
        val m = machine(record)
        m.selectApplication()
        m.selectFile(0x04)
        // 파일 오프셋 254 = 레코드 252번째 바이트. 255바이트 경계를 가운데 두고 10바이트를 읽는다.
        val window = m.readBinary(254, 0x0A)
        assertEquals(12, window.size)
        assertArrayEquals(record.copyOfRange(252, 262), window.copyOfRange(0, 10))
        assertTrailingStatus(ApduStatus.SW_OK, window)
    }

    @Test
    fun readBinaryTruncatesToLeAndNeverOverruns() {
        val m = machine()
        m.selectApplication()
        m.selectFile(0x04)
        // 파일은 20바이트뿐인데 255를 달라고 한다 → 있는 만큼만 준다.
        val r = m.readBinary(0x0000, 0xFF)
        assertEquals(20 + 2, r.size)
        assertEquals("0012", hex(r.copyOfRange(0, 2)))
        assertArrayEquals(shortRecord, r.copyOfRange(2, 20))
        assertTrailingStatus(ApduStatus.SW_OK, r)
    }

    @Test
    fun readBinaryAtTheVeryEndOfTheFileReturnsNothingAndSucceeds() {
        val m = machine()
        m.selectApplication()
        m.selectFile(0x03)
        // 리더는 여기까지 오지 않지만 경계는 못 박아 둔다: 오프셋 == 파일 크기면 빈 응답,
        // 그보다 크면 6A86(아래 readBinaryPastTheEndOfTheFileIsWrongP1P2).
        assertStatus(ApduStatus.SW_OK, m.readBinary(15, 0x01))
    }

    @Test
    fun readingBeforeSelectingTheApplicationIsRefused() {
        assertStatus(ApduStatus.SW_SECURITY, machine().readBinary(0x0000, 0x0F))
    }

    @Test
    fun readingWithNoFileSelectedIsRefused() {
        val m = machine()
        m.selectApplication()
        assertStatus(ApduStatus.SW_SECURITY, m.readBinary(0x0000, 0x0F))
    }

    @Test
    fun selectingAnUnknownFileIsFileNotFound() {
        val m = machine()
        m.selectApplication()
        assertStatus(ApduStatus.SW_FILE_NOT_FOUND, m.selectFile(0x05))
    }

    @Test
    fun selectingSomeOtherApplicationIsFileNotFound() {
        val m = machine()
        val wrongAid = bytes(0x00, 0xA4, 0x04, 0x00, 0x07, 0xD2, 0x76, 0x00, 0x00, 0x85, 0x01, 0x02, 0x00)
        assertStatus(ApduStatus.SW_FILE_NOT_FOUND, m.process(wrongAid))
        // 세션이 열리지 않았으므로 읽기도 막혀 있어야 한다.
        assertStatus(ApduStatus.SW_SECURITY, m.readBinary(0x0000, 0x0F))
    }

    @Test
    fun selectWithWrongP1P2IsRejected() {
        val m = machine()
        m.selectApplication()
        assertStatus(ApduStatus.SW_WRONG_P1P2, m.process(bytes(0x00, 0xA4, 0x02, 0x00, 0x02, 0xE1, 0x04)))
    }

    @Test
    fun readBinaryPastTheEndOfTheFileIsWrongP1P2() {
        val m = machine()
        m.selectApplication()
        m.selectFile(0x03)
        assertStatus(ApduStatus.SW_WRONG_P1P2, m.readBinary(0x0040, 0x01))
    }

    @Test
    fun anUnknownInstructionIsRejectedWithoutCrashing() {
        val m = machine()
        m.selectApplication()
        assertStatus(ApduStatus.SW_INS_NOT_SUPPORTED, m.process(bytes(0x00, 0xCA, 0x00, 0x00, 0x00)))
        // UPDATE BINARY 도 아직은 여기로 떨어진다. Task 5 가 쓰기 경로를 넣으면서 바뀐다.
        assertStatus(
            ApduStatus.SW_INS_NOT_SUPPORTED,
            m.process(bytes(0x00, 0xD6, 0x00, 0x00, 0x02, 0x00, 0x00)),
        )
        // 세션은 살아 있어야 한다: 다음 SELECT 가 계속 동작한다.
        assertStatus(ApduStatus.SW_OK, m.selectFile(0x03))
    }

    @Test
    fun aClassOtherThanZeroIsRejected() {
        val m = machine()
        m.selectApplication()
        assertStatus(ApduStatus.SW_CLASS_NOT_SUPPORTED, m.process(bytes(0x80, 0xB0, 0x00, 0x00, 0x02)))
        assertStatus(ApduStatus.SW_OK, m.selectFile(0x03))
    }

    @Test
    fun anApduThatClaimsMoreThanItCarriesIsWrongLength() {
        val m = machine()
        assertStatus(ApduStatus.SW_WRONG_LENGTH, m.process(bytes(0x00, 0xA4, 0x04)))
        m.selectApplication()
        // Lc = 2 라고 해 놓고 한 바이트만 실어 보냈다.
        assertStatus(ApduStatus.SW_WRONG_LENGTH, m.process(bytes(0x00, 0xA4, 0x00, 0x0C, 0x02, 0xE1)))
        // 파일 id 는 정확히 두 바이트다.
        assertStatus(
            ApduStatus.SW_WRONG_LENGTH,
            m.process(bytes(0x00, 0xA4, 0x00, 0x0C, 0x03, 0xE1, 0x04, 0x00)),
        )
    }

    @Test
    fun everyResponseIsAFreshArray() {
        val m = machine()
        val first = m.selectApplication()
        val second = m.selectFile(0x03)
        assertNotSame(first, second)
        // 호출자가 응답 배열을 고쳐도 다음 응답은 멀쩡해야 한다. HostApduService(Task 4)가
        // 이 배열을 그대로 프레임워크에 넘긴다.
        first[0] = 0x00
        second[1] = 0x00
        assertStatus(ApduStatus.SW_OK, m.selectFile(0x04))
        assertEquals(0x9000, ApduStatus.SW_OK)
    }

    @Test
    fun aPayloadSetMidSessionIsOnlyVisibleToTheNextSession() {
        val m = machine()
        m.selectApplication()
        m.selectFile(0x04)
        m.setPendingPayload(otherRecord)
        // 진행 중인 탭은 끝까지 같은 메시지를 읽어 간다 — 길이가 도중에 줄면 리더가 깨진다.
        assertEquals("0012" + "9000", hex(m.readBinary(0x0000, 0x02)))
        assertArrayEquals(shortRecord, m.activePayload)

        m.onDeactivated()
        assertArrayEquals(otherRecord, m.activePayload)
        m.selectApplication()
        m.selectFile(0x04)
        assertEquals("0008" + "9000", hex(m.readBinary(0x0000, 0x02)))
    }

    @Test
    fun aPayloadLargerThanTheDeclaredFileIsRefused() {
        val m = machine()
        assertThrows(IllegalArgumentException::class.java) {
            m.setPendingPayload(ByteArray(Type4Files.MAX_NDEF_SIZE + 1))
        }
        m.setPendingPayload(ByteArray(Type4Files.MAX_NDEF_SIZE))
        assertEquals(Type4Files.MAX_NDEF_SIZE, m.activePayload.size)
    }
}
