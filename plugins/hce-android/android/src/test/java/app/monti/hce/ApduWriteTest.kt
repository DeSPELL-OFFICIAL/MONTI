package app.monti.hce

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 쓰기 경로 — 관객 폰이 서명한 응답을 이 태그에 써 넣는 길.
 *
 * T4T 2.0 이 정한 순서는 **NLEN 이 마지막**이다.
 * ```
 *   00 D6 0000 02 0000        NLEN = 0      파일을 비운다
 *   00 D6 0002 xx <조각>      본문          MLc 만큼씩, 오프셋을 옮겨 가며
 *   00 D6 0000 02 00B0        NLEN = 176    여기서 비로소 메시지 하나가 완성된다
 * ```
 * 이 파일이 지키는 불변식 하나: **완성된 메시지 하나마다 write 이벤트가 정확히 하나.**
 * 끊긴 쓰기, 선언보다 모자란 본문, 같은 NLEN 두 번 — 어느 쪽도 이벤트를 만들지 않는다.
 *
 * 같은 벡터가 `plugins/hce-android/src/apduVectors.test.ts`에도 있다. 이 기계에는 Android
 * SDK가 없어 이 파일은 아직 컴파일된 적이 없으므로, 그 TS 파일이 같은 요청/응답 벡터를
 * 오늘 실행해 준다.
 */
class ApduWriteTest {

    private fun bytes(vararg v: Int): ByteArray = ByteArray(v.size) { v[it].toByte() }

    private fun hex(b: ByteArray): String = b.joinToString("") { String.format("%02X", it.toInt() and 0xFF) }

    private fun assertStatus(expected: Int, response: ByteArray) {
        assertEquals(String.format("%04X", expected), hex(response))
    }

    /** CC가 선언한 MLc — UPDATE BINARY 한 번이 나를 수 있는 최대 데이터(CC 인덱스 5~6). */
    private val mlc = 255

    /** 완성된 메시지가 하나씩 들어온다. 생성자 콜백이 곧 플러그인의 `write` 이벤트다(Task 7). */
    private val written = mutableListOf<ByteArray>()

    private val machine = ApduStateMachine { written.add(it) }

    // ── 리더가 보내는 APDU ──────────────────────────────────────────────────

    // iOS: 00 A4 04 00 07 D2760000850101 00 (Le 바이트 포함)
    private val selectApplicationApdu =
        bytes(0x00, 0xA4, 0x04, 0x00, 0x07, 0xD2, 0x76, 0x00, 0x00, 0x85, 0x01, 0x01, 0x00)

    private fun selectFileApdu(fileIdLow: Int): ByteArray =
        bytes(0x00, 0xA4, 0x00, 0x0C, 0x02, 0xE1, fileIdLow)

    private fun updateBinaryApdu(offset: Int, data: ByteArray): ByteArray =
        bytes(0x00, 0xD6, (offset shr 8) and 0xFF, offset and 0xFF, data.size) + data

    private fun selectApplication(): ByteArray = machine.process(selectApplicationApdu)

    private fun selectFile(fileIdLow: Int): ByteArray = machine.process(selectFileApdu(fileIdLow))

    private fun updateBinary(offset: Int, data: ByteArray): ByteArray =
        machine.process(updateBinaryApdu(offset, data))

    private fun nlen(length: Int): ByteArray = bytes((length shr 8) and 0xFF, length and 0xFF)

    /** SELECT AID → SELECT E104. 쓰기는 NDEF 파일을 고른 뒤에만 된다. */
    private fun openNdefFile() {
        assertStatus(ApduStatus.SW_OK, selectApplication())
        assertStatus(ApduStatus.SW_OK, selectFile(0x04))
    }

