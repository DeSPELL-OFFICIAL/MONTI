package app.monti.hce

/**
 * NFC Forum Type 4 Tag (mapping version 2.0) 파일 모델.
 *
 * 태그는 파일 두 개로 이루어진다. Capability Container(E103)는 리더가 가장 먼저 읽는
 * 15바이트 고정 서술자이고, NDEF 파일(E104)은 실제 메시지를 담는다.
 *
 * CC 15바이트 배치:
 * ```
 *   000F      CCLEN         — CC 자신의 길이
 *   20        mapping 2.0
 *   00FF      MLe           — READ BINARY 한 번에 돌려줄 수 있는 최대 바이트
 *   00FF      MLc           — UPDATE BINARY 한 번에 받을 수 있는 최대 바이트
 *   04 06     NDEF File Control TLV: T=04, L=06
 *   E104      NDEF 파일 id
 *   0800      NDEF 파일 최대 크기 = 2048 (NLEN 2바이트 포함)
 *   00        read access  — 자유
 *   00        write access — 자유 (리더가 게이트 결과를 써 넣는다)
 * ```
 */
object Type4Files {
    /** Capability Container 파일 id. */
    val CC_FILE_ID = byteArrayOf(0xE1.toByte(), 0x03)

    /** NDEF 파일 id. CC의 TLV가 가리키는 값과 같아야 한다. */
    val NDEF_FILE_ID = byteArrayOf(0xE1.toByte(), 0x04)

    /**
     * CC가 선언하는 MLe — READ BINARY 한 번에 돌려줄 수 있는 최대 바이트.
     *
     * [capabilityContainer]의 인덱스 3~4(`00FF`)와 같은 값이어야 한다. 리더는 CC를 먼저 읽고
     * 그 선언만큼만 요구하므로, R-APDU가 이걸 넘기면 T4T 적합성 시험이 지적한다. ISO 7816-4
     * 단축 APDU의 "Le = 0 은 256" 규약이 여기에 걸린다 — 그 자리는 256이 아니라 이 값이다.
     */
    const val MLE = 255

    /**
     * CC에 적는 NDEF **파일** 최대 크기. 스펙(T4T 2.0 §5.1.2)상 이 값은 NLEN 2바이트를
     * 포함한 파일 전체 크기이므로, 리더는 이만큼만 버퍼를 잡는다.
     */
    const val NDEF_FILE_SIZE = 2048

    /**
     * NDEF **메시지** 최대 길이 = 파일 크기 - NLEN 2바이트.
     *
     * 게이트 QR이 나르는 CBOR은 400바이트 안팎이고, 그 크기면 NDEF 레코드 헤더가
     * short record가 아닌 long form(`0xC4`, 4바이트 payload length)으로 붙어 레코드가
     * 420바이트 근처가 된다. 2046은 그보다 한참 크다.
     */
    const val MAX_NDEF_SIZE = NDEF_FILE_SIZE - 2

    /** 항상 같은 15바이트를 새로 만들어 돌려준다(호출자가 고쳐도 다음 호출에 영향이 없다). */
    fun capabilityContainer(): ByteArray = byteArrayOf(
        0x00, 0x0F,                                      // CCLEN
        0x20,                                            // mapping version 2.0
        0x00, 0xFF.toByte(),                             // MLe
        0x00, 0xFF.toByte(),                             // MLc
        0x04, 0x06,                                      // NDEF File Control TLV: T, L
        0xE1.toByte(), 0x04,                             // NDEF file id
        ((NDEF_FILE_SIZE shr 8) and 0xFF).toByte(),      // 파일 최대 크기 상위
        (NDEF_FILE_SIZE and 0xFF).toByte(),              // 파일 최대 크기 하위
        0x00,                                            // read access: 자유
        0x00,                                            // write access: 자유
    )

    /**
     * NDEF 파일 한 통을 만든다: NLEN(빅엔디언 2바이트) + 메시지.
     * 빈 메시지는 `0000` 두 바이트다 — 리더는 이걸 "아직 쓸 내용 없음"으로 읽는다.
     */
    fun ndefFileBytes(message: ByteArray): ByteArray {
        require(message.size <= MAX_NDEF_SIZE) {
            "NDEF message is ${message.size} bytes; the file declared in the CC holds $MAX_NDEF_SIZE"
        }
        val out = ByteArray(message.size + 2)
        out[0] = ((message.size shr 8) and 0xFF).toByte()
        out[1] = (message.size and 0xFF).toByte()
        message.copyInto(out, 2)
        return out
    }
}
