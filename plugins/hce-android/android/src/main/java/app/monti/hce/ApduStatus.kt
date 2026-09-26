package app.monti.hce

/**
 * ISO 7816-4 상태어(status word)와 R-APDU 조립기.
 *
 * 상태어는 **Int 상수**다. `ByteArray` 상수로 두면 공유 가변 배열이 되고, 응답으로 그대로
 * 내보낸 배열을 호출자가 한 번 고치면 그 자국이 이후 모든 탭에 남는다. Kotlin에는 불변
 * `ByteArray`가 없으므로 타입이 그걸 막아 주지 않는다 — 아예 배열을 두지 않는 쪽을 택했다.
 *
 * 응답은 언제나 [respond]가 새로 만든다. 상태 기계의 유일한 응답 조립 지점이다.
 */
object ApduStatus {
    /** 정상 종료. */
    const val SW_OK = 0x9000

    /** 선택한 파일이 없다 (SELECT가 모르는 file id나 AID를 받았을 때). */
    const val SW_FILE_NOT_FOUND = 0x6A82

    /** 보안 조건 불충족 (아직 SELECT 되지 않은 파일을 읽으려 할 때). */
    const val SW_SECURITY = 0x6982

    /** P1/P2가 틀렸다 — Type 4에서는 오프셋이 파일 밖을 가리킬 때. */
    const val SW_WRONG_P1P2 = 0x6A86

    /** Lc/Le 길이가 틀렸다. */
    const val SW_WRONG_LENGTH = 0x6700

    /** INS를 지원하지 않는다 (SELECT/READ BINARY 외). */
    const val SW_INS_NOT_SUPPORTED = 0x6D00

    /** CLA를 지원하지 않는다 (0x00 외). */
    const val SW_CLASS_NOT_SUPPORTED = 0x6E00

    /** 데이터 없는 응답. 길이가 0이라 고칠 원소가 없으므로 나눠 써도 안전하다. */
    val EMPTY = ByteArray(0)

    /**
     * R-APDU 한 통을 만든다: `data || SW1 || SW2` (상태어는 빅엔디언).
     *
     * 언제나 **새 배열**을 돌려준다. 상태어가 Int이고 조립이 여기 한 곳뿐이라,
     * 공유 배열이 호출자 손에 넘어갈 자리가 없다.
     */
    fun respond(data: ByteArray = EMPTY, sw: Int): ByteArray {
        val out = ByteArray(data.size + 2)
        data.copyInto(out)
        out[data.size] = ((sw shr 8) and 0xFF).toByte()
        out[data.size + 1] = (sw and 0xFF).toByte()
        return out
    }
}
