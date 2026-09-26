# MONTI 안드로이드 필드 테스트 체크리스트 — 첫 end-to-end 탭

작성: 2026-09-22 (04 T33) · 대상: 창업자 혼자 실행 · 기기: **안드로이드 2대**(관객 1, 스태프 1)
스펙 근거: `docs/superpowers/specs/2026-09-20-monti-nfc-ticketing-design.md` v2.6 §7·§12·§13·§16(W3)

> **이 문서를 읽는 법.** 모든 단계는 ① **그대로 복사해 붙일 명령** 또는 ② **그대로 따라 할 화면 조작**,
> ③ **화면에 무엇이 보여야 하는가**, ④ **안 보이면 무엇을 한다**로 되어 있습니다. 순서를 지키세요.
> 아래로 갈수록 앞 단계가 성공했다고 가정합니다. 한 단계가 막히면 거기서 멈추고 §H 결과표에 적은 뒤
> 다음 섹션으로 넘어가지 말고 "안 되면" 가지를 먼저 밟으세요.

> **아이폰은 이번 회차에 없습니다.** 게이트(스태프) 단말기는 HCE(카드 흉내)가 필요하고 iOS에는
> 등가물이 없습니다. 관객 폰도 이번에는 안드로이드 1대입니다. 아이폰 2종 라운드는 03 서브플랜의
> 아이폰 네이티브가 들어온 뒤 별도 회차입니다.

---

## 0. 시작 전에 — 아직 없는 것 (반드시 먼저 읽기)

이 표를 읽지 않고 §D로 내려가면 "왜 큐가 안 나가지"에서 막힙니다. 게이트 화면은 들어왔고, 아래가 아직 없는 것들입니다.

| 항목 | 지금 상태 | 이 문서에 미치는 영향 |
|---|---|---|
| 04 T30 게이트 화면 배선 | **착륙했습니다.** 게이트 화면·상태 기계·체인 판정·오프라인 큐가 배선됐습니다 | **§A~§F는 오늘 그대로 실행 가능**합니다. §D~§G는 브리프가 아니라 **들어온 코드를 보고** 다시 썼습니다 |
| 04 T31 QR 폴백 | 착륙(`f4ab1dd`). 게이트 화면에 **"QR로 확인"** 단추로 붙어 있습니다 | §F 실행 가능 |
| 04 T32 수동 승인(PIN·사유 코드) | **창 껍데기만 있습니다.** PIN 칸·사유 네 개·단추는 뜨지만 승인을 보내는 코드가 없습니다 | §G는 **화면 확인까지만**. 실제 승인은 T32 이후 |
| 관객용 안드로이드 APK | **없습니다.** `apps/web/capacitor.config.ts`의 flavor 맵에 `staff` 하나뿐이고, 관객 네이티브는 03 T32 몫입니다 | 1회차 관객 폰은 **크롬(Web NFC)** 으로 웹앱을 엽니다(§A-11) |
| 스태프 APK 서명 키 · `ANDROID_APK_KEY_HASH` · `assetlinks.json` | **없습니다** (Task 10 보고서 §4) | 스태프 **패스키 로그인이 기기에서 안 됩니다**. 전화번호 로그인으로 우회합니다(§B-3은 창업자 판단 항목) |
| `apps/web/android-staff/app/google-services.json` | **저장소에 없습니다** | 푸시·Firebase 로그인이 죽습니다. §A-7에서 넣습니다 |
| `checkInLate` (01b 재배포) | 컨트랙트 ABI에 **아직 없습니다** | §E의 큐 플러시는 **드라이런**입니다. 실제 전송은 재배포 후 2회차(§I) |
| NDJSON 필드 로그(`exportFieldLog()`) | **코드가 없습니다.** 이 태스크는 문서만 만들었습니다 | 기록은 §H 표에 **손으로** 적습니다 |

---

## A. 기계 준비 (맥북에서 한 번)

작업 디렉터리는 전부 `/Users/moomi/Downloads/z03.Vibe_Coding/MONTI/MONTI-staff` 입니다.

### A-1. 도구가 있는지 본다

```bash
java -version
echo "ANDROID_HOME=$ANDROID_HOME"
adb --version
fnm --version
```

**보여야 하는 것**: `java version "21.` 로 시작하는 줄, 비어 있지 않은 `ANDROID_HOME`, `adb` 버전 한 줄.

**안 되면**
- `java`가 21이 아니면: Android Studio → Settings → Build, Execution, Deployment → Build Tools → Gradle → **Gradle JDK = 21**. 터미널에서도 쓰려면 `export JAVA_HOME=$(/usr/libexec/java_home -v 21)`.
- `ANDROID_HOME`이 비어 있으면: `export ANDROID_HOME="$HOME/Library/Android/sdk"` 와 `export PATH="$ANDROID_HOME/platform-tools:$PATH"` 를 `~/.zshrc`에 넣고 새 터미널을 엽니다.
- Android Studio의 SDK Manager에서 **Android SDK Platform 36**, **Build-Tools 36**, **Platform-Tools**를 설치합니다.
  (브리프에 적힌 "SDK 35"는 구버전 메모입니다. 이 저장소의 `apps/web/android-staff/variables.gradle`은
  `compileSdkVersion = 36`, `targetSdkVersion = 36`, `minSdkVersion = 31` 입니다.)

### A-2. 비밀 환경 파일을 가져온다

`.env.local`은 저장소에 커밋되지 않습니다. 없으면 웹 테스트 14개가 빨갛게 됩니다.

```bash
cp /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/MONTI-web/apps/web/.env.local \
   /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/MONTI-staff/apps/web/.env.local
grep -E '^VITE_(RP_ID|CHAIN_ID|ADDR_TICKET|ADDR_ORGANIZERS)=' \
   /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/MONTI-staff/apps/web/.env.local
```

**보여야 하는 것**: 네 줄. `VITE_CHAIN_ID=10143`, `VITE_ADDR_ORGANIZERS=0x9f0c3c8d87531Ae343f06223FcaA507E6Efb1Fb9`,
`VITE_ADDR_TICKET=0xE9686503c4d675B0B1Ec9DE19AbEC51Fc59F1113`.

**안 되면 / 주의**: `VITE_RP_ID`가 `monti.app`이면 **앱의 assetlinks 도메인(`monti.despell.io`)과 어긋나** 패스키가
붙지 않습니다. 이번 회차는 전화번호 로그인으로 가므로 진행은 되지만, §B-3에 "불일치"로 적어 두세요.

### A-3. 의존성 설치

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/MONTI-staff
fnm exec --using=22 pnpm install
```

**보여야 하는 것**: 마지막 줄이 `Done in ...`. 에러 없음.

### A-4. 공유 패키지를 먼저 빌드한다 (건너뛰면 웹 빌드가 깨집니다)

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/MONTI-staff
fnm exec --using=22 pnpm -F @monti/shared build
```

**보여야 하는 것**: `packages/shared/dist/` 가 생깁니다. (`dist/`는 gitignore라 매번 새로 만들어야 합니다.)

