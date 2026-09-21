package app.monti.hce

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 같은 벡터가 `plugins/hce-android/src/type4.test.ts`에도 있다. 이 기계에는 Android SDK가
 * 없어 이 파일은 컴파일되지 않으므로, TS 쪽이 그 벡터를 오늘 실행해 준다.
 */
class Type4FilesTest {

    private fun hex(bytes: ByteArray): String =
        bytes.joinToString("") { String.format("%02X", it.toInt() and 0xFF) }

    @Test
    fun capabilityContainerIsExactlyFifteenBytes() {
        assertEquals(15, Type4Files.capabilityContainer().size)
    }

    @Test
    fun capabilityContainerMatchesTheNfcForumLayout() {
        // CCLEN 000F | mapping 20 | MLe 00FF | MLc 00FF | TLV 04 06 E104 0800 00 00
        assertEquals("000F2000FF00FF0406E10408000000", hex(Type4Files.capabilityContainer()))
    }

    @Test
    fun capabilityContainerIsAFreshArrayEveryCall() {
        // Task 4가 이 배열을 응답 버퍼로 그대로 넘긴다. 공유 싱글턴이 되면 한 번의 실수가
        // 이후 모든 탭에 남는다.
        assertNotSame(Type4Files.capabilityContainer(), Type4Files.capabilityContainer())
    }

    @Test
    fun fileIdsAndDeclaredSizesAreTheSpecifiedOnes() {
        assertArrayEquals(byteArrayOf(0xE1.toByte(), 0x03), Type4Files.CC_FILE_ID)
        assertArrayEquals(byteArrayOf(0xE1.toByte(), 0x04), Type4Files.NDEF_FILE_ID)
        assertEquals(2048, Type4Files.NDEF_FILE_SIZE)
        // 메시지 한도는 파일 크기에서 NLEN 2바이트를 뺀 값이다 (T4T 2.0 §5.1.2).
        assertEquals(2046, Type4Files.MAX_NDEF_SIZE)
        assertEquals(Type4Files.NDEF_FILE_SIZE - 2, Type4Files.MAX_NDEF_SIZE)
    }

    @Test
    fun ndefFileIsNlenPrefixedBigEndian() {
        val message = ByteArray(300) { 0x41 }
        val file = Type4Files.ndefFileBytes(message)
        assertEquals(302, file.size)
        assertEquals("012C", hex(file.copyOfRange(0, 2)))
        assertEquals(0x41, file[2].toInt())
        assertEquals(0x41, file[301].toInt())
    }

    @Test
    fun emptyNdefFileIsTwoZeroBytes() {
        assertArrayEquals(byteArrayOf(0x00, 0x00), Type4Files.ndefFileBytes(ByteArray(0)))
    }

    @Test
    fun ndefFileHoldsALongFormGateRecordAndStopsAtTheDeclaredFileSize() {
        // 실제 게이트 코드는 ~389바이트 CBOR이라 NDEF 레코드가 long form 헤더(0xC4)로 붙어
        // 420바이트 언저리가 된다. 선언한 파일 크기가 그걸 여유 있게 담는지 못 박는다.
        val gateRecord = ByteArray(420) { 0xC4.toByte() }
        val file = Type4Files.ndefFileBytes(gateRecord)
        assertEquals(422, file.size)
        assertEquals("01A4", hex(file.copyOfRange(0, 2)))
        assertTrue(Type4Files.MAX_NDEF_SIZE >= 420)

        // 경계: 2046은 들어가고 2047은 파일을 넘긴다.
        assertEquals(2048, Type4Files.ndefFileBytes(ByteArray(2046)).size)
        assertEquals("07FE", hex(Type4Files.ndefFileBytes(ByteArray(2046)).copyOfRange(0, 2)))
        assertThrows(IllegalArgumentException::class.java) {
            Type4Files.ndefFileBytes(ByteArray(2047))
        }
    }

    @Test
    fun statusWordsAreTheIso7816Values() {
        assertEquals(0x9000, ApduStatus.SW_OK)
        assertEquals(0x6A82, ApduStatus.SW_FILE_NOT_FOUND)
        assertEquals(0x6982, ApduStatus.SW_SECURITY)
        assertEquals(0x6A86, ApduStatus.SW_WRONG_P1P2)
        assertEquals(0x6700, ApduStatus.SW_WRONG_LENGTH)
        assertEquals(0x6D00, ApduStatus.SW_INS_NOT_SUPPORTED)
        assertEquals(0x6E00, ApduStatus.SW_CLASS_NOT_SUPPORTED)
    }

    @Test
    fun respondAppendsTheStatusWordBigEndianToAFreshArray() {
        // 데이터 없는 응답은 상태어 두 바이트뿐이다 — SELECT 가 FCI 없이 답하는 모양이다.
        assertEquals("9000", hex(ApduStatus.respond(sw = ApduStatus.SW_OK)))
        assertEquals("6A82", hex(ApduStatus.respond(sw = ApduStatus.SW_FILE_NOT_FOUND)))
        // 데이터가 있으면 그 뒤에 붙는다.
        assertEquals(
            "0102039000",
            hex(ApduStatus.respond(byteArrayOf(0x01, 0x02, 0x03), ApduStatus.SW_OK)),
        )
        assertEquals(0, ApduStatus.EMPTY.size)

        // 매번 새 배열이다. 하나를 고쳐도 다음 응답에는 남지 않는다.
        val first = ApduStatus.respond(sw = ApduStatus.SW_OK)
        val second = ApduStatus.respond(sw = ApduStatus.SW_OK)
        assertNotSame(first, second)
        first[0] = 0x00
        assertEquals("9000", hex(ApduStatus.respond(sw = ApduStatus.SW_OK)))
    }
}
