package app.monti.hce

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `HcePlugin` 의 계약 — JS 가 부르는 이름들.
 *
 * 이 클래스는 인스턴스를 만들어 볼 수 없다. `Plugin` 은 Activity·Context 를 들고 있어서 순수
 * JVM 유닛 테스트의 android.jar 스텁에서 생성자가 터지고, `PluginCall` 도 마찬가지다. 기기 없이
 * 볼 수 있는 것은 **선언**이다 — 그리고 이 플러그인에서 실제로 깨지는 것도 거기다: 메서드
 * 이름 하나가 TS 정의와 어긋나면 컴파일은 멀쩡히 되고 런타임에 "method not found" 만 남는다.
 *
 * `const val` 은 Kotlin 이 호출 지점에 리터럴로 박으므로, 아래 비교는 클래스를 적재하지 않는다.
 * 나머지는 원본을 읽어서 본다. 같은 검사가 `plugins/hce-android/src/plugin.test.ts` 에도 있고,
 * 이 기계에는 Android SDK 가 없어 이 파일이 아직 컴파일된 적이 없으므로 그쪽이 오늘 돈다.
 */
class HcePluginTest {

    private val source = File("src/main/java/app/monti/hce/HcePlugin.kt").readText()

    private val apduService = File("src/main/res/xml/monti_apduservice.xml").readText()

    @Test
    fun theAidItAcceptsIsTheAidTheManifestRegistered() {
        // const val 이라 이 비교는 리터럴 대 리터럴이다 — 클래스를 적재하지 않는다.
        assertEquals("D2760000850101", HcePlugin.REGISTERED_AID)
        assertTrue(apduService.contains("android:name=\"${HcePlugin.REGISTERED_AID}\""))
    }

    @Test
    fun itExposesExactlyTheThreeMethodsTheTypeScriptDeclares() {
        val methods = Regex("@PluginMethod\\s+fun\\s+([A-Za-z0-9_]+)\\s*\\(")
            .findAll(source)
            .map { it.groupValues[1] }
            .toList()
        assertEquals(listOf("start", "setPayload", "stop"), methods)
    }

    @Test
    fun itRegistersUnderTheNameRegisterPluginUses() {
        assertTrue(source.contains("@CapacitorPlugin(name = \"Hce\")"))
    }

    @Test
    fun theWriteEventCarriesStandardBase64WithNoLineBreaks() {
        // definitions.ts 가 정한 철자다. DEFAULT 로 인코딩하면 76열마다 줄바꿈이 들어가고
        // TS 쪽 fromBase64 가 거절한다.
        assertTrue(source.contains("Base64.encodeToString(message, Base64.NO_WRAP)"))
        assertTrue(source.contains("payload.put(\"ndef\", "))
        assertTrue(source.contains("notifyListeners(\"write\", payload)"))
    }

    @Test
    fun everyRejectionCarriesOneOfTheDeclaredCodes() {
        // definitions.ts: "Every rejection from this plugin carries one of these as its
        // Capacitor error code." 코드 없는 reject 는 JS 쪽에서 분기할 수 없는 실패가 된다.
        val codes = setOf(HcePlugin.INVALID_ARGUMENT, HcePlugin.UNAVAILABLE, HcePlugin.NFC_DISABLED)
        val rejections = Regex("call\\.reject\\(([^\\n]*)\\)").findAll(source).map { it.groupValues[1] }.toList()
        assertTrue("reject 가 하나도 없다", rejections.isNotEmpty())
        for (rejection in rejections) {
            assertTrue("code 없는 reject: $rejection", codes.any { rejection.contains(it) })
        }
    }

    @Test
    fun stopDropsTheListenerBeforeItClearsTheGate() {
        // reset() 이 onDeactivated 를 부르므로, 콜백을 나중에 떼면 이미 멈춘 게이트의 이벤트가
        // JS 로 한 번 더 새어 나갈 수 있다.
        val dropAt = source.indexOf("HceBridge.onWrite = null")
        val resetAt = source.indexOf("HceBridge.reset()")
        assertTrue("stop() 이 onWrite 를 떼지 않는다", dropAt >= 0)
        assertTrue("stop() 이 reset() 을 부르지 않는다", resetAt >= 0)
        assertTrue("콜백을 reset() 보다 먼저 떼야 한다", dropAt < resetAt)
    }

    @Test
    fun itClaimsThePreferredServiceSoAWalletAppCannotTakeTheTap() {
        assertTrue(source.contains("emulation.setPreferredService(it, serviceComponent)"))
        assertTrue(source.contains("emulation.unsetPreferredService(it)"))
    }
}
