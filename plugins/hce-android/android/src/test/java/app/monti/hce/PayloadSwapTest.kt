package app.monti.hce

import java.io.File
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 불변식 하나만 지키는 파일이다.
 *
 * > **세션 중에 [ApduStateMachine.setPendingPayload] 를 불러도, 지금 읽히고 있는 바이트는
 * > 절대 바뀌지 않는다. 교체는 [ApduStateMachine.onDeactivated] 또는 다음 SELECT AID 에서만
 * > 일어난다.**
 *
 * Task 18의 3초 회전 루프가 이 보장 위에 선다. 회전 타이머는 리더가 붙어 있는지 모르는 채
 * 3초마다 새 게이트 코드를 밀어 넣는데, 그게 진행 중인 탭에 보이면 관객 폰은 앞 절반이 A,
 * 뒤 절반이 B인 메시지를 읽어 간다 — NLEN 은 A의 길이인데 본문은 B라, 길이가 다르면 레코드가
 * 잘리고 같으면 서명이 깨진다. 어느 쪽이든 게이트에서 "다시 태그해 주세요"가 되고, 원인은
 * 로그에 남지 않는다.
 *
 * 승격은 **정확히 세 곳**에서만 일어난다.
 *  1. [ApduStateMachine.setPendingPayload] — 세션이 없을 때(`!appSelected`)만
 *  2. SELECT AID — 새 세션의 시작 (링크가 끊겨 `onDeactivated` 가 오지 못한 경우가 여기 걸린다)
 *  3. [ApduStateMachine.onDeactivated] — 리더가 떠났을 때
 *
 * 같은 벡터가 `plugins/hce-android/src/apduVectors.test.ts` 의 §when the payload changes 에도
 * 있다. 이 기계에는 Android SDK 가 없어 이 파일은 아직 컴파일된 적이 없으므로, 그 TS 파일이
 * 같은 요청/응답 벡터를 오늘 실행해 준다.
 */
class PayloadSwapTest {

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

    private val selectAid = bytes(0x00, 0xA4, 0x04, 0x00, 0x07, 0xD2, 0x76, 0x00, 0x00, 0x85, 0x01, 0x01, 0x00)
    private val selectNdef = bytes(0x00, 0xA4, 0x00, 0x0C, 0x02, 0xE1, 0x04)

    /**
     * monti.app:g 외부 타입 레코드, 페이로드 한 바이트. 레코드는 15바이트이고 **마지막 인덱스
     * 14가 그 한 바이트**다 — 어느 코드를 읽어 갔는지가 그 자리 하나로 보인다.
     */
    private fun record(tag: Int): ByteArray = bytes(
        0xD4, 0x0B, 0x01, // MB|ME|SR|TNF=4(external), TYPE_LENGTH=11, PAYLOAD_LENGTH=1
        0x6D, 0x6F, 0x6E, 0x74, 0x69, 0x2E, 0x61, 0x70, 0x70, 0x3A, 0x67, // "monti.app:g"
        tag,
    )

    /**
     * 진짜 게이트 코드의 모양: ~389바이트 CBOR 이 실리면 SR 비트가 꺼져 헤더가 long form
     * (`0xC4` + 4바이트 payload length)이 되고 레코드가 406바이트가 된다. MLe(255)를 넘으므로
     * 리더가 창을 옮겨 가며 **여러 번** 읽는다 — 회전 타이머가 끼어들 틈이 그 사이다.
     */
    private fun gateRecord(tag: Int, payloadSize: Int = 389): ByteArray {
        val type = "monti.app:g".toByteArray(Charsets.US_ASCII)
        val record = ByteArray(6 + type.size + payloadSize)
        record[0] = 0xC4.toByte()
        record[1] = type.size.toByte()
        record[2] = ((payloadSize shr 24) and 0xFF).toByte()
        record[3] = ((payloadSize shr 16) and 0xFF).toByte()
        record[4] = ((payloadSize shr 8) and 0xFF).toByte()
        record[5] = (payloadSize and 0xFF).toByte()
        type.copyInto(record, 6)
        // 코드마다 다른 바이트로 채운다. 창이 어긋나거나 섞이면 눈에 띈다.
        for (i in 0 until payloadSize) record[6 + type.size + i] = ((i + tag) and 0xFF).toByte()
        return record
    }

    private fun readBinary(m: ApduStateMachine, offset: Int, le: Int): ByteArray =
        m.process(bytes(0x00, 0xB0, (offset shr 8) and 0xFF, offset and 0xFF, le))

