package app.monti.hce

/**
 * NFC Forum Type 4 Tag 상태 기계 — 읽기 경로와 쓰기 경로.
 *
 * 아이폰(Core NFC)이 보내는 순서가 이 파일이 답해야 하는 전부다. 앞의 여섯 줄이 게이트 코드를
 * 읽어 가는 길이고, 뒤의 세 줄이 서명한 응답을 같은 파일에 써 넣는 길이다.
 * ```
 *   00 A4 04 00 07 D2760000850101 00   SELECT AID      → 9000
 *   00 A4 00 0C 02 E103                SELECT CC       → 9000
 *   00 B0 0000 0F                      READ BINARY     → CC 15바이트 + 9000
 *   00 A4 00 0C 02 E104                SELECT NDEF     → 9000
 *   00 B0 0000 02                      READ BINARY     → NLEN 2바이트 + 9000
 *   00 B0 0002 FF                      READ BINARY     → 메시지 255바이트씩 + 9000
 *   00 D6 0000 02 0000                 UPDATE BINARY   → 9000   NLEN 을 0 으로 (파일을 비운다)
 *   00 D6 0002 xx <본문 조각>          UPDATE BINARY   → 9000   본문을 MLc 만큼씩
 *   00 D6 0000 02 00B0                 UPDATE BINARY   → 9000   NLEN 을 실제 길이로 (여기서 완성)
 * ```
 *
 * 규칙 다섯 개가 나머지를 정한다.
 *  1. SELECT AID 응답은 **FCI 없이 9000 두 바이트뿐**이다. FCI를 붙이면 아이폰이 세션을 끊는다.
 *  2. 파일을 고르기 전에는 아무것도 읽거나 쓸 수 없다(6982).
 *  3. 내보낼 페이로드는 **세션 밖에서만** 바뀐다. 한 번의 탭이 반쪽짜리 메시지를 읽어 가면 안 된다.
 *  4. 응답은 전부 [ApduStatus.respond]가 만든다. 그래서 언제나 새 배열이다.
 *  5. [onMessage]는 **완성된 메시지 하나마다 정확히 한 번** 불린다. NLEN 이 마지막에 쓰이고,
 *     그 NLEN 이 말하는 길이만큼의 바이트가 **앞에서부터 빠짐없이** 모였을 때만 완성이다.
 *     끊긴 쓰기는 조용히 버려진다 — 게이트가 반쪽짜리 서명을 검증하러 가는 것보다 낫다.
 */