    /**
     * 리더의 세 단계를 그대로 보낸다: NLEN 0 → 본문 조각들 → 실제 NLEN.
     * 본문을 다 보낼 때까지 이벤트가 하나도 늘지 않는지 매 조각마다 확인한다.
     */
    private fun write(message: ByteArray, chunk: Int = mlc) {
        val before = written.size
        assertStatus(ApduStatus.SW_OK, updateBinary(0, nlen(0)))
        var at = 0
        while (at < message.size) {
            val end = minOf(at + chunk, message.size)
            assertStatus(ApduStatus.SW_OK, updateBinary(2 + at, message.copyOfRange(at, end)))
            assertEquals("NLEN 을 쓰기 전에는 이벤트가 없어야 한다", before, written.size)
            at = end
        }
        assertStatus(ApduStatus.SW_OK, updateBinary(0, nlen(message.size)))
    }

    private fun assertOnlyMessage(expected: ByteArray) {
        assertEquals(1, written.size)
        assertArrayEquals(expected, written[0])
    }

    // ── 관객 폰이 써 넣는 것 ───────────────────────────────────────────────

    /** 브리핑의 벡터: monti.app:s 외부 타입 레코드, 페이로드 3바이트 → 전체 17바이트. */
    private val response = bytes(
        0xD4, 0x0B, 0x03,
        0x6D, 0x6F, 0x6E, 0x74, 0x69, 0x2E, 0x61, 0x70, 0x70, 0x3A, 0x73, // "monti.app:s"
        0xAA, 0xBB, 0xCC,
    )

    /**
     * 진짜 응답의 크기. `GateResponseWire` CBOR 은 162바이트라(v + tokenId + 64바이트 서명)
     * 페이로드가 255 이하 → SR=1 short record 가 되고 레코드는 3 + 11 + 162 = 176바이트다.
     */
    private fun responseRecord(payloadSize: Int = 162): ByteArray {
        val type = "monti.app:s".toByteArray(Charsets.US_ASCII)
        val record = ByteArray(3 + type.size + payloadSize)
        record[0] = 0xD4.toByte() // MB|ME|SR|TNF=4(external)
        record[1] = type.size.toByte()
        record[2] = payloadSize.toByte()
        type.copyInto(record, 3)
        for (i in 0 until payloadSize) record[3 + type.size + i] = (i and 0xFF).toByte()
        return record
    }

    /** 페이로드가 255를 넘으면 헤더가 long form(0xC4, 4바이트 길이)이 된다 → 417바이트. */
    private fun longFormRecord(payloadSize: Int = 400): ByteArray {
        val type = "monti.app:s".toByteArray(Charsets.US_ASCII)
        val record = ByteArray(6 + type.size + payloadSize)
        record[0] = 0xC4.toByte() // SR=0
        record[1] = type.size.toByte()
        record[2] = ((payloadSize shr 24) and 0xFF).toByte()
        record[3] = ((payloadSize shr 16) and 0xFF).toByte()
        record[4] = ((payloadSize shr 8) and 0xFF).toByte()
        record[5] = (payloadSize and 0xFF).toByte()
        type.copyInto(record, 6)
        for (i in 0 until payloadSize) record[6 + type.size + i] = (i and 0xFF).toByte()
        return record
    }

    // ── 테스트 ─────────────────────────────────────────────────────────────

    @Test
    fun theThreeStepWriteFiresOneEventAndOnlyAtTheFinalNlen() {
        openNdefFile()
        // 1) 파일을 비운다
        assertStatus(ApduStatus.SW_OK, updateBinary(0, nlen(0)))
        assertTrue(written.isEmpty())
        // 2) 본문
        assertStatus(ApduStatus.SW_OK, updateBinary(2, response))
        assertTrue("본문만으로는 완성이 아니다 — NLEN 이 아직 0 이다", written.isEmpty())
        // 3) NLEN = 0011 (17)
        assertStatus(ApduStatus.SW_OK, updateBinary(0, nlen(response.size)))
        assertOnlyMessage(response)
    }