### A-5. 웹을 빌드하고 테스트를 돌린다 (회귀 확인)

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/MONTI-staff
fnm exec --using=22 pnpm -F web typecheck
fnm exec --using=22 pnpm -F web test
fnm exec --using=22 pnpm -F web build
```

**보여야 하는 것**: typecheck `0 errors`; 테스트가 전부 초록(이 브랜치 기준 **800개 이상**);
`build`가 `apps/web/dist/`를 만듦.

**안 되면**: 빨간 테스트 이름을 §H "보낼 것"에 그대로 적습니다. 빌드가 깨지면 §A에서 멈추세요 —
APK를 만들어 봐야 같은 이유로 깨집니다.

### A-6. 스태프 웹 자산을 빌드하고 네이티브에 동기화한다

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/MONTI-staff/apps/web
fnm exec --using=22 pnpm sync:staff
```

이 한 줄이 `MONTI_APP_FLAVOR=staff pnpm build:staff` + `MONTI_APP_FLAVOR=staff cap sync android`
입니다. `cap`을 직접 부르면 **일부러 거절**합니다.

**보여야 하는 것**: `dist-staff/index.html` 생성, 그리고 `cap sync`가 플러그인 **10개**를 인식.
`[CapacitorPasskey] Skipping Android auto-configuration...` 줄은 **정상**입니다(배선을 손으로 해 뒀습니다).

**안 되면**: `MONTI_APP_FLAVOR must be one of staff; got ""` 가 뜨면 `cap`을 직접 부른 것입니다.
위 명령을 그대로 쓰세요.

### A-7. Firebase 파일을 넣는다

Firebase 콘솔에서 **패키지 이름 `app.monti.staff`** 로 안드로이드 앱을 새로 등록하고(관객 앱과 별개),
받은 파일을 여기에 둡니다.

```bash
ls -l /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/MONTI-staff/apps/web/android-staff/app/google-services.json
```

**보여야 하는 것**: 파일이 존재.

**안 되면**: 없으면 Gradle이 google-services 플러그인을 **조용히 건너뛰고** 푸시·로그인이 죽습니다.
§D-6(관객 푸시)과 §C-1(전화 로그인)이 실패하므로, 없이 진행한다면 §H에 "google-services 없음"을 적으세요.

### A-8. 첫 Gradle 빌드 — 여기서 코틀린이 **처음으로** 컴파일됩니다

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/MONTI-staff/apps/web/android-staff
./gradlew :app:assembleDebug
```

**보여야 하는 것**: `BUILD SUCCESSFUL`.

**안 되면 — 세 가지 알려진 가지** (전부 코드를 읽어 추론한 것이고, 이 빌드가 최초 검증입니다)

| 메시지 | 무엇을 한다 |
|---|---|
| `uses-sdk:minSdkVersion 24 cannot be smaller than version 31` | `variables.gradle`의 `minSdkVersion`이 31인지 확인. 31이면 클린 후 재시도: `./gradlew clean :app:assembleDebug` |
| Kotlin Gradle Plugin 경고/실패 (KGP 2.0.21 × Gradle 8.14.3) | `plugins/hce-android/android/build.gradle` 과 `plugins/device-key/android/build.gradle` 두 곳의 KGP를 `2.1.x`로 올리고 §A-6부터 다시 |
| `multiple versions of the Android Gradle plugin` | 위 두 파일의 AGP classpath를 루트와 같은 `8.13.0`으로 맞춤 |

### A-9. 코틀린 단위 테스트 82개를 처음 돌린다

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/MONTI-staff/apps/web/android-staff
./gradlew :monti-hce-android:test
./gradlew :monti-device-key:test
```

**보여야 하는 것**: 두 모듈 모두 `BUILD SUCCESSFUL`. HCE 쪽 테스트 **82개**가 이 순간 처음 실행됩니다.

**안 되면**: 실패한 테스트 클래스 이름을 §H에 적습니다. APDU 계열이 깨지면 §D의 탭이 될 리 없으니
여기서 멈추는 편이 낫습니다.

### A-10. 스태프 폰에 설치한다

스태프용 안드로이드 폰을 USB로 연결하고, 폰에서 **개발자 옵션 → USB 디버깅**을 켭니다.

```bash
adb devices
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/MONTI-staff/apps/web/android-staff
./gradlew :app:installDebug
```

**보여야 하는 것**: `adb devices`에 기기 한 줄 + `device`(unauthorized 아님), 그리고 `BUILD SUCCESSFUL`.
폰 앱 서랍에 **MONTI Staff** 가 생깁니다.

**안 되면**: `unauthorized`면 폰 화면의 "이 컴퓨터를 허용" 팝업을 승인합니다.
`INSTALL_FAILED_UPDATE_INCOMPATIBLE`이면 `adb uninstall app.monti.staff` 후 재설치.

> 한 줄로 하려면(동기화+빌드+설치): `cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/MONTI-staff/apps/web && fnm exec --using=22 pnpm run:staff`

### A-11. 관객 폰을 준비한다 (이번 회차는 크롬)

관객용 안드로이드 APK는 아직 없습니다(§0). 관객 폰에서는 **크롬으로 배포된 웹앱**을 엽니다.

1. 관객 폰 크롬에서 `https://monti.despell.io` 를 엽니다.
2. 크롬 메뉴 → **홈 화면에 추가**.
3. 폰 설정에서 **NFC 켜기**.

**보여야 하는 것**: 가입/로그인 화면이 뜨고, 크롬 주소창이 **자물쇠(https)** 입니다.

**안 되면**: Web NFC는 **HTTPS에서만** 동작합니다. `http://` 나 IP 주소로 열면 탭이 아예 시작되지 않습니다.
프로덕션 프로모트가 아직이면 §B-3의 창업자 판단 항목으로 올리고, 1회차를 여기서 멈춥니다.

---

## B. 첫 실행 게이트 — 기기에서 **처음** 증명되는 5가지

리뷰가 "실기기에서 증명된 적 없음"으로 표시한 항목들입니다. 하나라도 빨갛게 나오면 §C 이후가 의미가 없습니다.
아래 명령은 맥북에서, 조작은 스태프 폰에서 합니다. 로그는 이 창을 켜 놓고 보세요.

```bash
adb logcat -c
adb logcat -s Capacitor:V "Capacitor/Console:V" CapacitorPlugins:V NfcService:V HostEmulationManager:V AndroidKeyStore:V
```

### B-1. StrongBox 키가 `DIGEST_NONE`으로 만들어지는가 (Task 11)

**조작**: MONTI Staff 앱을 처음 엽니다. 첫 화면이 "이 단말기 보안 칩에 게이트 키를 만들고 있어요."입니다.

**보여야 하는 것**: 몇 초 안에 그 문구가 사라지고 **게이트 계정 주소(0x…)** 가 화면에 뜹니다.
로그에 `KEY_GENERATION_FAILED`가 **없어야** 합니다.

