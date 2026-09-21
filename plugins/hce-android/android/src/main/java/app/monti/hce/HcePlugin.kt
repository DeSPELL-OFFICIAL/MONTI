package app.monti.hce

import android.content.ComponentName
import android.nfc.NfcAdapter
import android.nfc.cardemulation.CardEmulation
import android.util.Base64
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * JS 에서 보이는 `Hce`. 메서드 이름·옵션 키·이벤트 이름·에러 코드는 전부
 * `plugins/hce-android/src/definitions.ts` 가 정하고, 이 클래스는 그걸 그대로 따른다 —
 * `src/plugin.test.ts` 가 양쪽을 맞대어 본다.
 *
 * 바이트는 한 가지 철자로만 다리를 건넌다: **표준 base64, `+/` 알파벳, `=` 패딩, 줄바꿈 없음**.
 * 안드로이드에서 그건 [Base64.NO_WRAP] 이다. 기본값([Base64.DEFAULT])으로 인코딩하면 76열마다
 * 줄바꿈이 들어가 TS 쪽 `fromBase64` 가 그 자리에서 거절한다 — 게이트에서 읽히지 않는 태그로
 * 나타나는 것보다 낫지만, 애초에 그럴 일이 없게 여기서 NO_WRAP 을 쓴다.
 *
 * [start] 가 `setPreferredService` 를 부르는 이유: 같은 표준 AID 를 등록해 둔 HCE 앱이 폰에
 * 하나라도 더 있으면(지갑 앱이 흔하다) OS 는 둘 중 하나를 고르고, 그 선택은 우리 것이 아닐 수
 * 있다. 앱이 앞에 있는 동안만큼은 우리가 받겠다고 못 박는 것이 이 호출이다. [stop] 이 푼다.
 */
@CapacitorPlugin(name = "Hce")
class HcePlugin : Plugin() {

    private val serviceComponent: ComponentName
        get() = ComponentName(context, MontiHostApduService::class.java)

    private var started = false

    @PluginMethod
    fun start(call: PluginCall) {
        val aid = call.getString("aid")
        if (aid == null || !aid.equals(REGISTERED_AID, ignoreCase = true)) {
            // 매니페스트가 AID 를 고정하므로 여기서 바꿀 방법은 없다. 부르는 쪽이 다른 값을
            // 보냈다면 그쪽이 틀린 것이고, 조용히 무시하면 "등록은 됐는데 안 읽힌다"가 된다.
            call.reject("aid must be $REGISTERED_AID; it is fixed in the manifest", INVALID_ARGUMENT)
            return
        }
        val adapter = NfcAdapter.getDefaultAdapter(context)
        if (adapter == null) {
            // 영구적이다 — 이 기기는 카드가 될 수 없다. 부르는 쪽은 QR 로 간다.
            call.reject("this device has no NFC adapter", UNAVAILABLE)
            return
        }
        if (!adapter.isEnabled) {
            // 영구적이지 않다. 설정에서 NFC 를 켜면 되므로 QR 이 아니라 "NFC 를 켜 주세요"다.
            call.reject("NFC is turned off", NFC_DISABLED)
            return
        }
        HceBridge.onWrite = { message ->
            val payload = JSObject()
            payload.put("ndef", Base64.encodeToString(message, Base64.NO_WRAP))
            notifyListeners("write", payload)
        }
        if (!claimPreferredService()) {
            // 청구가 거절됐다. 카드 에뮬레이션 자체는 되지만 같은 AID 를 등록한 지갑 앱이
            // 탭을 가져갈 수 있다 — 그러면 관객 일부가 아무 에러 없이 게이트를 통과하지
            // 못한다. 조용히 넘기면 그 실패는 어디에도 남지 않는다.
            HceBridge.onWrite = null
            call.reject("the OS refused the preferred-service claim for $REGISTERED_AID", CLAIM_REFUSED)
            return
        }
        started = true
        call.resolve()
    }

