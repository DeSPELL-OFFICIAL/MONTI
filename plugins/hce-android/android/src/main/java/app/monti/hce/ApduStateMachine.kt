package app.monti.hce

/**
 * NFC Forum Type 4 Tag 상태 기계 — 읽기 경로.
 *
 * 아이폰(Core NFC)이 보내는 순서가 이 파일이 답해야 하는 전부다.
 * ```
 *   00 A4 04 00 07 D2760000850101 00   SELECT AID      → 9000
 *   00 A4 00 0C 02 E103                SELECT CC       → 9000
 *   00 B0 0000 0F                      READ BINARY     → CC 15바이트 + 9000
 *   00 A4 00 0C 02 E104                SELECT NDEF     → 9000
 *   00 B0 0000 02                      READ BINARY     → NLEN 2바이트 + 9000
 *   00 B0 0002 FF                      READ BINARY     → 메시지 255바이트씩 + 9000
 * ```
 *
 * 규칙 네 개가 나머지를 정한다.
 *  1. SELECT AID 응답은 **FCI 없이 9000 두 바이트뿐**이다. FCI를 붙이면 아이폰이 세션을 끊는다.
 *  2. 파일을 고르기 전에는 아무것도 읽을 수 없다(6982).
 *  3. 내보낼 페이로드는 **세션 밖에서만** 바뀐다. 한 번의 탭이 반쪽짜리 메시지를 읽어 가면 안 된다.
 *  4. 응답은 전부 [ApduStatus.respond]가 만든다. 그래서 언제나 새 배열이다.
 *
 * UPDATE BINARY(0xD6, 리더가 게이트 결과를 써 넣는 경로)는 Task 5가 넣는다. 그때까지는
 * 6D00("지원하지 않는 INS")으로 떨어진다 — 받은 바이트를 버리면서 9000을 돌려주는 것보다 정직하다.
 */