**안 되면 — `KEY_GENERATION_FAILED` 또는 "게이트 키를 만들 수 없어요"가 뜬 경우**

일부 StrongBox 구현이 `KeyProperties.DIGEST_NONE`을 거절합니다. 이건 `StrongBoxUnavailableException`이
아니라서 TEE로 자동 강등되지 않습니다. 순서대로 시도하세요.

1. 앱을 완전히 종료하고 다시 엽니다(부팅 시 StrongBox 경합에 한 번 진 것일 수 있고, 메모는 실패 시 지워지므로 재시도가 먹습니다).
2. 그래도 같으면 `plugins/device-key/android/src/main/java/app/monti/devicekey/DeviceKeyPlugin.kt`
   의 `spec()`에서 `setDigests(...)`의 **`DIGEST_NONE`만 빼고** §A-8부터 다시 빌드합니다.
   — 단, 이 경우 `NONEwithECDSA` 서명이 막힐 수 있습니다. 둘 다 안 되면 **StrongBox 자체를 끄고**(TEE)
   한 번 더 확인한 뒤, 어느 조합이 통과했는지 §H에 정확히 적습니다. 이것이 이 회차의 가장 중요한 한 줄입니다.

### B-2. HCE 서비스가 실제로 등록되었는가 (`CLAIM_REFUSED`)

**조작**: 스태프 폰 **설정 → 연결 → NFC → 탭하고 결제하기**(제조사에 따라 "비접촉 결제"/"기본 결제 앱")
목록을 엽니다.

**보여야 하는 것**: 목록에 **MONTI Staff** 가 보입니다. 그리고 "**포그라운드 앱이 기본 결제 앱보다
우선하도록 허용**"(foreground apps override default payment app) 옵션이 **켜져** 있어야 합니다.

**안 되면**
- 목록에 없으면 HostApduService 등록이 안 된 것입니다. `adb logcat` 에서 `MontiHostApduService` 나
  매니페스트 병합 오류를 찾습니다. §A-8을 클린 빌드로 다시.
- 앱 로그에 `CLAIM_REFUSED`가 뜨면 **다른 HCE 앱이 같은 AID(`D2760000850101`)를 잡고 있거나**
  위 "포그라운드 우선" 옵션이 꺼진 것입니다. 삼성페이/구글월렛을 잠시 기본 결제 앱에서 내리고 다시 시도합니다.
  (이 오류는 QR로 내려갈 신호가 아닙니다 — 카드 에뮬레이션 자체는 살아 있습니다.)
- **삼성 기기**: 설정 → 연결 → NFC → **Secure NFC를 끕니다.** 켜져 있으면 화면 잠금 시 HCE가 죽습니다.

### B-3. 패스키 / RP-ID `monti.despell.io` 결합 — **창업자 판단 필요 (founder-go)**

이 항목만은 코드로 해결되지 않습니다. 세 가지가 모두 있어야 스태프 패스키 로그인이 기기에서 됩니다.

1. 스태프 APK의 **서명 키**가 존재해야 합니다 (지금 없음).
2. `https://monti.despell.io/.well-known/assetlinks.json` 에 그 키의 SHA-256 지문이 **패키지 이름
   `app.monti.staff`** 로 올라가 있어야 합니다 → **프로덕션 웹 프로모트가 선행**되어야 합니다.
3. 서버의 WebAuthn allowed-origin 목록에 `android:apk-key-hash:<값>` 이 웹 origin **옆에** 있어야 합니다.

키를 만들려면(Task 10 보고서 §4 그대로):

```bash
keytool -genkey -v -keystore ~/monti-staff-upload.jks -alias monti-staff \
        -keyalg RSA -keysize 4096 -validity 10000

keytool -list -v -keystore ~/monti-staff-upload.jks -alias monti-staff | grep SHA256

keytool -list -v -keystore ~/monti-staff-upload.jks -alias monti-staff \
  | awk '/SHA256:/ {print $2}' | tr -d ':' \
  | xxd -r -p | openssl base64 | tr '+/' '-_' | tr -d '='
```

**이번 회차 결정**: 세 가지가 안 갖춰졌다면 **패스키를 쓰지 않고 §C-1의 전화번호 로그인으로 진행**합니다.
§H 결과표에 "B-3: 미검증(프로덕션 프로모트 대기)"라고 적습니다. 이건 실패가 아니라 **보류**입니다.

### B-4. 두 번째 UserOp의 `AA23 out of gas` (Task 13 리뷰 · Task 21)

증상의 모양이 특이합니다: **첫 체크인은 되고, 그다음부터 문 앞에서 전부 실패**합니다.
이유는 첫 옵이 계정 배포(`initCode`) 때문에 가스 추정이 크고, 배포 이후 옵은 추정이 작아져
숨은 P-256 검증 가스 약 10.3k를 못 메우기 때문입니다.

**막아 둔 것**: `sendSponsoredOp`이 `verificationGasLimit`에 **150,000 하한**을 무조건 겁니다
(`MIN_VERIFICATION_GAS`). `callGasLimit`은 200,000 하한. 800,000이 아닌 이유는 Monad가
**사용량이 아니라 limit에 과금**하기 때문입니다.

**어떻게 확인하는가**: §D의 탭을 **연속 3회** 합니다. 2번째·3번째가 초록이면 통과입니다.

**안 되면 — 2번째 탭에서 `AA23 out of gas` 또는 `TX_FAILED`**

```bash
# 게이트 계정에 코드가 배포됐는지 (첫 옵이 실제로 계정을 만들었는지)
cast code <게이트_계정_주소> --rpc-url https://testnet-rpc.monad.xyz
```

코드가 있는데 2번째가 실패하면 하한이 실제로 적용되지 않은 것입니다.
`apps/web/src/shared/chain/sendSponsoredOp.ts`의 `MIN_VERIFICATION_GAS`가 `150_000n` 인지 확인하고,
필요하면 **250,000**으로 올려 한 번 더 시도한 뒤 어느 값에서 통과했는지 §H에 적습니다
(그 숫자가 01b 재배포 후 실측값으로 대체됩니다).

### B-5. 시계와 화면

**조작**
- 스태프 폰: 설정 → 일반 → 날짜 및 시간 → **자동 설정(네트워크 제공 시간) 켜기**.
- 스태프 폰: 설정 → 디스플레이 → **화면 자동 꺼짐을 10분 이상** 으로. 개발자 옵션의 "충전 중 화면 켜짐 유지"도 켭니다.
- 관객 폰: NFC 켜짐.

**보여야 하는 것**: 두 폰의 시계가 초 단위로 같습니다.

**안 되면**: 게이트 코드는 체인이 `block.timestamp` 기준 **60초** 창으로 검사합니다. 단말기 시계가
1분 이상 틀리면 모든 탭이 `EXPIRED_CODE`로 떨어집니다. 이건 NFC 문제가 아니라 시계 문제입니다.

---

## C. 게이트 등록 (프로비저닝)

