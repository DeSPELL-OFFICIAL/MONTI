import { HCE_AID } from '@monti/shared';
import { describe, expect, it } from 'vitest';
import apduStateMachineKt from '../android/src/main/java/app/monti/hce/ApduStateMachine.kt?raw';
import hceBridgeKt from '../android/src/main/java/app/monti/hce/HceBridge.kt?raw';
import manifestXml from '../android/src/main/AndroidManifest.xml?raw';
import apduServiceXml from '../android/src/main/res/xml/monti_apduservice.xml?raw';
import stringsXml from '../android/src/main/res/values/strings.xml?raw';
import serviceKt from '../android/src/main/java/app/monti/hce/MontiHostApduService.kt?raw';

/**
 * 등록이 틀리면 **아무 일도 일어나지 않는다**. 예외도 로그도 상태어도 없다 — OS 가 서비스를
 * 깨우지 않으니 상태 기계는 애초에 불리지 않고, 게이트 앞의 직원은 "관객 폰이 이상한가 보다"로
 * 읽는다. APDU 한 줄을 틀리면 6A82 라도 돌아오지만 여기는 그마저 없다.
 *
 * 그래서 이 파일은 XML 을 **원본에서 읽어** 요소 단위로 본다. `xml.contains("other")` 같은
 * 부분 문자열 검사는 값이 엉뚱한 요소에 붙어도 통과하므로, 작은 스캐너로 요소와 속성을 갈라
 * "`aid-group` 의 category 가 other" 처럼 자리까지 말한다.
 *
 * 같은 검사가 `ApduServiceManifestTest.kt` 에도 있다. 이 기계에는 Android SDK 가 없어 그쪽은
 * 아직 컴파일된 적이 없으므로, 오늘 실제로 도는 것은 이 파일이다.
 */

// ── 아주 작은 XML 스캐너 (속성이 어느 요소에 붙어 있는지까지 본다) ───────────

type Attributes = Readonly<Record<string, string>>;

/** `<tag a="1" b="2">` / `<tag ... />` 를 찾아 속성 맵으로 준다. 주석은 먼저 걷어낸다. */
function elements(xml: string, tag: string): Attributes[] {
  const body = xml.replace(/<!--[\s\S]*?-->/g, ' ');
  const open = new RegExp(`<${tag}(\\s[^>]*?)?/?>`, 'g');
  const found: Attributes[] = [];
  for (const match of body.matchAll(open)) {
    const attributes: Record<string, string> = {};
    for (const pair of (match[1] ?? '').matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) {
      attributes[pair[1] as string] = pair[2] as string;
    }
    found.push(attributes);
  }
  return found;
}

/** 요소가 정확히 하나라고 주장하고 그 속성을 준다. 둘이면 어느 쪽이 이기는지 모른다. */
function only(xml: string, tag: string): Attributes {
  const found = elements(xml, tag);
  expect(found, `<${tag}> 가 정확히 하나여야 한다`).toHaveLength(1);
  return found[0] as Attributes;
}

const squeeze = (text: string): string => text.replace(/\s+/g, ' ').trim();

/**
 * `ApduStateMachine.kt` 가 SELECT 에 견주는 AID 리터럴. 아래 테스트가 이 줄이 원본에 그대로
 * 있는지 확인하고, 같은 줄을 hex 로 풀어 등록된 AID 와 맞춰 본다 — 한쪽만 고치면 깨진다.
 */
const AID_SOURCE_LINE = '0xD2.toByte(), 0x76, 0x00, 0x00, 0x85.toByte(), 0x01, 0x01,';

const aidSpelledBySource = AID_SOURCE_LINE.replace(/\.toByte\(\)/g, '')
  .split(',')
  .map((byte) => byte.trim())
  .filter((byte) => byte !== '')
  .map((byte) => (Number(byte) & 0xff).toString(16).padStart(2, '0').toUpperCase())
  .join('');

describe('the AID registration the OS reads', () => {
  it('registers the NFC Forum Type 4 Tag AID, the one @monti/shared names', () => {
    // 독자 AID 가 아니라 표준 AID 여야 관객 폰이 앱 없이, 기본 NFC 리더로 이걸 태그로 읽는다.
    expect(only(apduServiceXml, 'aid-filter')['android:name']).toBe(HCE_AID);
    expect(HCE_AID).toBe('D2760000850101');
  });

  it('answers SELECT with the very AID it registered', () => {
    // 등록한 AID 와 상태 기계가 견주는 AID 가 갈라지면 OS 는 서비스를 깨우지만 상태 기계가
    // 6A82 로 거절한다 — 리더에는 "태그는 있는데 우리 것이 아님"으로 보인다.
    expect(squeeze(apduStateMachineKt)).toContain(AID_SOURCE_LINE);
    expect(aidSpelledBySource).toBe(HCE_AID);
  });

  it('puts the AID in category "other", never payment', () => {
    // payment 로 등록하면 OS 가 이 서비스를 기본 결제 앱 우선순위 싸움에 끌어들인다.
    expect(only(apduServiceXml, 'aid-group')['android:category']).toBe('other');
    expect(apduServiceXml).not.toContain('category="payment"');
  });

  it('serves a locked phone, because nobody unlocks the staff phone per tap', () => {
    expect(only(apduServiceXml, 'host-apdu-service')['android:requireDeviceUnlock']).toBe('false');
  });

  it('names every string resource it points at', () => {
    // aapt 는 없는 @string 참조에서 빌드를 멈춘다. 컴파일해 볼 수 없으니 여기서 본다.
    const referenced = [...apduServiceXml.matchAll(/@string\/([A-Za-z0-9_]+)/g)].map((m) => m[1]);
    expect(referenced.length).toBeGreaterThan(0);
    const declared = elements(stringsXml, 'string').map((s) => s['name']);
    for (const name of referenced) expect(declared).toContain(name);
  });
});