    @Test
    fun theRealGateResponseRecordArrivesWhole() {
        val record = responseRecord()
        assertEquals(176, record.size)
        assertEquals(0xD4.toByte(), record[0]) // 162바이트 페이로드는 short record 다
        // 조각 크기는 CC 가 선언한 MLc 그대로여야 한다. 상수와 CC 가 갈라지면 안 된다.
        val cc = Type4Files.capabilityContainer()
        assertEquals(mlc, ((cc[5].toInt() and 0xFF) shl 8) or (cc[6].toInt() and 0xFF))
        openNdefFile()
        write(record)
        assertOnlyMessage(record)
    }

    @Test
    fun aBodySplitIntoSmallWindowsIsReassembled() {
        val record = responseRecord()
        openNdefFile()
        // 창이 작은 리더: 64바이트씩 세 번 + 나머지.
        write(record, chunk = 64)
        assertOnlyMessage(record)
    }

    @Test
    fun aLongFormRecordIsWrittenPastOffsetTwoHundredFiftyFive() {
        val record = longFormRecord()
        assertEquals(417, record.size)
        assertEquals(0xC4.toByte(), record[0])
        openNdefFile()
        // MLc(255)씩 → 두 번째 조각이 파일 오프셋 257 = P1P2 0x0101 로 간다.
        // 오프셋을 리틀엔디언으로 읽으면 여기서 어긋난다.
        write(record, chunk = mlc)
        assertOnlyMessage(record)
    }

    @Test
    fun chunksThatArriveOutOfOrderLandWhereTheOffsetSays() {
        openNdefFile()
        updateBinary(0, nlen(0))
        // 꼬리를 먼저, 머리를 나중에.
        assertStatus(ApduStatus.SW_OK, updateBinary(11, response.copyOfRange(9, 17)))
        assertTrue("앞이 비어 있으면 완성이 아니다", written.isEmpty())
        assertStatus(ApduStatus.SW_OK, updateBinary(2, response.copyOfRange(0, 9)))
        assertTrue(written.isEmpty())
        updateBinary(0, nlen(response.size))
        assertOnlyMessage(response)
    }

    @Test
    fun theAndroidReaderSingleShotWriteEmitsOneMessage() {
        openNdefFile()
        // NLEN 과 본문을 한 APDU 에 담아 보내는 리더도 있다.
        assertStatus(ApduStatus.SW_OK, updateBinary(0, nlen(response.size) + response))
        assertOnlyMessage(response)
    }

    @Test
    fun aTruncatedWriteNeverEmitsAndLeavesNothingBehind() {
        openNdefFile()
        updateBinary(0, nlen(0))
        updateBinary(2, response.copyOfRange(0, 9))
        // 리더가 사라졌다.
        machine.onDeactivated()
        assertTrue(written.isEmpty())

        // 다음 탭이 다른 메시지를 다 써 넣으면, 나오는 건 그 메시지 하나뿐이어야 한다.
        val record = responseRecord()
        openNdefFile()
        write(record)
        assertOnlyMessage(record)
    }

    @Test
    fun aNewSessionDropsWhatTheLastTapWasWriting() {
        openNdefFile()
        updateBinary(0, nlen(0))
        updateBinary(2, response.copyOfRange(0, 9))
        // 링크가 끊겨 onDeactivated 가 오지 못했다. 다음 SELECT AID 가 세션을 새로 연다.
        openNdefFile()
        assertStatus(ApduStatus.SW_OK, updateBinary(0, nlen(9)))
        assertTrue("지난 탭의 바이트로 메시지를 만들어 내면 안 된다", written.isEmpty())
    }

    @Test
    fun aGapInTheMiddleIsNotAFinishedMessage() {
        val record = responseRecord()
        openNdefFile()
        updateBinary(0, nlen(0))
        // 꼬리만 도착했다. 앞 100바이트는 비어 있다.
        assertStatus(ApduStatus.SW_OK, updateBinary(2 + 100, record.copyOfRange(100, record.size)))
        // "지금까지 본 가장 먼 오프셋"으로 세면 176이라 완성으로 보인다. 실제로는 구멍이 있다.
        assertStatus(ApduStatus.SW_OK, updateBinary(0, nlen(record.size)))
        assertTrue("가운데가 비었는데 완성으로 보면 안 된다", written.isEmpty())
        // 구멍이 메워지는 순간 한 번 나간다.
        assertStatus(ApduStatus.SW_OK, updateBinary(2, record.copyOfRange(0, 100)))
        assertOnlyMessage(record)
    }