시드된 데모 데이터: **공연(event) 1**, **주최(org) 1**, 이미 등록된 **게이트 1** =
`0x212fDCCe82BFf0E548C39DDdAd319E0e140f3e04`, 회원 계정 3개, 티켓 `tokenId 1·2·3`
(`contracts/deployments/seed-10143.json`).

> **주의 — 새 게이트는 `gateId` 1이 아닙니다.** 시드가 1을 이미 썼으므로 당신의 폰은 **2**를 받습니다.

### C-1. 스태프 폰에서 로그인한다

**조작**: MONTI Staff 앱 → 화면에 "휴대폰 번호로 로그인" 단추가 보이면 누릅니다 → 번호 입력 → 문자 코드 입력.

**보여야 하는 것**: 설치 화면(`/staff/setup`)으로 돌아오고, 로그인 관련 오류가 사라집니다.

**안 되면**: `AUTH_REQUIRED` 가 계속 뜨면 §A-7의 `google-services.json`이 없거나 Firebase 전화 인증이
그 프로젝트에서 꺼진 것입니다.

### C-2. 게이트 주소와 공개키 좌표를 적는다

**조작**: 설치 화면에 **게이트 계정 주소**와, 그 아래 `kx` / `ky` 두 값이 mono 글꼴로 보입니다.
QR 코드도 같은 내용입니다(`MONTI-GATE1:` + JSON).

**보여야 하는 것**: `0x`로 시작하는 42자 주소 하나, `0x`로 시작하는 **66자** 값 두 개.

세 값을 맥북 터미널에 변수로 넣습니다(직접 타이핑하지 말고 QR을 읽거나 화면을 길게 눌러 복사하세요).

```bash
export R=https://testnet-rpc.monad.xyz
export ORGANIZERS=0x9f0c3c8d87531Ae343f06223FcaA507E6Efb1Fb9
export GATE_ACCOUNT=<폰에_보이는_주소>
export GATE_KX=<폰에_보이는_kx>
export GATE_KY=<폰에_보이는_ky>
```

**안 되면**: 주소 대신 "게이트 키를 만들 수 없어요"가 보이면 §B-1로 돌아갑니다.

### C-3. **보내기 전에** 이미 등록됐는지 확인한다

`registerGate`는 멱등이 아닙니다 — 이미 등록된 주소로 다시 보내면 `GateAccountInUse`로 되돌아옵니다.

```bash
cast call $ORGANIZERS "gateOf(address)(uint256)" $GATE_ACCOUNT --rpc-url $R
```

**보여야 하는 것**: `0`. (0이면 아직 미등록 = C-4로 진행)

**안 되면**: 0이 아닌 숫자가 나오면 **이미 등록된 것입니다.** C-4를 건너뛰고 C-5로 갑니다.

### C-4. 등록한다 — 두 갈래 중 하나

**갈래 ㉮ (권장) 웹 관리자 화면에서 승인**: 폰이 이미 신청을 큐에 올렸습니다. 주최자 웹의
대기 게이트 목록에서 같은 주소를 찾아 승인합니다. 폰 화면은 "관리자가 승인하면 이 화면이 저절로
넘어가요 · N초째 기다리는 중"으로 3초마다 체인을 폴링합니다.

> 폰 화면의 공연 번호 칸은 **`1`이 미리 채워져** 있지만 **"이 행사에 등록 요청" 단추를 눌러야**
> 신청이 나갑니다. 번호를 바꾸려면 누르기 전에 고치세요.

**갈래 ㉯ 컨트롤러가 직접 체인에 쓴다** (Task 13 보고서 §4 그대로). `<ORG_OWNER_PRIVATE_KEY>`는
org 1의 소유자 `0x509ed82E0FCaE0c8A6cdE6Ddeb12eb5dc836BCf3` 의 개인키입니다(저장소에 없습니다).

```bash
cast send 0x9f0c3c8d87531Ae343f06223FcaA507E6Efb1Fb9 \
  "registerGate(uint256,address,bytes32,bytes32)" \
  1 \
  $GATE_ACCOUNT \
  $GATE_KX \
  $GATE_KY \
  --rpc-url https://testnet-rpc.monad.xyz \
  --private-key <ORG_OWNER_PRIVATE_KEY>
```

| 자리 | 무엇 |
|---|---|
| `0x9f0c…1Fb9` | `Organizers` 주소 (`contracts/deployments/10143.json`, 고정) |
| `1` | 시드된 공연 번호 (고정) |
| `$GATE_ACCOUNT` | C-2에서 폰이 보여 준 주소 |
| `$GATE_KX` / `$GATE_KY` | **순서를 바꾸면 검증이 영원히 실패하고 되돌릴 수 없습니다** |

**보여야 하는 것**: `status 1 (success)`.

**안 되면**
- `GateAccountInUse` → 이미 등록됨. C-5로.
- `NotPermitted` / revert → 쓰는 키가 org 1의 소유자가 아닙니다.
- `eventOrg` 관련 revert → 공연 번호가 1이 아닙니다.

### C-5. 등록을 확인한다

```bash
cast call $ORGANIZERS "gateOf(address)(uint256)" $GATE_ACCOUNT --rpc-url $R
cast call $ORGANIZERS "gateInfo(uint256)(uint256,address,bytes32,bytes32,bool,bool)" <위에서_나온_gateId> --rpc-url $R
```

**보여야 하는 것**: `gateOf` = **2**(시드가 1을 썼으므로). `gateInfo`의 마지막 두 값이
`open` / `revoked` 입니다 — 지금은 `false false` 일 가능성이 높습니다.

### C-6. 문을 연다 (`open = true`)

체크인은 `isOpenGate(eventId, gateAccount)` 가 참이어야만 통과합니다.

```bash
cast send $ORGANIZERS "openGate(uint256)" <gateId> \
  --rpc-url $R --private-key <ORG_OWNER_PRIVATE_KEY>

cast call $ORGANIZERS "isOpenGate(uint256,address)(bool)" 1 $GATE_ACCOUNT --rpc-url $R
```

**보여야 하는 것**: 마지막 줄이 `true`.

**안 되면**: `false`면 ① `gateId`가 틀렸거나 ② 그 게이트의 `eventId`가 1이 아니거나 ③ `revoked`입니다.
폰 화면에 "아직 문을 열지 않았어요" 경고가 떠 있으면 바로 이 상태입니다.

---

## D. 탭 — 첫 end-to-end (온라인)

> **아래 §D~§G는 브리프가 아니라 착륙한 코드를 보고 쓴 것입니다.** 굵게 적힌 문구는 앱에 실제로 있는 문장 그대로입니다.

준비: 관객 폰에 시드 회원 계정 중 하나로 로그인되어 있고 **티켓 1장**(tokenId 1·2·3 중 하나)이 보입니다.
스태프 폰은 §C가 끝나 게이트 화면(대기 상태)에 있습니다.

### D-1. 게이트를 무장한다 (스태프)

**조작**: 스태프 폰 게이트 화면.