describe('the service declaration the OS binds', () => {
  const service = only(manifestXml, 'service');

  /** 이름으로 고른다 — <uses-feature> 는 이제 둘이다. */
  const feature = (name: string): Attributes => {
    const found = elements(manifestXml, 'uses-feature').filter((f) => f['android:name'] === name);
    expect(found, `<uses-feature ${name}> 가 정확히 하나여야 한다`).toHaveLength(1);
    return found[0] as Attributes;
  };

  it('points at MontiHostApduService', () => {
    expect(service['android:name']).toBe('app.monti.hce.MontiHostApduService');
  });

  it('is exported and bindable only by the system', () => {
    // 둘 중 하나라도 빠지면 탭이 조용히 아무 일도 하지 않는다: exported 가 없으면 OS 가
    // 묶지 못하고, permission 이 없으면 아무 앱이나 묶을 수 있다.
    expect(service['android:exported']).toBe('true');
    expect(service['android:permission']).toBe('android.permission.BIND_NFC_SERVICE');
  });

  it('listens for the HOST_APDU_SERVICE intent', () => {
    expect(only(manifestXml, 'action')['android:name']).toBe(
      'android.nfc.cardemulation.action.HOST_APDU_SERVICE',
    );
  });

  it('hands the OS the AID registration through the meta-data it expects', () => {
    const meta = only(manifestXml, 'meta-data');
    expect(meta['android:name']).toBe('android.nfc.cardemulation.host_apdu_service');
    // 이 리소스 이름이 곧 위에서 읽은 파일이다. 어긋나면 AID 가 하나도 등록되지 않는다.
    expect(meta['android:resource']).toBe('@xml/monti_apduservice');
  });

  it('asks for the NFC permission', () => {
    expect(only(manifestXml, 'uses-permission')['android:name']).toBe('android.permission.NFC');
  });

  it('does not make HCE hardware an install requirement for the whole app', () => {
    // 브리핑은 required="true" 였다. 이 라이브러리 매니페스트는 apps/web 한 앱으로 병합되고
    // 그 앱에는 attendee·organizer·staff 가 다 들어 있으므로, true 면 Play 가 HCE 없는
    // 기기에서 관객까지 설치하지 못하게 한다. 없는 기기는 start() 가 거절한다.
    expect(feature('android.hardware.nfc.hce')['android:required']).toBe('false');
  });

  it('declares plain NFC optional too, or the permission would filter the app anyway', () => {
    // <uses-permission android:name="android.permission.NFC" /> 는 플랫폼의 permission→feature
    // 표에 따라 android.hardware.nfc 를 required="true" 로 **암묵 선언**한다. 명시로 덮어쓰지
    // 않으면 위의 .hce required="false" 가 두 줄 위에서 무효가 된다.
    expect(feature('android.hardware.nfc')['android:required']).toBe('false');
  });
});

describe('the Kotlin that sits between the OS and the state machine', () => {
  it('keeps the state machine in a process singleton, not in the service', () => {
    // 서비스는 탭마다 OS 가 만들고 파괴한다. 상태 기계가 그 안에 있으면 setPayload 로 걸어 둔
    // 게이트 코드가 탭마다 사라진다.
    expect(squeeze(hceBridgeKt)).toContain('object HceBridge');
    expect(squeeze(hceBridgeKt)).toContain('val machine: ApduStateMachine = ApduStateMachine { message -> onWrite?.invoke(message) }');
  });

  it('lets the binder thread see a listener the main thread just attached', () => {
    expect(squeeze(hceBridgeKt)).toContain('@Volatile var onWrite: ((ByteArray) -> Unit)? = null');
  });

  it('empties the payload when the gate stops, rather than keep serving the last code', () => {
    expect(squeeze(hceBridgeKt)).toContain('machine.setPendingPayload(ByteArray(0)) machine.onDeactivated()');
  });

  it('delegates both service callbacks and decides nothing itself', () => {
    expect(squeeze(serviceKt)).toContain('return HceBridge.machine.process(apdu)');
    expect(squeeze(serviceKt)).toContain('override fun onDeactivated(reason: Int) { HceBridge.machine.onDeactivated() }');
  });

  it('never answers null, which a reader reads as silence until it times out', () => {
    // 상태어가 Task 3 에서 const val Int 가 됐으므로 respond() 를 거쳐야 배열이 된다.
    expect(squeeze(serviceKt)).toContain(
      'val apdu = commandApdu ?: return ApduStatus.respond(sw = ApduStatus.SW_WRONG_LENGTH)',
    );
  });
});

describe('the whole plugin, swept', () => {
  const sources = import.meta.glob('../android/src/main/**/*.{kt,xml}', {
    query: '?raw',
    import: 'default',
    eager: true,
  });

  it('reads every Kotlin and XML file under src/main, so a new one cannot slip the sweep', () => {
    expect(Object.keys(sources).length).toBeGreaterThanOrEqual(8);
  });

  it('uses no reader-mode API anywhere', () => {
    // 이 쪽은 카드다. 리더 모드를 켜면 같은 폰이 읽는 쪽도 되려 하고 두 역할이 한 안테나를
    // 두고 싸운다. 게이트의 리더는 관객 폰이다.
    const offenders = Object.entries(sources)
      .filter(([, text]) => text.includes('enableReaderMode') || text.includes('enableForegroundDispatch'))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });
});