    @Test
    fun aCallbackThatPushesTheReadersRetryBackInStillSeesOneEvent() {
        val seen = mutableListOf<ByteArray>()
        var reentered = 0
        var self: ApduStateMachine? = null
        val finalNlen = updateBinaryApdu(0, nlen(response.size))
        val m = ApduStateMachine {
            seen.add(it)
            if (reentered == 0) {
                reentered = 1
                // 서비스(Task 7)가 이벤트를 받자마자 리더의 재시도 APDU 를 그대로 다시 밀어
                // 넣었다. 상태를 콜백보다 먼저 지우지 않으면 여기서 이벤트가 한 번 더 난다.
                self?.process(finalNlen)
            }
        }
        self = m
        assertStatus(ApduStatus.SW_OK, m.process(selectApplicationApdu))
        assertStatus(ApduStatus.SW_OK, m.process(selectFileApdu(0x04)))
        m.process(updateBinaryApdu(0, nlen(0)))
        m.process(updateBinaryApdu(2, response))
        assertStatus(ApduStatus.SW_OK, m.process(finalNlen))
        assertEquals(1, reentered)
        assertEquals(1, seen.size)
        assertArrayEquals(response, seen[0])
    }

    @Test
    fun anNlenBiggerThanWhatWasWrittenWaitsInsteadOfFiring() {
        openNdefFile()
        updateBinary(0, nlen(0))
        updateBinary(2, response.copyOfRange(0, 9))
        // 9바이트만 쓰고 17을 선언했다.
        assertStatus(ApduStatus.SW_OK, updateBinary(0, nlen(response.size)))
        assertTrue("선언한 만큼 모이지 않았다", written.isEmpty())
        // 남은 8바이트가 도착하면 그때 한 번 나간다(NLEN 을 먼저 쓰는 리더도 이 길로 통과한다).
        assertStatus(ApduStatus.SW_OK, updateBinary(11, response.copyOfRange(9, 17)))
        assertOnlyMessage(response)
    }

    @Test
    fun twoWritesInOneSessionEmitTwice() {
        val second = responseRecord()
        openNdefFile()
        write(response)
        write(second)
        assertEquals(2, written.size)
        assertArrayEquals(response, written[0])
        assertArrayEquals(second, written[1])
    }

    @Test
    fun theSameFinalNlenTwiceStillEmitsOnce() {
        openNdefFile()
        write(response)
        // 리더가 마지막 APDU 의 응답을 놓쳐 다시 보냈다.
        assertStatus(ApduStatus.SW_OK, updateBinary(0, nlen(response.size)))
        assertOnlyMessage(response)
    }

    @Test
    fun writingBeforeSelectingTheNdefFileIsRefused() {
        assertStatus(ApduStatus.SW_SECURITY, updateBinary(0, nlen(0)))
        assertStatus(ApduStatus.SW_OK, selectApplication())
        assertStatus(ApduStatus.SW_SECURITY, updateBinary(0, nlen(0)))
        // CC 파일에는 쓸 수 없다.
        assertStatus(ApduStatus.SW_OK, selectFile(0x03))
        assertStatus(ApduStatus.SW_SECURITY, updateBinary(0, nlen(0)))
        assertTrue(written.isEmpty())
    }