**보여야 하는 것**: 가운데에 **"여기에 대주세요"** 와 "휴대폰 뒷면을 화면 가운데에 대주세요.", 그리고 도는 원 하나.
머리글에는 게이트명 · 공연명(담당 이름) · 상태 한 줄(**기록 중 / 확정 / 연결 끊김** + 블록 번호) ·
명단 **"방금 받음"**(또는 "N분 전") · **입장 N명**.
1회용 번호는 **화면에 숫자로 뜨지 않습니다** — 뒤에서 **3초마다** 바뀌고, 도는 원이 그게 살아 있다는 표시입니다.

**안 되면**
- **"관리자가 아직 이 게이트의 문을 열지 않았어요."** 또는 **"이 게이트는 폐기됐어요. 관리자에게 문의하세요."**
  가 화면을 덮고 탭이 받아지지 않으면 문이 닫힌 것입니다 → §C-6. 게이트 화면은 열릴 때 한 번,
  그 뒤 **60초마다** `isOpenGate`를 다시 물으므로 문을 연 뒤 **최대 1분 안에 저절로 풀립니다**.
- 명단 나이가 줄지 않고 계속 늘기만 하면 스냅샷을 못 받은 것입니다. 스태프 로그인(§C-1)과 네트워크를 봅니다.

### D-2. 관객이 무장한다

**조작**: 관객 폰 → 티켓 → **"입장하기"** → 지문/얼굴(기기 잠금 인증).

**보여야 하는 것**: **60초 카운트다운**이 시작됩니다.

**안 되면**: 카운트다운이 안 뜨면 기기 키가 등록되지 않은 것입니다. 관객 계정의 기기 등록을 먼저 확인합니다.

### D-3. 탭한다

**조작**: 두 폰의 **등을 맞대고**(각 폰의 NFC 안테나 위치는 보통 카메라 아래쪽) 1~2초 붙입니다.

**보여야 하는 것 — 순서대로**

| 시점 | 스태프 화면 | 관객 폰 |
|---|---|---|
| 즉시 | **"표를 받았어요"** + 가려진 표 번호(`••` + 끝 두 자리) + 명단 한 줄("명단에서 확인했어요" 또는 "명단에 없는 표예요. 지금 확인할게요") | **진동** (관객 역할 끝) |
| ~0.7초 | **전면 초록 "✓ 입장"** + 큰 사진 + 이름 + 등급·좌석 + 블록 번호 + **"기록하고 있어요"** (추측 실행) | — |
| ~1.3초 | 같은 초록의 마지막 줄이 **"확정됐어요"** 로 바뀌고, 머리글도 **확정**이 됩니다 | 잠시 뒤 "입장 완료" 푸시 |
| 2초까지 조용하면 | **"확인 중입니다"** + 점 세 개 | — |
| 5초 넘으면 | 같은 카드에 **"잠시만 기다려 주세요"** 한 줄이 덧붙습니다 | — |

> **"다시 대세요"는 이제 나오지 않습니다.** 5초는 조언이지 판정이 아니라서, 6초에 도착한 승인도 그대로 초록입니다.
> 그 문구가 있던 시절에는 관객이 한 번 더 대서 같은 표가 두 번 나갔습니다 — 옛 문구가 보이면 그게 실패입니다.
>
> **초록은 저절로 사라지지 않습니다.** 카드의 **"다음"** 을 눌러야 게이트가 다음 관객을 받습니다.
>
> **본인인증이 없는 공연**에서는 사진 자리에 **닉네임 첫 글자 아바타**가 그려집니다 — 사진을 못 받은 게 아닙니다.

실측 기준(스펙 §7.3): 중간값 **0.7초(추측) / 1.3초(확정)**, 최악 **3.0 / 3.6초**.

**안 되면 — 화면에는 코드가 아니라 문장이 뜹니다** (코드는 `adb logcat`에 있습니다)

- 아무 일도 없음 → NFC 안테나 위치를 바꿔 가며 5초씩, 3회. 그래도 없으면 §B-2로.
- **"시간이 지난 표시예요. 다시 대주세요"**(`EXPIRED_CODE`) → 시계(§B-5) 또는 탭이 60초 창을 넘겼습니다. 다시 무장하고 재탭.
- **"다른 입구로 가주세요"**(`GATE_MISMATCH`) → 관객 폰이 **다른 게이트의 번호**를 읽었습니다(근처에 다른 단말기).
- **"아직 이 문을 열지 않았어요"**(`GATE_CLOSED`) → §C-6으로 돌아가 문을 엽니다.
- **"보내지 못했어요. 다시 대주세요"**(`TX_FAILED`) → 문장 아래 작은 글씨에 사유가 붙습니다. `NotMember`(계정 교체로 밀려난 옛 계정)와 `RotationPending`이 여기로 들어옵니다.
- **"이유를 읽지 못했어요. 관리자에게 문의하세요"**(`UNKNOWN_REVERT`) → 작은 글씨를 §H에 그대로 옮겨 적습니다.
- `AA23 out of gas` → §B-4. 화면에는 "보내지 못했어요"로 보입니다.

### D-4. 체인에 실제로 기록됐는지 직접 확인한다

```bash
export TICKET=0xE9686503c4d675B0B1Ec9DE19AbEC51Fc59F1113
cast call $TICKET "checkInOf(uint256)" <tokenId> --rpc-url $R
```

**보여야 하는 것**: 0이 아닌 값들 — `gateId`가 §C-5의 숫자, `ts`가 방금 시각.

**안 되면**: 전부 0이면 화면만 초록이고 체인에는 없는 것입니다. **이건 심각한 오판정입니다.**
§H에 "오판정 1건"으로 반드시 적으세요.

### D-5. 연속 3회 (AA23 확인)

**조작**: 서로 다른 티켓 3장으로 D-2~D-3을 3번 반복합니다. 한 장이 끝날 때마다 **"다음"** 을 눌러 화면을 비웁니다.

**보여야 하는 것**: 3번 모두 초록. 특히 **2번째와 3번째**가 중요합니다(§B-4).

**같이 볼 것 — 직전 탭 칸**: 화면 맨 아래에 **"직전 · 입장 · 이름"** 한 줄이 남습니다(거절이었으면 사유까지).
다음 관객을 받는 중에도 이 줄이 살아 있어야 합니다 — "방금 그 사람 들어간 거 맞아요?"에 답하는 유일한 자리입니다.
아직 아무도 안 댔으면 **"아직 없어요"**.

### D-6. 더블 탭 (같은 티켓 두 번)

**조작**: 방금 입장시킨 티켓으로, **"다음"을 눌러 화면을 비운 뒤** 다시 탭합니다.

**보여야 하는 것**: 두 번째는 빨간 **"✕ 입장 불가 · 이미 입장했어요"**. 초록이 두 번 뜨면 **실패**입니다.

**참고 — 게이트는 한 번에 한 사람만 받습니다.** 앞사람이 끝나기 전에 다음 사람이 대면 그 탭은 **거부**됩니다.
이건 관객 표의 문제가 아니라 게이트 사정이라, 빨간 거절 화면이 아니라 **위쪽 회색 알림 줄**로만 뜹니다.