    /** 리더가 하는 일: NDEF 파일을 고르고, NLEN 을 읽고, 그 길이만큼 본문을 읽는다. */
    private fun readMessage(m: ApduStateMachine): ByteArray {
        assertStatus(ApduStatus.SW_OK, m.process(selectNdef))
        val header = readBinary(m, 0, 2)
        assertTrailingStatus(ApduStatus.SW_OK, header)
        val len = ((header[0].toInt() and 0xFF) shl 8) or (header[1].toInt() and 0xFF)
        val body = readBinary(m, 2, len)
        assertTrailingStatus(ApduStatus.SW_OK, body)
        return body.copyOfRange(0, len)
    }

    /** MLe 보다 큰 파일을 리더처럼 창을 옮겨 가며 끝까지 읽는다. */
    private fun readWindow(m: ApduStateMachine, offset: Int, le: Int): ByteArray {
        val r = readBinary(m, offset, le)
        assertTrailingStatus(ApduStatus.SW_OK, r)
        return r.copyOfRange(0, r.size - 2)
    }

    // ── 브리핑이 요구한 여섯 ────────────────────────────────────────────────

    @Test
    fun aPayloadSetMidSessionIsNotVisibleUntilTheNextSession() {
        val m = ApduStateMachine { }
        m.setPendingPayload(record(0xA1))
        assertStatus(ApduStatus.SW_OK, m.process(selectAid))
        assertArrayEquals(record(0xA1), readMessage(m))

        // 회전 타이머가 세션 한가운데서 새 코드를 넣는다.
        m.setPendingPayload(record(0xB2))
        assertArrayEquals(record(0xA1), readMessage(m))
        assertArrayEquals(record(0xA1), m.activePayload)
    }

    @Test
    fun deactivationPromotesThePendingPayload() {
        val m = ApduStateMachine { }
        m.setPendingPayload(record(0xA1))
        m.process(selectAid)
        m.setPendingPayload(record(0xB2))
        m.onDeactivated()
        assertArrayEquals(record(0xB2), m.activePayload)
    }

    @Test
    fun aNewSelectAidPromotesThePendingPayloadEvenWithoutDeactivation() {
        val m = ApduStateMachine { }
        m.setPendingPayload(record(0xA1))
        m.process(selectAid)
        m.setPendingPayload(record(0xB2))
        // 아이폰이 세션을 끊었다는 콜백 없이 다시 붙은 경우 — 링크 로스면 onDeactivated 가 없다.
        assertStatus(ApduStatus.SW_OK, m.process(selectAid))
        assertArrayEquals(record(0xB2), readMessage(m))
    }

    @Test
    fun rotatingWhileIdlePromotesImmediately() {
        val m = ApduStateMachine { }
        m.setPendingPayload(record(0xA1))
        assertArrayEquals(record(0xA1), m.activePayload)
        m.setPendingPayload(record(0xB2))
        assertArrayEquals(record(0xB2), m.activePayload)
    }

    @Test
    fun settingAPayloadDoesNotAliasTheCallersArray() {
        val m = ApduStateMachine { }
        val mutable = record(0xA1)
        m.setPendingPayload(mutable)
        mutable[14] = 0xFF.toByte() // 레코드는 15바이트, 마지막 인덱스가 페이로드다
        assertEquals(0xA1, m.activePayload[14].toInt() and 0xFF)
    }

    @Test
    fun anOversizedPayloadIsRejectedLoudly() {
        val m = ApduStateMachine { }
        // 조용히 자르면 관객 폰이 잘린 CBOR 을 검증하러 간다. 부르는 쪽에서 터지는 게 낫다.
        assertThrows(IllegalArgumentException::class.java) {
            m.setPendingPayload(ByteArray(Type4Files.MAX_NDEF_SIZE + 1))
        }
        assertEquals(0, m.activePayload.size)
    }

    @Test
    fun everyWayIntoTheStateMachineIsLocked() {
        // 두 스레드가 이 상태를 같이 쓴다: process 는 앱 메인 스레드로, setPendingPayload 는
        // Capacitor 의 CapacitorPlugins 핸들러 스레드로 들어온다. 잠그지 않으면 회전 스레드가
        // 낡은 appSelected 를 보고 탭 **한가운데서** 승격할 수 있다 — 이 파일의 다른 열
        // 테스트는 전부 한 스레드라 그 경로를 하나도 보지 못한다.
        val text = File("src/main/java/app/monti/hce/ApduStateMachine.kt").readText()
        val entries = Regex("(@Synchronized\\s+)?(private\\s+)?fun\\s+([A-Za-z0-9_]+)\\s*\\(")
            .findAll(text)
            .filter { it.groupValues[2].isEmpty() }
            .toList()
        assertEquals(
            listOf("onDeactivated", "process", "setPendingPayload"),
            entries.map { it.groupValues[3] }.sorted(),
        )
        for (entry in entries) {
            assertTrue("잠기지 않은 진입점: ${entry.groupValues[3]}", entry.groupValues[1].isNotEmpty())
        }
        // 그리고 내보내는 배열은 안전하게 공개된다 — 다 채운 뒤 volatile 필드에 대입한다.
        assertTrue(text.contains("@Volatile"))
        assertTrue(text.contains("var activePayload: ByteArray = ByteArray(0)"))
    }