class ApduStateMachine(
    /** 리더가 NDEF 파일에 메시지를 다 써 넣었을 때, 그 메시지 하나마다 한 번 불린다. */
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

    /** 리더가 써 넣는 중인 메시지. 파일 오프셋 0·1은 NLEN 이므로 여기 인덱스는 `offset - 2`다. */
    private val writeBuffer = ByteArray(Type4Files.MAX_NDEF_SIZE)

    /**
     * [writeBuffer]에서 실제로 쓰인 자리. 리더가 창을 건너뛰며 써도(조각 순서가 뒤바뀌어도)
     * 어디가 채워졌는지는 이 표만 안다. "지금까지 본 가장 먼 오프셋"으로 세면 가운데 구멍을
     * 구별하지 못해 절반짜리 메시지를 완성으로 착각한다.
     */
    private val writtenBytes = BooleanArray(Type4Files.MAX_NDEF_SIZE)

    /** [writtenBytes]가 0부터 끊기지 않고 이어진 길이. 이 값이 NLEN 에 닿아야 완성이다. */
    private var completePrefix = 0

    /** 마지막으로 받은 NLEN. 0이면 아직 길이를 모른다 — 리더가 파일을 비운 직후다. */
    private var declaredLength = 0

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

    /** 리더가 떠났다. 다음 탭은 새 세션으로 시작한다. 쓰다 만 메시지는 여기서 버려진다. */
    fun onDeactivated() {
        appSelected = false
        selected = Selected.NONE
        resetWriteState()
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
            0xD6 -> handleUpdateBinary(apdu)
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
            // 새 세션의 시작. 여기서만 페이로드가 승격된다. 링크가 끊겨 onDeactivated 가 오지
            // 못했을 수 있으므로, 지난 탭이 쓰다 만 메시지도 여기서 함께 버린다.
            promotePendingPayload()
            resetWriteState()
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
        // ISO 7816-4 단축 APDU에서 Le = 0 은 256을 뜻하지만, CC가 선언한 MLe 는 255다.
        // 선언한 것보다 많이 돌려주면 T4T 적합성 시험이 지적한다.
        var le = if (apdu.size > 4) apdu[4].toInt() and 0xFF else 0
        if (le == 0) le = Type4Files.MLE
        val length = minOf(le, file.size - offset)
        return ApduStatus.respond(file.copyOfRange(offset, offset + length), ApduStatus.SW_OK)
    }

    /**
     * 리더가 NDEF 파일에 써 넣는다. 파일 배치가 `NLEN(2바이트) || 메시지`이므로 오프셋 0은
     * 길이 선언이고 오프셋 2부터가 본문이다.
     *
     * T4T 2.0 쓰기 절차는 **NLEN 을 마지막에** 쓴다: 먼저 `0000` 으로 파일을 비우고, 본문을
     * MLc 만큼씩 나눠 쓰고, 다 됐을 때 실제 길이를 NLEN 에 적는다. 그래서 "완성"은 NLEN 이
     * 0 이 아니고 그 길이만큼 앞에서부터 빠짐없이 채워졌을 때다 — 그 순간에만 [onMessage]가
     * 불린다. 안드로이드 리더처럼 NLEN 과 본문을 한 APDU 로 보내는 쪽도 같은 판정으로 통과한다.
     */
    private fun handleUpdateBinary(apdu: ByteArray): ByteArray {
        if (!appSelected) return ApduStatus.respond(sw = ApduStatus.SW_SECURITY)
        if (selected != Selected.NDEF) return ApduStatus.respond(sw = ApduStatus.SW_SECURITY)
        val lc = if (apdu.size > 4) apdu[4].toInt() and 0xFF else 0
        if (apdu.size < 5 + lc) return ApduStatus.respond(sw = ApduStatus.SW_WRONG_LENGTH)
        val offset = ((apdu[2].toInt() and 0xFF) shl 8) or (apdu[3].toInt() and 0xFF)
        val data = apdu.copyOfRange(5, 5 + lc)

        if (offset == 0) {
            if (lc < 2) return ApduStatus.respond(sw = ApduStatus.SW_WRONG_LENGTH)
            val declared = ((data[0].toInt() and 0xFF) shl 8) or (data[1].toInt() and 0xFF)
            if (declared > Type4Files.MAX_NDEF_SIZE) return ApduStatus.respond(sw = ApduStatus.SW_WRONG_P1P2)
            if (declared == 0) {
                // 쓰기 1단계: 파일을 비운다. 앞서 모아 둔 본문도 같이 버린다.
                resetWriteState()
                return ApduStatus.respond(sw = ApduStatus.SW_OK)
            }
            declaredLength = declared
            if (lc > 2) {
                // 안드로이드 리더의 단발 쓰기: NLEN 과 본문이 한 APDU 안에 있다.
                data.copyInto(writeBuffer, 0, 2, lc)
                markWritten(0, lc - 2)
            }
            emitIfComplete()
            return ApduStatus.respond(sw = ApduStatus.SW_OK)
        }

        val bodyOffset = offset - 2
        if (bodyOffset < 0 || bodyOffset + lc > Type4Files.MAX_NDEF_SIZE) {
            return ApduStatus.respond(sw = ApduStatus.SW_WRONG_P1P2)
        }
        data.copyInto(writeBuffer, bodyOffset)
        markWritten(bodyOffset, lc)
        emitIfComplete()
        return ApduStatus.respond(sw = ApduStatus.SW_OK)
    }

    /** 방금 쓰인 자리를 표에 적고, 앞에서부터 이어진 길이를 다시 잰다. */
    private fun markWritten(from: Int, length: Int) {
        for (i in from until from + length) writtenBytes[i] = true
        while (completePrefix < writtenBytes.size && writtenBytes[completePrefix]) completePrefix += 1
    }

    /**
     * 선언한 길이만큼 앞에서부터 다 모였으면 그 메시지를 한 번 내보낸다.
     *
     * 내보내기 **전에** 상태를 지운다. 같은 NLEN 이 한 번 더 와도 다시 불리지 않고, [onMessage]
     * 안에서 곧장 다음 탭을 준비해도 지워진 상태 위에서 시작한다.
     */
    private fun emitIfComplete() {
        if (declaredLength == 0 || completePrefix < declaredLength) return
        val message = writeBuffer.copyOfRange(0, declaredLength)
        resetWriteState()
        onMessage(message)
    }

    private fun resetWriteState() {
        declaredLength = 0
        completePrefix = 0
        writtenBytes.fill(false)
    }
}