| 언제 | 알림 줄 |
|---|---|
| 앞사람이 "확인 중입니다"인데 다음 사람이 댐 | **"앞사람을 확인하고 있어요. 잠시만 기다려 주세요"** |
| 판정 카드가 떠 있는데("다음"을 안 누름) 다음 사람이 댐 | **"화면을 읽고 다음을 눌러 주세요"** |

두 경우 모두 **앞사람의 카드가 그대로 남아 있어야** 합니다. 뒤에서 댄 탭이 앞사람 화면을 밀어내면 실패입니다 —
앞사람은 체인에 입장으로 기록되는데 화면은 그 사실을 잃습니다. 알림 줄이 빨갛거나 "입장 불가"로 읽히면
그것도 적어 주세요(뒤에 선 사람이 자기가 거절당했다고 읽습니다).

### D-7. 관객 푸시

**보여야 하는 것**: 관객 폰에 "입장 완료" 알림. 이건 **판정 근거가 아니라 알림**입니다 — 안 와도
체인 기록이 있으면 통과입니다(§H에 별도로 적습니다).

---

## E. 오프라인 (단말기 비행기 모드)

> 01b 재배포 전까지 **플러시는 드라이런**입니다 — 큐가 쌓이고, 순서가 지켜지고, 재접속을 감지하지만
> `checkInLate`가 ABI에 없으므로 **실제 전송은 하지 않습니다.**

### E-1. 게이트를 오프라인으로 만든다

**조작**: 스태프 폰 **비행기 모드 켜기** (Wi-Fi·LTE 전부). 관객 폰은 그대로 둡니다.

**보여야 하는 것**: 머리글 상태가 **"연결 끊김"** 으로 바뀌고, 그 아래 배너에 **"연결 끊김 · 명단 N분 전"**.
비행기 모드는 라디오가 죽은 것을 OS가 바로 알려주므로 **거의 즉시** 바뀝니다.

> 와이파이는 붙어 있는데 체인만 안 닿는 경우는 다릅니다 — 탐침이 **2번 연속** 실패해야 오프라인으로 갑니다.
> 탭을 기다리는 중에는 **5초**, 아무 일 없을 때는 **30초** 간격이라 최대 1분쯤 걸립니다.
> 돌아올 때는 **1번만** 성공하면 바로 온라인입니다.

**안 되면**: 상태가 안 바뀌면 화면을 껐다 켭니다(가시성 복귀 시 즉시 한 번 탐침합니다).

### E-2. 오프라인으로 5장 탭한다

**조작**: 아직 입장하지 않은 티켓 5장으로 §D-2~D-3을 반복합니다.

**보여야 하는 것**: 매번 **초록이 아닌 호박색 카드** — **"! 연결 없이 입장"** + 사진(또는 아바타) + 이름 +
**"연결이 돌아오면 기록할게요"** + **"보낼 입장 N건"**. 테두리가 굵은 점선이라 방 건너편에서도 초록과 섞이지 않습니다.
그 "보낼 입장" 숫자가 1 → 2 → 3 → 4 → 5로 올라갑니다.

여기서 검증은 **체인이 아니라 폰 안에서** 일어납니다: 서명된 스냅샷으로 관객 기기 서명을 로컬에서
WebCrypto P-256으로 검증합니다.

**안 되면**
- 빨간 **"표를 산 휴대폰이 아니에요"**(`DEVICE_MISMATCH`) → 스냅샷이 오래됐습니다(기기 교체 후 스냅샷 미갱신).
  온라인으로 돌아가 스냅샷을 새로 받고 다시 시도합니다.
- 초록 **"✓ 입장"** 카드가 뜨면 오프라인 경로를 타지 않은 것입니다 — 비행기 모드가 실제로 켜졌는지 봅니다.

### E-3. 큐가 **저장**됐는지 확인한다 (앱을 죽여 본다)

**조작**: 스태프 앱을 강제 종료하고 다시 엽니다 (최근 앱 → 위로 밀기).

**보여야 하는 것**: 대기 건수가 **여전히 5건**입니다. 화면보다 저장이 먼저이므로 0이 되면 안 됩니다.

**안 되면**: 0이 되면 저장-먼저 불변식이 깨진 것입니다. 심각합니다 — §H에 크게 적으세요.

### E-4. 재접속 → 플러시 (드라이런)

**조작**: 비행기 모드를 끕니다.

**보여야 하는 것 (재배포 전, 오늘)**
- 머리글이 **기록 중 / 확정**으로 돌아옵니다("연결 끊김"이 사라집니다).
- 대기 건수는 **5건 그대로**입니다 — 줄어들지 않는 게 정상입니다.
- 큐 배너에 **"이 단말기로는 늦은 입장 기록을 보낼 수 없어요. 앱을 새로 받아 주세요."** 가 뜹니다.
- 로그(`adb logcat`)에 드레인당 한 줄: `CHECK_IN_LATE_UNAVAILABLE`.

**보여야 하는 것 (재배포 후, 2회차 §I)**
- 큐 화면 맨 윗줄이 **"대기 0건 · 기록 완료 5건 · 충돌 0건 · 멈춤 0건"**.
- 체인에서 `CheckedInLate` 이벤트 5건.

**안 되면 (재배포 후에)**
- 5건이 한꺼번에 멈추고 **"행사 마감이 지나서 보내지 못했어요."** 가 보이면 `LATE_WINDOW_ELAPSED` 입니다.
  기준은 **탭 시각이 아니라 공연 종료 시각 + 12시간**입니다 — 탭 시각부터 굴러가는 12시간이 아닙니다.
  (21시에 끝나는 공연이면 20시에 받은 탭도 다음 날 9시까지는 체인이 받아 줍니다.)
- 그냥 전송이 안 되는 경우는 1초 → 2초 → … 최대 1분 간격으로 **20번** 다시 시도한 뒤 멈춤으로 넘어갑니다.
  **삭제되지는 않습니다.**
- 보내긴 했는데 체인에 흔적이 없는 줄은 **10분 뒤 저절로 한 번 더 보냅니다 — 최대 3번**. 세 번을 다 쓰면
  **"여러 번 다시 보냈는데도 기록되지 않았어요. 주최자에게 알리세요."** 로 멈추고, 그 뒤로는 사람이
  §E-5의 **"다시 보내기"** 를 눌러야 합니다.

### E-5. 대사(reconcile) — 이중 입장이 있었는지

**조작**: **"대기 · 충돌"** 화면을 열고 **"지금 맞춰 보기"** 를 누릅니다.

**보여야 하는 것**: 맨 윗줄에 **"대기 N건 · 기록 완료 N건 · 충돌 N건 · 멈춤 N건"**.
그 아래 두 묶음이 있을 때만 나옵니다.