    @PluginMethod
    fun setPayload(call: PluginCall) {
        if (!started) {
            // 게이트가 꺼진 채로 코드를 걸면 회전 루프는 돌지만 아무도 읽지 않는다.
            call.reject("call start() before setPayload()", INVALID_ARGUMENT)
            return
        }
        val ndef = call.getString("ndef")
        if (ndef == null) {
            call.reject("ndef is required", INVALID_ARGUMENT)
            return
        }
        try {
            HceBridge.setPayload(Base64.decode(ndef, Base64.DEFAULT))
            call.resolve()
        } catch (e: IllegalArgumentException) {
            // 두 갈래가 여기로 온다: base64 가 아니거나, CC 가 선언한 파일보다 크거나.
            // 어느 쪽이든 조용히 자르면 관객 폰이 잘린 CBOR 을 검증하러 간다.
            call.reject("ndef is not valid base64 or is too large: ${e.message}", INVALID_ARGUMENT)
        }
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        val adapter = NfcAdapter.getDefaultAdapter(context)
        if (adapter != null) {
            val emulation = CardEmulation.getInstance(adapter)
            activity?.let { emulation.unsetPreferredService(it) }
        }
        releaseGate()
        call.resolve()
    }

    /**
     * 플랫폼은 **액티비티가 resumed 인 동안에만** preferred service 를 존중한다. 근무 시작에
     * `start()` 를 한 번 부른 것으로는 근무 내내 청구가 유지되지 않는다 — 화면이 꺼졌다 켜지거나
     * 다른 앱이 앞에 왔다 가면 그 사이에 풀린다. 그래서 돌아올 때마다 다시 청구한다.
     */
    override fun handleOnResume() {
        super.handleOnResume()
        if (started) claimPreferredService()
    }

    /**
     * 액티비티가 죽는다. `HceBridge` 는 프로세스 싱글턴이라 여기서 콜백을 떼지 않으면 죽은
     * 플러그인과 그 액티비티를 프로세스가 끝날 때까지 붙들고 있고(누수), 완성된 쓰기는 새
     * 인스턴스가 `start()` 를 부를 때까지 아무 데도 닿지 않은 채 사라진다. 회전(rotation)이나
     * 프로세스를 살린 재시작은 `stop()` 없이 여기로 온다.
     */
    override fun handleOnDestroy() {
        if (started) releaseGate()
        super.handleOnDestroy()
    }

    /** `start()` 와 `handleOnResume()` 이 함께 쓰는 청구. 액티비티가 없으면 청구할 것도 없다. */
    private fun claimPreferredService(): Boolean {
        val adapter = NfcAdapter.getDefaultAdapter(context) ?: return false
        val emulation = CardEmulation.getInstance(adapter)
        val current = activity ?: return false
        return emulation.setPreferredService(current, serviceComponent)
    }

    /**
     * 콜백을 **먼저** 뗀다. 그래야 `reset()` 이 부르는 `onDeactivated` 로 무언가 들어와도 이미
     * 멈춘 게이트의 이벤트가 JS 로 새어 나가지 않는다.
     */
    private fun releaseGate() {
        HceBridge.onWrite = null
        HceBridge.reset()
        started = false
    }

    companion object {
        /** `res/xml/monti_apduservice.xml` 에 등록한 AID, 그리고 `@monti/shared` 의 `HCE_AID`. */
        const val REGISTERED_AID = "D2760000850101"

        /** `HCE_ERROR` (definitions.ts) 의 네 코드. 모든 거절이 이 중 하나를 달고 간다. */
        const val INVALID_ARGUMENT = "INVALID_ARGUMENT"
        const val UNAVAILABLE = "UNAVAILABLE"
        const val NFC_DISABLED = "NFC_DISABLED"
        const val CLAIM_REFUSED = "CLAIM_REFUSED"
    }
}