class ApduStateMachine(
    /** 리더가 NDEF 파일에 메시지를 다 써 넣었을 때 불린다. 쓰기 경로(Task 5)가 붙이면서 살아난다. */
    private val onMessage: (ByteArray) -> Unit,
) {

    private enum class Selected { NONE, CC, NDEF }

    /** NFC Forum Type 4 Tag 표준 AID (D2 76 00 00 85 01 01). */
    private val aid = byteArrayOf(
        0xD2.toByte(), 0x76, 0x00, 0x00, 0x85.toByte(), 0x01, 0x01,
    )

    private var appSelected = false
    private var selected = Selected.NONE
    private var pendingPayload: ByteArray = ByteArray(0)

    /** 지금 세션이 읽어 가는 NDEF 메시지. 세션 중에는 바뀌지 않는다. */
    var activePayload: ByteArray = ByteArray(0)
        private set

    /**
     * 다음 탭이 내보낼 메시지를 걸어 둔다. 세션이 진행 중이면 그 세션이 끝난 뒤에 승격된다
     * ([onDeactivated] 또는 다음 SELECT AID).
     */
    fun setPendingPayload(ndef: ByteArray) {
        require(ndef.size <= Type4Files.MAX_NDEF_SIZE) {
            "NDEF message is ${ndef.size} bytes; the file declared in the CC holds ${Type4Files.MAX_NDEF_SIZE}"
        }
        pendingPayload = ndef.copyOf()
        if (!appSelected) promotePendingPayload()
    }

    /** 리더가 떠났다. 다음 탭은 새 세션으로 시작한다. */
    fun onDeactivated() {
        appSelected = false
        selected = Selected.NONE
        promotePendingPayload()
    }

    private fun promotePendingPayload() {
        activePayload = pendingPayload.copyOf()
    }

    /** C-APDU 한 개에 R-APDU 한 개로 답한다. */
    fun process(apdu: ByteArray): ByteArray {
        if (apdu.size < 4) return ApduStatus.respond(sw = ApduStatus.SW_WRONG_LENGTH)
        val cla = apdu[0].toInt() and 0xFF
        val ins = apdu[1].toInt() and 0xFF
        if (cla != 0x00) return ApduStatus.respond(sw = ApduStatus.SW_CLASS_NOT_SUPPORTED)
        return when (ins) {
            0xA4 -> handleSelect(apdu)
            0xB0 -> handleReadBinary(apdu)
            else -> ApduStatus.respond(sw = ApduStatus.SW_INS_NOT_SUPPORTED)
        }
    }

    private fun handleSelect(apdu: ByteArray): ByteArray {
        val p1 = apdu[2].toInt() and 0xFF
        val p2 = apdu[3].toInt() and 0xFF
        val lc = if (apdu.size > 4) apdu[4].toInt() and 0xFF else 0
        if (apdu.size < 5 + lc) return ApduStatus.respond(sw = ApduStatus.SW_WRONG_LENGTH)
        val data = apdu.copyOfRange(5, 5 + lc)

        // SELECT by name (AID). 아이폰은 Le 바이트(00)를 뒤에 붙여 보내므로 Lc 뒤는 보지 않는다.
        if (p1 == 0x04 && p2 == 0x00) {
            if (!data.contentEquals(aid)) return ApduStatus.respond(sw = ApduStatus.SW_FILE_NOT_FOUND)
            // 새 세션의 시작. 여기서만 페이로드가 승격된다.
            promotePendingPayload()
            appSelected = true
            selected = Selected.NONE
            return ApduStatus.respond(sw = ApduStatus.SW_OK) // FCI 없음
        }

        // SELECT by file id. 아이폰은 P2 = 0x0C(응답 데이터 없음)로 보낸다.
        if (p1 == 0x00 && p2 == 0x0C) {
            if (!appSelected) return ApduStatus.respond(sw = ApduStatus.SW_SECURITY)
            if (lc != 2) return ApduStatus.respond(sw = ApduStatus.SW_WRONG_LENGTH)
            return when {
                data.contentEquals(Type4Files.CC_FILE_ID) -> {
                    selected = Selected.CC
                    ApduStatus.respond(sw = ApduStatus.SW_OK)
                }
                data.contentEquals(Type4Files.NDEF_FILE_ID) -> {
                    selected = Selected.NDEF
                    ApduStatus.respond(sw = ApduStatus.SW_OK)
                }
                else -> ApduStatus.respond(sw = ApduStatus.SW_FILE_NOT_FOUND)
            }
        }

        return ApduStatus.respond(sw = ApduStatus.SW_WRONG_P1P2)
    }

    private fun currentFile(): ByteArray? = when (selected) {
        Selected.CC -> Type4Files.capabilityContainer()
        Selected.NDEF -> Type4Files.ndefFileBytes(activePayload)
        Selected.NONE -> null
    }

    private fun handleReadBinary(apdu: ByteArray): ByteArray {
        if (!appSelected) return ApduStatus.respond(sw = ApduStatus.SW_SECURITY)
        val file = currentFile() ?: return ApduStatus.respond(sw = ApduStatus.SW_SECURITY)
        // 오프셋은 P1P2 빅엔디언. 406바이트짜리 게이트 레코드는 MLe(255)를 넘으므로
        // 리더가 오프셋을 옮겨 가며 여러 번 읽는다.
        val offset = ((apdu[2].toInt() and 0xFF) shl 8) or (apdu[3].toInt() and 0xFF)
        if (offset > file.size) return ApduStatus.respond(sw = ApduStatus.SW_WRONG_P1P2)
        var le = if (apdu.size > 4) apdu[4].toInt() and 0xFF else 0
        if (le == 0) le = 256
        val length = minOf(le, file.size - offset)
        return ApduStatus.respond(file.copyOfRange(offset, offset + length), ApduStatus.SW_OK)
    }
}