| 묶음 | 무엇이 보이나 | 단추 |
|---|---|---|
| **충돌** | "티켓 N · M번 게이트가 hh:mm:ss에 먼저 받았어요" (상대가 수동 승인이었으면 "…에서 수동 승인됐어요") | **없습니다.** 이미 들어간 사람은 되돌릴 수 없어서, 이 줄은 읽어 주라고 있는 것입니다 |
| **멈춤** | 티켓 번호 + 멈춘 이유 한 문장 | 줄마다 **"다시 보내기"** |

**멈춘 줄은 저절로 나가지 않습니다.** 신호가 돌아왔으면 창업자가 **손으로 하나씩** 눌러야 합니다 —
이게 이 섹션에서 제일 중요한 한 줄입니다. 누르는 동안 나머지 단추는 잠기고(한 번에 하나), 누른 줄은
"보내는 중"으로 바뀝니다. 줄이 목록에서 사라지지 않고 제자리에 있어야 정상입니다.

대사는 `checkInOf(tokenId)`를 읽고 그 안의 `nonceHash`가 **우리 코드의 논스**와 같은지로
"우리 체크인인가 남의 체크인인가"를 가릅니다. 같으면 **기록 완료**, 다르면 **충돌**입니다.

**안 되면**: 정상 체크인이 "충돌"로 찍히면 논스 판별이 깨진 것입니다 — 우리 성공을 보안 사고로
기록하는 것이므로 §H에 반드시 적습니다.

### E-6. 두 게이트 동시 (선택, 스태프 폰이 2대일 때만)

**조작**: 두 게이트 모두 오프라인으로 두고, 같은 티켓을 각각 탭합니다. 그 뒤 둘 다 온라인으로.

**보여야 하는 것**: 정확히 **한쪽만 기록 완료**, 다른 쪽은 **충돌** 줄에 승자 게이트 번호와 시각이 함께.
둘 다 "기록 완료"면 실패입니다.

---

## F. QR 폴백 (NFC가 안 될 때)

### F-1. 관객이 QR을 띄운다

**조작**: 관객 폰 → 입장 화면 → "QR로 보여주기".

**보여야 하는 것**: `MONTI1:` 로 시작하는 내용의 QR. 이건 NFC로 보냈을 **같은 `{tokenId, 서명}`** 입니다.

### F-2. 스태프가 찍는다

**조작**: 스태프 게이트 화면의 **"QR로 확인"** 단추 → 카메라 권한 허용 → 관객 QR을 비춥니다.

**보여야 하는 것**: 디코드 이후는 **NFC와 완전히 동일**합니다 — **"표를 받았어요"** → 초록 **"✓ 입장"** + 사진.

**안 되면 — 화면에 뜨는 문장으로 갈립니다**

| 보이는 문장 | 무엇을 한다 |
|---|---|
| **"카메라를 쓸 수 없어요. 설정에서 카메라 권한을 켜고 다시 누르세요."** | 설정 → 앱 → MONTI Staff → 권한 → 카메라 허용 후 단추를 다시 누릅니다 |
| **"이 단말기에서는 QR을 읽을 수 없어요. NFC로 받아 주세요."** | 구글 Play 서비스의 코드 스캐너 모듈이 없는 것입니다(`SCAN_UNAVAILABLE`). 그 모듈은 **인터넷으로 내려받습니다** — 완전 오프라인에서 처음 스캔하면 여기로 떨어집니다. **현장 도착 전에 온라인에서 스캔을 한 번 해 두세요.** 이게 이 섹션의 가장 중요한 한 줄입니다 |
| **"입장 QR이 아니에요. 관객 화면의 QR을 비춰 주세요."** | MONTI 코드가 아닌 QR을 읽었습니다. 한 화면에 남의 QR이 같이 잡혀도 MONTI 것만 골라냅니다 |
| **"QR을 읽지 못했어요. 다시 누르세요."** | 카메라가 이유 없이 실패했습니다. 한 번 더 |

카메라를 그냥 닫으면(취소) **아무 문장도 뜨지 않고** 대기 화면으로 돌아옵니다 — 오류가 아닙니다.
아무것도 못 읽은 채 닫힌 경우도 같은 취소로 처리됩니다. 여기서 영어 원문(`scan canceled.`)이나
"전송 실패"가 보이면 그건 실패이니 §H에 적으세요.

---

## G. 수동 승인 (04 T32 착륙 이후)

> **승인을 실제로 보내는 코드는 아직 없습니다.** 지금 들어와 있는 것은 **창 껍데기**뿐이라,
> 이번 회차에는 **화면이 제대로 뜨는지까지만** 봅니다. 승인·결재 전송은 T32 이후입니다.

### G-1. 수동 승인 창을 연다

**조작**: 입장이 거부된 관객 앞에서 수동 승인으로 들어갑니다.

**보여야 하는 것**: **"수동 승인"** 제목, 가려진 **PIN** 칸(숫자만 들어갑니다), 사유 고르는 칸 —
**사진 대조 / 휴대폰 문제 / 시간이 지난 표시 / 기타** 네 개, 그리고 **"취소"**.

**안 되면**: PIN을 미리 설정하는 화면은 **없습니다** — 찾지 마세요. PIN 검사와 저장 방식은 전부 T32 몫입니다.

### G-2. 권한이 있을 때 — 단추가 "수동 승인"

**보여야 하는 것**: 승인 권한(`PERM_APPROVE_OVERRIDE`)이 있는 계정에서는 단추가 **"수동 승인"** 입니다.
지금 누르면 체인에 나가는 것은 없습니다(배선이 T32). 문구와 사유 네 개가 맞는지만 §H에 적습니다.

**안 되면**: §B-3이 미해결이면 스태프 패스키 계정이 없으므로, T32가 들어와도 이 경로는 **실행 불가**입니다.
§H에 "G: B-3 대기로 미실행"이라고 적습니다.

### G-3. 권한이 없을 때 — 단추가 "결재 요청 보내기"

**보여야 하는 것**: 같은 자리의 단추가 **"결재 요청 보내기"** 로 바뀝니다.
권한 없는 스태프에게 **눌리지 않는 단추를 보여 주지 않는 것**이 이 화면의 규칙입니다 —
비활성 단추가 보이면 그것도 §H에 적으세요. 관객이 아무 데도 못 갑니다.

---

## H. 결과표와 되돌려 보낼 것

### H-1. 결과표 (이 표를 채워서 보내 주세요)

기록은 손으로 적습니다 — NDJSON 로거(`exportFieldLog()`)는 **아직 코드가 없습니다**.