    // ── 컨트롤러가 더 요구한 넷 ─────────────────────────────────────────────

    @Test
    fun aSwapMidReadWindowLeavesEveryLaterWindowOnTheOldBytes() {
        val old = gateRecord(0x00)
        val new = gateRecord(0x40)
        assertEquals(406, old.size) // MLe 하나에 안 들어간다 — 그래서 창이 여러 개다
        val m = ApduStateMachine { }
        m.setPendingPayload(old)
        assertStatus(ApduStatus.SW_OK, m.process(selectAid))
        assertStatus(ApduStatus.SW_OK, m.process(selectNdef))

        val header = readWindow(m, 0, 2)
        assertEquals("0196", hex(header)) // NLEN = 406

        val first = readWindow(m, 2, 0xFF) // 레코드 0..254
        assertEquals(255, first.size)

        // 창과 창 사이에서 회전 타이머가 돈다. 남은 창들은 여전히 옛 바이트여야 한다.
        m.setPendingPayload(new)

        val second = readWindow(m, 257, 0xFF) // 레코드 255..405
        assertEquals(151, second.size)
        assertArrayEquals(old, first + second)
        // 길이 선언도 그대로다. 이게 바뀌면 리더가 파일 밖을 읽으러 간다.
        assertEquals("0196", hex(readWindow(m, 0, 2)))
        assertArrayEquals(old, m.activePayload)
    }

    @Test
    fun theSwapIsVisibleOnTheNextSessionsFirstRead() {
        val m = ApduStateMachine { }
        m.setPendingPayload(record(0xA1))
        assertStatus(ApduStatus.SW_OK, m.process(selectAid))
        assertArrayEquals(record(0xA1), readMessage(m))

        m.setPendingPayload(gateRecord(0x11))
        m.onDeactivated()

        // 다음 탭의 **첫** 읽기부터 새 코드다 — NLEN 이 이미 406을 말한다.
        assertStatus(ApduStatus.SW_OK, m.process(selectAid))
        assertStatus(ApduStatus.SW_OK, m.process(selectNdef))
        assertEquals("0196", hex(readWindow(m, 0, 2)))
        assertArrayEquals(gateRecord(0x11), readWindow(m, 2, 0xFF) + readWindow(m, 257, 0xFF))
    }

    @Test
    fun theLastSwapBeforeDeactivationWins() {
        val m = ApduStateMachine { }
        m.setPendingPayload(record(0xA1))
        assertStatus(ApduStatus.SW_OK, m.process(selectAid))
        // 탭 하나가 3초보다 오래 걸리면 회전이 두 번 돈다. 중간 코드는 아무도 보지 않는다.
        m.setPendingPayload(record(0xB2))
        m.setPendingPayload(record(0xC3))
        assertArrayEquals(record(0xA1), readMessage(m))

        m.onDeactivated()
        assertArrayEquals(record(0xC3), m.activePayload)
        assertStatus(ApduStatus.SW_OK, m.process(selectAid))
        assertArrayEquals(record(0xC3), readMessage(m))
    }

    @Test
    fun aSwapDoesNotDisturbTheMessageBeingWritten() {
        val written = mutableListOf<ByteArray>()
        val m = ApduStateMachine { written.add(it) }
        m.setPendingPayload(record(0xA1))
        assertStatus(ApduStatus.SW_OK, m.process(selectAid))
        assertStatus(ApduStatus.SW_OK, m.process(selectNdef))

        // 리더가 서명한 응답을 써 넣는 중이다: NLEN 0 → 본문 → 진짜 NLEN.
        assertStatus(ApduStatus.SW_OK, m.process(bytes(0x00, 0xD6, 0x00, 0x00, 0x02, 0x00, 0x00)))
        assertStatus(ApduStatus.SW_OK, m.process(bytes(0x00, 0xD6, 0x00, 0x02, 0x03, 0x11, 0x22, 0x33)))

        // 그 사이에 회전 타이머가 돈다. 쓰기 버퍼는 읽기 페이로드와 아무 상관이 없다.
        m.setPendingPayload(record(0xB2))
        assertEquals(0, written.size)

        assertStatus(ApduStatus.SW_OK, m.process(bytes(0x00, 0xD6, 0x00, 0x00, 0x02, 0x00, 0x03)))
        assertEquals(1, written.size)
        assertArrayEquals(bytes(0x11, 0x22, 0x33), written[0])
        // 그리고 읽기 쪽은 여전히 옛 코드다.
        assertArrayEquals(record(0xA1), m.activePayload)
    }
}
