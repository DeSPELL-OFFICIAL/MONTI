package app.monti.hce

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 매니페스트 계약. 코드가 아니라 **선언**이 틀리면 탭이 조용히 아무 일도 하지 않는다 — 예외도,
 * 로그도, 상태어도 없다. OS 가 서비스를 깨우지 않으니 상태 기계는 애초에 불리지 않는다.
 *
 * 그래서 여기서는 XML 세 조각을 읽어 본다. `<service>` 선언, AID 등록, 그리고 그 둘을 잇는
 * meta-data. 같은 검사가 `plugins/hce-android/src/apduService.test.ts` 에도 있고, 이 기계에는
 * Android SDK 가 없어 이 파일이 아직 컴파일된 적이 없으므로 그쪽이 오늘 실제로 돈다.
 *
 * 작업 디렉터리는 Gradle 이 모듈 루트(`plugins/hce-android/android`)로 잡아 준다.
 */
class ApduServiceManifestTest {

    private fun read(path: String): String = File(path).readText()

    private fun squeeze(text: String): String = text.replace("\\s+".toRegex(), " ")

    private val apduService = squeeze(read("src/main/res/xml/monti_apduservice.xml"))
    private val manifest = squeeze(read("src/main/AndroidManifest.xml"))
    private val strings = squeeze(read("src/main/res/values/strings.xml"))

    @Test
    fun apduServiceDeclaresTheMontiAidInTheOtherCategory() {
        assertTrue(apduService.contains("android:category=\"other\""))
        assertTrue(apduService.contains("android:name=\"D2760000850101\""))
        assertTrue(apduService.contains("android:requireDeviceUnlock=\"false\""))
    }

    @Test
    fun apduServiceIsNotRegisteredForPayment() {
        // payment 로 등록하면 OS 가 기본 결제 앱 우선순위 싸움에 이 서비스를 끌어들인다.
        assertTrue(!apduService.contains("category=\"payment\""))
    }

    @Test
    fun theRegisteredAidIsTheOneTheStateMachineAnswers() {
        // 등록한 AID 와 SELECT 에 답하는 AID 가 갈라지면, OS 는 서비스를 깨우지만 상태 기계는
        // 6A82 로 거절한다 — 리더 쪽에는 "태그가 있긴 한데 우리 것이 아님"으로 보인다.
        val declared = Regex("<aid-filter android:name=\"([0-9A-Fa-f]+)\"").find(apduService)?.groupValues?.get(1)
        val answered = read("src/main/java/app/monti/hce/ApduStateMachine.kt")
            .substringAfter("private val aid = byteArrayOf(")
            .substringBefore(")")
            .replace(".toByte()", "")
            .split(",")
            .map { it.trim() }
            .filter { it.isNotEmpty() }
            .joinToString("") { String.format("%02X", Integer.decode(it)) }
        assertEquals(answered, declared)
    }

    @Test
    fun manifestBindsTheServiceWithTheNfcPermission() {
        assertTrue(manifest.contains("app.monti.hce.MontiHostApduService"))
        assertTrue(manifest.contains("android:exported=\"true\""))
        assertTrue(manifest.contains("android:permission=\"android.permission.BIND_NFC_SERVICE\""))
        assertTrue(manifest.contains("android.nfc.cardemulation.action.HOST_APDU_SERVICE"))
        assertTrue(manifest.contains("android:name=\"android.nfc.cardemulation.host_apdu_service\""))
        assertTrue(manifest.contains("android:resource=\"@xml/monti_apduservice\""))
        assertTrue(manifest.contains("android:name=\"android.permission.NFC\""))
    }

    @Test
    fun neitherNfcNorHceIsAnInstallRequirement() {
        // NFC 권한은 android.hardware.nfc 를 required="true" 로 암묵 선언한다(플랫폼의
        // permission→feature 표). 명시로 덮어쓰지 않으면 Play 가 NFC 없는 기기를 걸러 내고,
        // 이 매니페스트가 병합되는 apps/web 에는 관객·주최자 화면도 같이 들어 있다.
        for (feature in listOf("android.hardware.nfc", "android.hardware.nfc.hce")) {
            val declared = Regex("<uses-feature[^>]*android:name=\"$feature\"[^>]*android:required=\"([a-z]+)\"")
                .find(manifest)?.groupValues?.get(1)
            assertEquals("<uses-feature $feature> 가 required 와 함께 선언돼야 한다", "false", declared)
        }
    }

    @Test
    fun everyStringTheApduServiceReferencesExists() {
        // aapt 는 없는 @string 참조에서 빌드를 멈춘다. 컴파일해 볼 수 없으니 여기서 본다.
        val referenced = Regex("@string/([A-Za-z0-9_]+)").findAll(apduService).map { it.groupValues[1] }.toList()
        assertTrue("apduservice.xml 이 @string 을 하나도 참조하지 않는다", referenced.isNotEmpty())
        for (name in referenced) {
            assertTrue("@string/$name 이 strings.xml 에 없다", strings.contains("<string name=\"$name\">"))
        }
    }

    @Test
    fun noReaderModeApiAppearsAnywhereInThePlugin() {
        // 이 쪽은 카드다. 리더 모드를 켜는 순간 같은 폰이 읽는 쪽도 되려 하고, 두 역할이 한
        // 안테나를 두고 싸운다. 게이트의 리더는 관객 폰이다.
        val offenders = File("src/main").walkTopDown()
            .filter { it.isFile && (it.extension == "kt" || it.extension == "xml") }
            .filter {
                val text = it.readText()
                text.contains("enableReaderMode") || text.contains("enableForegroundDispatch")
            }
            .map { it.path }
            .toList()
        assertTrue("reader mode API found in $offenders", offenders.isEmpty())
    }
}