    @Test
    fun writingPastTheMaxSizeIsWrongP1P2() {
        openNdefFile()
        assertStatus(ApduStatus.SW_WRONG_P1P2, updateBinary(2100, bytes(0x01)))
        // 경계: 파일의 마지막 바이트(오프셋 2 + 2045)는 들어가고 그 다음은 파일 밖이다.
        assertStatus(ApduStatus.SW_OK, updateBinary(2 + Type4Files.MAX_NDEF_SIZE - 1, bytes(0x01)))
        assertStatus(ApduStatus.SW_WRONG_P1P2, updateBinary(2 + Type4Files.MAX_NDEF_SIZE, bytes(0x01)))
    }

    @Test
    fun aDeclaredLengthLargerThanTheMaxSizeIsRejected() {
        openNdefFile()
        assertStatus(ApduStatus.SW_WRONG_P1P2, updateBinary(0, bytes(0x0F, 0xFF)))
        // 정확히 한도까지는 받는다(본문이 아직 없으니 이벤트는 나가지 않는다).
        assertStatus(ApduStatus.SW_OK, updateBinary(0, nlen(Type4Files.MAX_NDEF_SIZE)))
        assertTrue(written.isEmpty())
    }

    @Test
    fun writingIntoTheNlenBoundaryIsRefused() {
        openNdefFile()
        // 오프셋 1은 NLEN 의 뒷바이트다. 본문도 NLEN 도 아닌 자리라 받지 않는다.
        assertStatus(ApduStatus.SW_WRONG_P1P2, updateBinary(1, bytes(0x01)))
    }

    @Test
    fun anUpdateBinaryThatClaimsMoreThanItCarriesIsWrongLength() {
        openNdefFile()
        // Lc 가 없다.
        assertStatus(ApduStatus.SW_WRONG_LENGTH, machine.process(bytes(0x00, 0xD6, 0x00, 0x00)))
        // Lc = 2 라고 해 놓고 한 바이트만 실었다.
        assertStatus(ApduStatus.SW_WRONG_LENGTH, machine.process(bytes(0x00, 0xD6, 0x00, 0x00, 0x02, 0x00)))
        // NLEN 은 두 바이트다. 한 바이트짜리 오프셋 0 쓰기는 NLEN 이 될 수 없다.
        assertStatus(ApduStatus.SW_WRONG_LENGTH, updateBinary(0, bytes(0x00)))
    }

    @Test
    fun anUpdateBinaryCarryingNoBodyIsWrongLength() {
        openNdefFile()
        // Lc = 0 은 "0바이트를 쓴다"다. 9000 으로 답하면 리더는 저장됐다고 읽고 다음 단계로 간다.
        assertStatus(ApduStatus.SW_WRONG_LENGTH, machine.process(bytes(0x00, 0xD6, 0x00, 0x02, 0x00)))
        assertStatus(ApduStatus.SW_WRONG_LENGTH, machine.process(bytes(0x00, 0xD6, 0x00, 0x00, 0x00)))
        // 거절이 상태를 더럽히지 않는다: 정상 쓰기가 그대로 된다.
        write(bytes(0x11, 0x22, 0x33))
        assertEquals(1, written.size)
        assertArrayEquals(bytes(0x11, 0x22, 0x33), written[0])
    }

    @Test
    fun aMessageFinishedByItsLastBodyChunkFiresTooWhenTheLengthCameFirst() {
        openNdefFile()
        // 길이를 먼저 적는 리더. 이벤트는 handleUpdateBinary 의 **본문** 갈래에서 난다 —
        // 표준 순서가 쓰는 NLEN 갈래와는 다른 자리다. 두 자리 모두 살아 있어야 한다.
        assertStatus(ApduStatus.SW_OK, updateBinary(0, nlen(3)))
        assertStatus(ApduStatus.SW_OK, updateBinary(2, bytes(0xAA)))
        assertTrue("본문이 아직 모자라다", written.isEmpty())
        assertStatus(ApduStatus.SW_OK, updateBinary(3, bytes(0xBB, 0xCC)))
        assertEquals(1, written.size)
        assertArrayEquals(bytes(0xAA, 0xBB, 0xCC), written[0])
    }
}
