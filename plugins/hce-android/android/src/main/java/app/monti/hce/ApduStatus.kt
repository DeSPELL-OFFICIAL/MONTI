package app.monti.hce

/**
 * ISO 7816-4 상태어(status word). 모든 R-APDU의 마지막 2바이트다.
 *
 * 배열은 공유 싱글턴이므로 **읽기 전용으로만** 쓴다. 응답을 만들 때는 이 배열에 쓰지 말고
 * 데이터 뒤에 복사해 붙인다.
 */
object ApduStatus {
    /** 정상 종료. */
    val SW_OK = byteArrayOf(0x90.toByte(), 0x00)

    /** 선택한 파일이 없다 (SELECT가 모르는 file id를 받았을 때). */
    val SW_FILE_NOT_FOUND = byteArrayOf(0x6A, 0x82.toByte())

    /** 보안 조건 불충족 (아직 SELECT 되지 않은 파일을 읽으려 할 때). */
    val SW_SECURITY = byteArrayOf(0x69, 0x82.toByte())

    /** P1/P2가 틀렸다 — Type 4에서는 오프셋이 파일 밖을 가리킬 때. */
    val SW_WRONG_P1P2 = byteArrayOf(0x6A, 0x86.toByte())

    /** Lc/Le 길이가 틀렸다. */
    val SW_WRONG_LENGTH = byteArrayOf(0x67, 0x00)

    /** INS를 지원하지 않는다 (SELECT/READ BINARY/UPDATE BINARY 외). */
    val SW_INS_NOT_SUPPORTED = byteArrayOf(0x6D, 0x00)

    /** CLA를 지원하지 않는다 (0x00 외). */
    val SW_CLASS_NOT_SUPPORTED = byteArrayOf(0x6E, 0x00)
}
