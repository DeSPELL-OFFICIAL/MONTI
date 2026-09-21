package app.monti.hce

/**
 * [MontiHostApduService] 와 `HcePlugin` 사이의 **유일한** 접점.
 *
 * 둘은 수명이 다르다. 서비스는 OS 의 NFC 스택이 탭이 시작될 때 만들고 끝나면 언제든 파괴하며,
 * 플러그인은 WebView 가 살아 있는 동안 남는다. 서비스 인스턴스에 상태 기계를 두면 탭마다 새
 * 기계가 생겨 `setPayload` 로 넣어 둔 게이트 코드가 사라지고, 플러그인 인스턴스에 두면 서비스가
 * 그걸 집을 방법이 없다(OS 가 생성자를 부른다 — 우리가 건네줄 자리가 없다). 그래서 상태 기계는
 * 프로세스 싱글턴에 둔다.
 *
 * 스레드: `processCommandApdu` 는 NFC 스택의 바인더 스레드에서 오고 `setPayload` 는 WebView 의
 * 메인 스레드에서 온다. [onWrite] 가 `@Volatile` 인 이유가 그것이다 — 플러그인이 붙이거나 떼는
 * 콜백을 바인더 스레드가 곧바로 보아야 한다. APDU 자체는 한 번에 하나씩 순서대로 들어오므로
 * 상태 기계 안쪽은 더 잠글 것이 없다.
 */
object HceBridge {

    /**
     * 완성된 메시지 하나마다 한 번 불린다. 플러그인이 `start()` 에서 붙이고 `stop()` 에서 뗀다.
     * 붙어 있지 않으면 그 메시지는 조용히 버려진다 — 게이트가 꺼져 있는 동안 도착한 응답을
     * 쌓아 두었다가 나중에 한꺼번에 내보내면, 직원이 보는 것은 이미 지나간 관객의 결과다.
     */
    @Volatile
    var onWrite: ((ByteArray) -> Unit)? = null

    /** 프로세스에 하나뿐인 상태 기계. 서비스가 파괴돼도 여기 남는다. */
    val machine: ApduStateMachine = ApduStateMachine { message ->
        onWrite?.invoke(message)
    }

    /** 다음 탭이 내보낼 게이트 코드를 건다. 진행 중인 탭은 읽던 것을 끝까지 읽는다(Task 5). */
    fun setPayload(ndef: ByteArray) = machine.setPendingPayload(ndef)

    /**
     * 게이트를 끈다. 페이로드를 **비우고** 세션을 닫으므로, 이 뒤에 붙는 리더는 빈 NDEF 파일
     * (`0000`)을 읽는다 — 멈춘 게이트가 마지막 코드를 계속 내주는 것보다 낫다. 그 코드는
     * 3초 뒤면 만료되므로 관객 화면에는 어차피 실패가 뜬다.
     */
    fun reset() {
        machine.setPendingPayload(ByteArray(0))
        machine.onDeactivated()
    }
}
