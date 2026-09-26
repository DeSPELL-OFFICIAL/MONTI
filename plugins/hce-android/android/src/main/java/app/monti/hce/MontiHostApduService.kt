package app.monti.hce

import android.nfc.cardemulation.HostApduService
import android.os.Bundle

/**
 * OS 가 탭마다 깨우는 쪽. 하는 일은 두 줄을 [HceBridge] 로 넘기는 것뿐이고, 판단은 하나도
 * 하지 않는다 — APDU 를 읽는 규칙은 전부 [ApduStateMachine] 에 있고 그건 Android 없이 도는
 * 순수 Kotlin 이라 JUnit 으로 볼 수 있다. 이 클래스에 분기를 하나 더 두는 순간 그 분기는
 * 기기 없이는 볼 수 없는 코드가 된다.
 *
 * `AndroidManifest.xml` 의 `<service>` 와 `res/xml/monti_apduservice.xml` 의 AID 등록이 이
 * 클래스를 OS 에 이어 준다. 셋 중 하나라도 어긋나면 탭이 조용히 아무 일도 하지 않으므로,
 * `ApduServiceManifestTest` 와 `src/apduService.test.ts` 가 그 셋을 함께 못 박는다.
 */
class MontiHostApduService : HostApduService() {

    /**
     * 리더가 보낸 C-APDU 하나에 R-APDU 하나로 답한다. `null` 을 돌려주면 "지금은 답하지 않는다"는
     * 뜻이라 리더가 타임아웃까지 기다리므로, 어떤 경우에도 두 바이트 이상을 돌려준다.
     */
    override fun processCommandApdu(commandApdu: ByteArray?, extras: Bundle?): ByteArray {
        val apdu = commandApdu ?: return ApduStatus.respond(sw = ApduStatus.SW_WRONG_LENGTH)
        return HceBridge.machine.process(apdu)
    }

    /**
     * 리더가 떠났거나(`DEACTIVATION_LINK_LOSS`) 다른 AID 가 선택됐다(`DEACTIVATION_DESELECTED`).
     * 어느 쪽이든 이 탭은 끝났다 — 세션을 닫고, 걸려 있던 다음 게이트 코드를 승격시킨다.
     * 이유로 갈라지지 않는 이유는 둘 다 "이 탭은 끝났다"로 같기 때문이다.
     */
    override fun onDeactivated(reason: Int) {
        HceBridge.machine.onDeactivated()
    }
}
