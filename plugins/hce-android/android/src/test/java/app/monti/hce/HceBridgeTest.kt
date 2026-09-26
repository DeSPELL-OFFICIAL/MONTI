package app.monti.hce

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Before
import org.junit.Test

/**
 * [HceBridge] — OS 가 만드는 서비스와 WebView 가 만드는 플러그인이 만나는 한 점.
 *
 * 싱글턴이라 테스트끼리 상태를 나눠 쓴다. 매 테스트가 [HceBridge.reset] 으로 시작하고 콜백을
 * 떼고 끝나는 이유가 그것이다 — 실제 앱에서도 `stop()` 이 같은 일을 한다.
 */
class HceBridgeTest {

    private fun bytes(vararg v: Int): ByteArray = ByteArray(v.size) { v[it].toByte() }

    private fun hex(b: ByteArray): String = b.joinToString("") { String.format("%02X", it.toInt() and 0xFF) }

    private fun assertStatus(expected: Int, response: ByteArray) {
        assertEquals(String.format("%04X", expected), hex(response))
    }

    private val selectAid = bytes(0x00, 0xA4, 0x04, 0x00, 0x07, 0xD2, 0x76, 0x00, 0x00, 0x85, 0x01, 0x01, 0x00)
    private val selectNdef = bytes(0x00, 0xA4, 0x00, 0x0C, 0x02, 0xE1, 0x04)

    /** monti.app:g 레코드, 페이로드 1바이트. */
    private val gateCode = bytes(
        0xD4, 0x0B, 0x01,
        0x6D, 0x6F, 0x6E, 0x74, 0x69, 0x2E, 0x61, 0x70, 0x70, 0x3A, 0x67,
        0x01,
    )

    @Before
    fun clearTheBridge() {
        HceBridge.onWrite = null
        HceBridge.reset()
    }

    @Test
    fun aWrittenMessageReachesTheRegisteredListener() {
        val seen = mutableListOf<ByteArray>()
        HceBridge.onWrite = { seen.add(it) }
        HceBridge.setPayload(gateCode)
        assertStatus(ApduStatus.SW_OK, HceBridge.machine.process(selectAid))
        assertStatus(ApduStatus.SW_OK, HceBridge.machine.process(selectNdef))
        assertStatus(ApduStatus.SW_OK, HceBridge.machine.process(bytes(0x00, 0xD6, 0x00, 0x00, 0x02, 0x00, 0x00)))
        assertStatus(ApduStatus.SW_OK, HceBridge.machine.process(bytes(0x00, 0xD6, 0x00, 0x02, 0x03, 0x11, 0x22, 0x33)))
        assertStatus(ApduStatus.SW_OK, HceBridge.machine.process(bytes(0x00, 0xD6, 0x00, 0x00, 0x02, 0x00, 0x03)))
        assertEquals(1, seen.size)
        assertArrayEquals(bytes(0x11, 0x22, 0x33), seen[0])
        HceBridge.onWrite = null
    }

    @Test
    fun setPayloadIsWhatTheReaderReadsBack() {
        HceBridge.setPayload(gateCode)
        assertStatus(ApduStatus.SW_OK, HceBridge.machine.process(selectAid))
        assertStatus(ApduStatus.SW_OK, HceBridge.machine.process(selectNdef))
        // NLEN = 15, 그리고 레코드 15바이트.
        assertEquals("000F9000", hex(HceBridge.machine.process(bytes(0x00, 0xB0, 0x00, 0x00, 0x02))))
        assertEquals("${hex(gateCode)}9000", hex(HceBridge.machine.process(bytes(0x00, 0xB0, 0x00, 0x02, 0x0F))))
    }

    @Test
    fun resetClearsThePayloadSoAStoppedGateEmitsNothing() {
        HceBridge.setPayload(bytes(0xD4, 0x01, 0x00, 0x67))
        HceBridge.reset()
        assertEquals(0, HceBridge.machine.activePayload.size)
        // 멈춘 게이트에 붙은 리더는 빈 NDEF 파일을 읽는다 — 지난 코드가 아니라.
        assertStatus(ApduStatus.SW_OK, HceBridge.machine.process(selectAid))
        assertStatus(ApduStatus.SW_OK, HceBridge.machine.process(selectNdef))
        assertEquals("00009000", hex(HceBridge.machine.process(bytes(0x00, 0xB0, 0x00, 0x00, 0x02))))
    }

    @Test
    fun withNoListenerAWriteIsDroppedWithoutThrowing() {
        HceBridge.onWrite = null
        assertStatus(ApduStatus.SW_OK, HceBridge.machine.process(selectAid))
        assertStatus(ApduStatus.SW_OK, HceBridge.machine.process(selectNdef))
        // 완성된 메시지가 갈 곳이 없다. 조용히 버려지고 리더에게는 9000 이 간다.
        assertStatus(ApduStatus.SW_OK, HceBridge.machine.process(bytes(0x00, 0xD6, 0x00, 0x00, 0x03, 0x00, 0x01, 0x42)))
        assertNull(HceBridge.onWrite)
    }

    @Test
    fun theMachineOutlivesTheTapThatUsedIt() {
        // 서비스는 탭마다 만들어졌다 파괴된다(onDeactivated 가 그 끝이다). 걸어 둔 코드가
        // 그때마다 사라지면 게이트는 첫 탭 뒤로 빈 태그가 된다.
        HceBridge.setPayload(gateCode)
        val first = HceBridge.machine
        HceBridge.machine.process(selectAid)
        HceBridge.machine.onDeactivated()
        assertSame(first, HceBridge.machine)
        assertArrayEquals(gateCode, HceBridge.machine.activePayload)
        // 여기서 MontiHostApduService 를 새로 만들어 보지 않는 이유: Service 생성자는 순수
        // JVM 유닛 테스트의 android.jar 스텁에서 터진다. 서비스가 브리지를 어떻게 쓰는지는
        // src/apduService.test.ts 가 원본 핀으로 본다.
    }
}