| # | 항목 | 통과/실패/보류 | 관측한 것 (시간·오류 코드·블록 번호) |
|---|---|---|---|
| A-1 | 도구(JDK 21, ANDROID_HOME, SDK 36) | | |
| A-5 | 웹 테스트 전부 초록 | | |
| A-6 | `pnpm sync:staff` 성공, 플러그인 10개 | | |
| A-8 | `:app:assembleDebug` 첫 성공 | | KGP/AGP 손댔으면 어떻게 |
| A-9 | 코틀린 82개 테스트 | | 실패 클래스 이름 |
| A-10 | 스태프 폰 설치 | | |
| **B-1** | **StrongBox + `DIGEST_NONE` 키 생성** | | 성공한 조합(StrongBox/TEE, DIGEST_NONE 유무) |
| **B-2** | **"탭하고 결제하기"에 MONTI Staff** | | `CLAIM_REFUSED` 여부 |
| B-3 | 패스키 / `monti.despell.io` | (보류 예상) | 서명키·assetlinks·allowed-origin 중 무엇이 없는가 |
| **B-4** | **2번째·3번째 UserOp 성공 (AA23)** | | 통과한 `verificationGasLimit` 값 |
| B-5 | 시계·화면·Secure NFC | | |
| C-4 | `registerGate` 성공 | | tx 해시 |
| C-5 | `gateOf` = ? | | 실제 gateId (2 예상) |
| C-6 | `isOpenGate` = true | | |
| **D-3** | **첫 탭 초록** | | 초록까지 몇 초 / 확정까지 몇 초 / 블록 번호 |
| D-4 | 체인 `checkInOf` 확인 | | gateId, ts |
| D-5 | 연속 3탭 | | 3/3? |
| D-6 | 더블 탭 → `ALREADY_USED` | | |
| D-7 | 관객 푸시 도착 | | |
| E-1 | OFFLINE 배지 전환 | | 몇 초 걸렸나 |
| E-2 | 오프라인 5탭 (앰버 테두리) | | 5/5? |
| E-3 | 앱 강제종료 후 대기 5건 유지 | | |
| E-4 | 재접속 → 드라이런 로그 | | `CHECK_IN_LATE_UNAVAILABLE` 보였나 |
| E-5 | 대사 화면 상태 | | 기록됨/충돌/미기록 건수 |
| F-2 | QR 스캔 → 같은 초록 | | `SCAN_UNAVAILABLE` 여부 |
| G | 수동 승인 | (T32 대기) | |
| — | **오판정(화면 초록인데 체인에 없음)** | | **반드시 0이어야 함. 몇 건?** |
| — | **Apple Pay/삼성페이 화면이 떴는가** | | 0회여야 함 |

### H-2. 되돌려 보낼 것

1. **위 표** (채운 것).
2. **logcat 덤프** — 테스트를 시작하기 전에 켜고, 끝나면 저장합니다.

```bash
# 시작 전
adb logcat -c
adb logcat -v time > ~/monti-fieldtest-$(date +%Y%m%d-%H%M).log

# 필요한 줄만 따로 보고 싶을 때
adb logcat -s Capacitor:V "Capacitor/Console:V" CapacitorPlugins:V \
           NfcService:V HostEmulationManager:V AndroidKeyStore:V
```

찾아야 하는 문자열: `KEY_GENERATION_FAILED`, `CLAIM_REFUSED`, `AA23`, `UnknownSender`,
`CHECK_IN_LATE_UNAVAILABLE`, `LATE_WINDOW_ELAPSED`, `GateAccountInUse`, `SCAN_UNAVAILABLE`.

3. **Gradle 빌드 로그** (실패했다면): `./gradlew :app:assembleDebug --stacktrace 2>&1 | tee ~/monti-gradle.log`
4. **체인 증거**: §C-4의 tx 해시, §D-4의 `checkInOf` 출력, 게이트 계정 주소.
5. 사진/영상 한 개 — 초록 화면과 앰버 테두리 화면.

보고서 경로(에이전트가 읽습니다):
`/Users/moomi/Downloads/z03.Vibe_Coding/MONTI/MONTI-prod/.superpowers/sdd/2026-09-20-monti-04-staff-android/task-33-report.md`

---

## I. 2회차(01b 재배포 이후) 시작 전 사전 점검 — flip-day

> **1회차에는 읽지 않습니다.** 01b 계약 재배포가 끝난 날, §D~§E를 **다시** 돌리기 전에 이 목록을 확인합니다.
> Task 34의 머지 체크리스트(`docs/superpowers/plans/2026-09-22-monti-merge-checklist.md`)가
> 착륙하면 그쪽이 정본이고, 이 표는 그 문서의 "flip-day" 절과 대조해서 씁니다.
> (이 문서를 쓴 시점에 그 파일은 아직 없어서, 진행 원장에서 항목을 옮겨 적었습니다.)

| # | 항목 | 확인 방법 | 안 하면 |
|---|---|---|---|
| I-1 | **`DEVICE_DIGEST_FORM`을 web·staff 두 브랜치에서 같은 날 v2로 뒤집는다** | 두 브랜치의 `packages/shared/src/encoding.hash.test.ts` 알람이 함께 초록 | 관객 서명이 문 앞에서 전부 거부됩니다 |
| I-2 | **`checkInOf` 튜플 순서** `(gateId, nonceHash, ts, manual, late)` | `apps/web/src/shared/chain/reads.ts` 의 `CHECK_IN_FIELDS` 핀 테스트 | 대사(§E-5)가 엉뚱한 필드를 읽어 정상 체크인을 충돌로 기록 |
| I-3 | **`CheckedInLate` 이벤트**를 구독이 덮는가 | `abis.test.ts`의 indexed 순서 핀 | 오프라인 기록이 화면에 영영 안 뜸 |
| I-4 | **`checkInLate` 함수를 `USED_ABI.Ticket`에 등록**하고 `checkInOp.ts`의 임시 캐스트를 지운다 | `opQueue` 의 트립와이어 테스트가 **깨지면서** 이 정리를 강제합니다 | §E-4가 계속 드라이런 |
| I-5 | **EIP-712 offers** (양도 경로) | 01b 재배포 번들 계획서 | 양도 데모가 실패 |
| I-6 | **인덱서 재시작** (새 주소·새 시작 블록) | Envio가 새 배포 블록부터 다시 읽는지 | 화면의 입장 수·목록이 옛 배포본에 머무름 |
| I-7 | **Tenderly 알림**을 새 계약 주소로 재설정 | 알림이 새 `CheckedIn`에 반응 | 관객 푸시(§D-7)가 안 옴 |
| I-8 | **환경변수의 계약 주소 4개**를 web·staff·백엔드에서 동시에 교체 | `VITE_ADDR_IDENTITY / ORGANIZERS / TICKET / PAYMASTER` | 앱이 옛 계약을 보고 `UnknownSender` |
| I-9 | **게이트를 새 배포본에 다시 등록**한다 | §C 전체를 다시 (`gateOf`는 새 계약에서 0부터 시작) | 문 앞에서 `UnknownSender` |
| I-10 | **§B-4의 가스 하한을 실측값으로 교체** | 첫 스폰서 옵의 실제 네 가스 필드를 기록 | 하한이 추측값으로 남음 |

재배포 후 2회차는 **§C 전체 → §D 전체 → §E 전체**를 다시 돌리고, §E-4에서 이번에는
**대기 5 → 0, 기록됨 5건**이 나와야 합니다.
