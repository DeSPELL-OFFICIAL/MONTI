import { encodeGateResponse, NDEF_GATE_TYPE, NDEF_RESPONSE_TYPE } from '@monti/shared';
import type { GateResponseWire } from '@monti/shared';
import { describe, expect, it } from 'vitest';
import apduStateMachineKt from '../android/src/main/java/app/monti/hce/ApduStateMachine.kt?raw';
import apduStatusKt from '../android/src/main/java/app/monti/hce/ApduStatus.kt?raw';
import type4FilesKt from '../android/src/main/java/app/monti/hce/Type4Files.kt?raw';

/**
 * `ApduStateMachineTest.kt`·`ApduWriteTest.kt`와 **같은 APDU 요청/응답 벡터**를 오늘 실행한다.
 * 이 기계에는 Android SDK가 없어 JUnit 쪽이 아직 한 번도 돌지 않았기 때문이다.
 *
 * 상수(상태어·AID·파일 id)는 Kotlin 원본에서 뽑아 쓴다 — Task 2가 `type4.test.ts`에서 한
 * 방식 그대로다. 하지만 상태 기계는 상수가 아니라 **분기**라서 원본에서 뽑아낼 수 없으므로,
 * 여기서는 두 가지를 같이 한다.
 *
 *  1. Kotlin과 같은 모양의 TS 참조 구현을 두고 같은 벡터를 돌린다 (§reference).
 *     벡터가 자기모순이 아님을, 그리고 iOS가 보내는 순서가 실제로 통과함을 보인다.
 *  2. 그 참조 구현이 기대는 **결정표를 Kotlin 원본에 못 박는다** (§source pins).
 *     상태어를 바꾸거나, 엔디언을 뒤집거나, SELECT AID에 FCI를 붙이거나, 경계 검사를
 *     지우면 여기서 깨진다. 참조 구현만 있으면 Kotlin이 바뀌어도 통과해 버린다.
 *
 * CC 15바이트와 NLEN 배치는 Task 2의 것이고 `src/type4.test.ts`가 이미 Kotlin 원본에
 * 묶어 두었다 — 같은 suite에서 함께 돌므로 여기서 다시 묶지 않는다.
 *
 * 쓰기 경로(UPDATE BINARY)도 같은 방식으로 본다. 리더는 NLEN 을 **마지막에** 쓰므로
 * (`0000` 으로 비우기 → 본문 조각들 → 실제 길이), "완성된 메시지 하나마다 write 이벤트
 * 하나"라는 불변식은 순서가 있는 벡터로만 보인다 — 그래서 참조 구현도 콜백을 흉내 낸다.
 *
 * **은퇴 조건**: Android SDK가 있는 기계에서 `ApduStateMachineTest`·`ApduWriteTest`가 green이
 * 되는 순간 §source pins를 지운다. 그때부터 동작은 JUnit이 지고 §reference는 벡터 문서로
 * 남는다. 핀은 Kotlin이 한 번도 컴파일되지 않는 동안에만 값을 한다 — 동작을 보존하는
 * 리팩터까지 깨뜨리는 비용을 영구히 지고 갈 이유는 없다.
 */

// ── Kotlin 원본에서 값 뽑아내기 (이 파일이 필요한 만큼만) ────────────────────

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/** `const val NAME = 0x9000` 또는 `const val NAME = OTHER - 2`. */
function intConst(source: string, name: string, scope: Record<string, number> = {}): number {
  const match = new RegExp(`const val ${name}\\s*=\\s*([^\\n]+)`).exec(stripComments(source));
  const text = match?.[1]?.trim();
  if (text === undefined) throw new Error(`const val ${name} 을 찾지 못했다`);
  const literal = /^(0x[0-9a-fA-F]+|\d+)$/.exec(text);
  if (literal?.[1] !== undefined) return Number(literal[1]);
  const derived = /^([A-Za-z_][A-Za-z0-9_]*)\s*-\s*(\d+)$/.exec(text);
  const base = derived?.[1] === undefined ? undefined : scope[derived[1]];
  if (base === undefined || derived?.[2] === undefined) {
    throw new Error(`const val ${name} 의 값을 읽지 못했다: ${text}`);
  }
  return base - Number(derived[2]);
}

/** `anchor` 뒤 첫 `byteArrayOf(...)` 의 바이트 리터럴. `0xE1.toByte()` 형태만 다룬다. */
function byteLiteral(source: string, anchor: string): Uint8Array {
  // .toByte() 를 먼저 걷어내야 닫는 괄호를 헷갈리지 않는다.
  const clean = stripComments(source).replace(/\.toByte\(\)/g, '');
  const anchorAt = clean.indexOf(anchor);
  if (anchorAt < 0) throw new Error(`${anchor} 을 찾지 못했다`);
  const open = clean.indexOf('byteArrayOf(', anchorAt);
  const close = clean.indexOf(')', open + 'byteArrayOf('.length);
  if (open < 0 || close < 0) throw new Error(`${anchor} 뒤에 byteArrayOf(...) 가 없다`);
  const items = clean
    .slice(open + 'byteArrayOf('.length, close)
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
  return Uint8Array.from(
    items.map((item) => {
      if (!/^(0x[0-9a-fA-F]+|\d+)$/.test(item)) throw new Error(`바이트 리터럴이 아니다: ${item}`);
      return Number(item) & 0xff;
    }),
  );
}

const machineSource = stripComments(apduStateMachineKt);
const statusSource = stripComments(apduStatusKt);

const NDEF_FILE_SIZE = intConst(type4FilesKt, 'NDEF_FILE_SIZE');
const MAX_NDEF_SIZE = intConst(type4FilesKt, 'MAX_NDEF_SIZE', { NDEF_FILE_SIZE });

const SW = {
  OK: intConst(apduStatusKt, 'SW_OK'),
  FILE_NOT_FOUND: intConst(apduStatusKt, 'SW_FILE_NOT_FOUND'),
  SECURITY: intConst(apduStatusKt, 'SW_SECURITY'),
  WRONG_P1P2: intConst(apduStatusKt, 'SW_WRONG_P1P2'),
  WRONG_LENGTH: intConst(apduStatusKt, 'SW_WRONG_LENGTH'),
  INS_NOT_SUPPORTED: intConst(apduStatusKt, 'SW_INS_NOT_SUPPORTED'),
  CLASS_NOT_SUPPORTED: intConst(apduStatusKt, 'SW_CLASS_NOT_SUPPORTED'),
} as const;

const AID = byteLiteral(apduStateMachineKt, 'private val aid');
const CC_FILE_ID = byteLiteral(type4FilesKt, 'val CC_FILE_ID');
const NDEF_FILE_ID = byteLiteral(type4FilesKt, 'val NDEF_FILE_ID');

/** Task 2의 CC. `src/type4.test.ts`가 이 15바이트를 Kotlin 원본에 묶어 두었다. */
const CC_HEX = '000F2000FF00FF0406E10408000000';

/** 리더가 한 번에 읽어 갈 수 있는 크기(CC 인덱스 3~4)와 써 넣을 수 있는 크기(5~6). */
const MLE = intConst(type4FilesKt, 'MLE');
const MLC = Number.parseInt(CC_HEX.slice(10, 14), 16);

// ── 바이트 다루개 ───────────────────────────────────────────────────────────

const at = (bytes: Uint8Array, index: number): number => bytes[index] ?? 0;

const toHex = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join('');

const fromHex = (text: string): Uint8Array =>
  Uint8Array.from((text.match(/../g) ?? []).map((pair) => Number.parseInt(pair, 16)));

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, index) => byte === b[index]);

// ── §reference: Kotlin 과 같은 모양의 참조 구현 ──────────────────────────────

const EMPTY = new Uint8Array(0);

/** ApduStatus.respond — `data || SW1 || SW2`, 언제나 새 배열. */
function respond(data: Uint8Array, sw: number): Uint8Array {
  const out = new Uint8Array(data.length + 2);
  out.set(data, 0);
  out[data.length] = (sw >> 8) & 0xff;
  out[data.length + 1] = sw & 0xff;
  return out;
}

/** Type4Files.ndefFileBytes — NLEN(빅엔디언 2바이트) + 메시지. */
function ndefFileBytes(message: Uint8Array): Uint8Array {
  if (message.length > MAX_NDEF_SIZE) throw new RangeError(`NDEF message is ${message.length} bytes`);
  const file = new Uint8Array(message.length + 2);
  file[0] = (message.length >> 8) & 0xff;
  file[1] = message.length & 0xff;
  file.set(message, 2);
  return file;
}

type Selected = 'NONE' | 'CC' | 'NDEF';

class ReferenceStateMachine {
  private appSelected = false;
  private selected: Selected = 'NONE';
  private pendingPayload = new Uint8Array(0);
  activePayload = new Uint8Array(0);

  /**
   * Kotlin 생성자가 받는 `onMessage: (ByteArray) -> Unit` 자리. 완성된 메시지 하나마다
   * 하나씩 들어온다 — 이 배열의 길이가 곧 "write 이벤트 몇 번"이다.
   */
  readonly messages: Uint8Array[] = [];

  /** 그 콜백이 하는 일. 서비스가 이벤트를 받자마자 무언가 하는 경우를 테스트가 끼워 넣는다. */
  onMessage: (message: Uint8Array) => void = () => {};

  /** 리더가 써 넣는 중인 메시지. 파일 오프셋 0·1은 NLEN 이므로 인덱스는 `offset - 2`다. */
  private readonly writeBuffer = new Uint8Array(MAX_NDEF_SIZE);
  private readonly writtenBytes: boolean[] = new Array<boolean>(MAX_NDEF_SIZE).fill(false);
  private completePrefix = 0;
  private declaredLength = 0;

  setPendingPayload(ndef: Uint8Array): void {
    if (ndef.length > MAX_NDEF_SIZE) throw new RangeError(`NDEF message is ${ndef.length} bytes`);
    this.pendingPayload = ndef.slice();
    if (!this.appSelected) this.promotePendingPayload();
  }

  onDeactivated(): void {
    this.appSelected = false;
    this.selected = 'NONE';
    this.resetWriteState();
    this.promotePendingPayload();
  }

  private promotePendingPayload(): void {
    this.activePayload = this.pendingPayload.slice();
  }

  process(apdu: Uint8Array): Uint8Array {
    if (apdu.length < 4) return respond(EMPTY, SW.WRONG_LENGTH);
    if (at(apdu, 0) !== 0x00) return respond(EMPTY, SW.CLASS_NOT_SUPPORTED);
    const ins = at(apdu, 1);
    if (ins === 0xa4) return this.handleSelect(apdu);
    if (ins === 0xb0) return this.handleReadBinary(apdu);
    if (ins === 0xd6) return this.handleUpdateBinary(apdu);
    return respond(EMPTY, SW.INS_NOT_SUPPORTED);
  }

  private handleSelect(apdu: Uint8Array): Uint8Array {
    const p1 = at(apdu, 2);
    const p2 = at(apdu, 3);
    const lc = apdu.length > 4 ? at(apdu, 4) : 0;
    if (apdu.length < 5 + lc) return respond(EMPTY, SW.WRONG_LENGTH);
    const data = apdu.slice(5, 5 + lc);

    if (p1 === 0x04 && p2 === 0x00) {
      if (!sameBytes(data, AID)) return respond(EMPTY, SW.FILE_NOT_FOUND);
      this.promotePendingPayload();
      this.resetWriteState();
      this.appSelected = true;
      this.selected = 'NONE';
      return respond(EMPTY, SW.OK); // FCI 없음
    }

    if (p1 === 0x00 && p2 === 0x0c) {
      if (!this.appSelected) return respond(EMPTY, SW.SECURITY);
      if (lc !== 2) return respond(EMPTY, SW.WRONG_LENGTH);
      if (sameBytes(data, CC_FILE_ID)) {
        this.selected = 'CC';
        return respond(EMPTY, SW.OK);
      }
      if (sameBytes(data, NDEF_FILE_ID)) {
        this.selected = 'NDEF';
        return respond(EMPTY, SW.OK);
      }
      return respond(EMPTY, SW.FILE_NOT_FOUND);
    }

    return respond(EMPTY, SW.WRONG_P1P2);
  }

  private currentFile(): Uint8Array | null {
    if (this.selected === 'CC') return fromHex(CC_HEX);
    if (this.selected === 'NDEF') return ndefFileBytes(this.activePayload);
    return null;
  }

  private handleReadBinary(apdu: Uint8Array): Uint8Array {
    if (!this.appSelected) return respond(EMPTY, SW.SECURITY);
    const file = this.currentFile();
    if (file === null) return respond(EMPTY, SW.SECURITY);
    const offset = (at(apdu, 2) << 8) | at(apdu, 3);
    if (offset > file.length) return respond(EMPTY, SW.WRONG_P1P2);
    let le = apdu.length > 4 ? at(apdu, 4) : 0;
    if (le === 0) le = MLE; // ISO 는 256이라 하지만 CC 가 선언한 MLe 는 255다
    const length = Math.min(le, file.length - offset);
    return respond(file.slice(offset, offset + length), SW.OK);
  }

  private handleUpdateBinary(apdu: Uint8Array): Uint8Array {
    if (!this.appSelected) return respond(EMPTY, SW.SECURITY);
    if (this.selected !== 'NDEF') return respond(EMPTY, SW.SECURITY);
    const lc = apdu.length > 4 ? at(apdu, 4) : 0;
    if (apdu.length < 5 + lc) return respond(EMPTY, SW.WRONG_LENGTH);
    const offset = (at(apdu, 2) << 8) | at(apdu, 3);
    const data = apdu.slice(5, 5 + lc);

    if (offset === 0) {
      if (lc < 2) return respond(EMPTY, SW.WRONG_LENGTH);
      const declared = (at(data, 0) << 8) | at(data, 1);
      if (declared > MAX_NDEF_SIZE) return respond(EMPTY, SW.WRONG_P1P2);
      if (declared === 0) {
        this.resetWriteState();
        return respond(EMPTY, SW.OK);
      }
      this.declaredLength = declared;
      if (lc > 2) {
        this.writeBuffer.set(data.slice(2, lc), 0);
        this.markWritten(0, lc - 2);
      }
      this.emitIfComplete();
      return respond(EMPTY, SW.OK);
    }

    const bodyOffset = offset - 2;
    if (bodyOffset < 0 || bodyOffset + lc > MAX_NDEF_SIZE) return respond(EMPTY, SW.WRONG_P1P2);
    this.writeBuffer.set(data, bodyOffset);
    this.markWritten(bodyOffset, lc);
    this.emitIfComplete();
    return respond(EMPTY, SW.OK);
  }

  private markWritten(from: number, length: number): void {
    for (let i = from; i < from + length; i += 1) this.writtenBytes[i] = true;
    while (this.completePrefix < this.writtenBytes.length && this.writtenBytes[this.completePrefix]) {
      this.completePrefix += 1;
    }
  }

  private emitIfComplete(): void {
    if (this.declaredLength === 0 || this.completePrefix < this.declaredLength) return;
    const message = this.writeBuffer.slice(0, this.declaredLength);
    // 상태를 먼저 지운다. 콜백 안에서 곧장 다음 APDU 가 들어와도 지워진 상태 위에서 시작한다.
    this.resetWriteState();
    this.messages.push(message);
    this.onMessage(message); // Kotlin 은 이 자리에서 생성자 콜백을 부른다
  }

  private resetWriteState(): void {
    this.declaredLength = 0;
    this.completePrefix = 0;
    this.writtenBytes.fill(false);
  }
}

// ── 벡터 ────────────────────────────────────────────────────────────────────

/** monti.app:g 외부 타입 레코드, 페이로드 4바이트. 파일은 NLEN 포함 20바이트. */
const SHORT_RECORD = fromHex('D40B046D6F6E74692E6170703A6701020304');

/** 길이가 다른 두 번째 레코드. 페이로드 교체가 보이는지 보려고 쓴다. */
const OTHER_RECORD = fromHex('D40302666F6FAABB');

/** 0,1,2,… 로 채운 페이로드. 위치가 그대로 보여 창이 어긋나면 눈에 띈다. */
const counting = (size: number): Uint8Array => Uint8Array.from({ length: size }, (_, i) => i & 0xff);

/**
 * NDEF 외부 타입 레코드 하나. 페이로드가 255를 넘으면 SR 비트가 꺼져 헤더가 long form
 * (`0xC4` + 4바이트 payload length)이 되고, 그 아래면 short record(`0xD4`)다.
 */
function externalRecord(type: string, payload: Uint8Array): Uint8Array {
  const typeBytes = Uint8Array.from([...type].map((c) => c.charCodeAt(0)));
  const short = payload.length <= 255;
  const headerSize = short ? 3 : 6;
  const record = new Uint8Array(headerSize + typeBytes.length + payload.length);
  record[0] = short ? 0xd4 : 0xc4; // MB|ME|(SR)|TNF=4(external)
  record[1] = typeBytes.length;
  if (short) {
    record[2] = payload.length;
  } else {
    record[2] = (payload.length >> 24) & 0xff;
    record[3] = (payload.length >> 16) & 0xff;
    record[4] = (payload.length >> 8) & 0xff;
    record[5] = payload.length & 0xff;
  }
  record.set(typeBytes, headerSize);
  record.set(payload, headerSize + typeBytes.length);
  return record;
}

/**
 * 진짜 게이트 코드의 모양: ~389바이트 CBOR이 실리면 헤더가 long form이 되어 레코드가
 * 406바이트가 된다. MLe(255)를 넘으므로 리더가 나눠 읽는다.
 */
const gateRecord = (payloadSize = 389): Uint8Array =>
  externalRecord(NDEF_GATE_TYPE, counting(payloadSize));

/** 관객 폰이 써 넣는 진짜 응답. `GateResponseWire` CBOR 은 162바이트다. */
const RESPONSE_WIRE: GateResponseWire = {
  v: 1,
  tokenId: '1234567',
  deviceSig: `0x${'ab'.repeat(64)}`,
};
const RESPONSE_CBOR = encodeGateResponse(RESPONSE_WIRE);
const RESPONSE_RECORD = externalRecord(NDEF_RESPONSE_TYPE, RESPONSE_CBOR);

/** 한 조각에 안 들어가는 응답. 두 번째 창이 파일 오프셋 257(P1P2 `0101`)로 간다. */
const LONG_RESPONSE_RECORD = externalRecord(NDEF_RESPONSE_TYPE, counting(400));

function machine(payload: Uint8Array = SHORT_RECORD): ReferenceStateMachine {
  const m = new ReferenceStateMachine();
  m.setPendingPayload(payload);
  return m;
}

/** C-APDU hex 하나를 보내고 R-APDU hex 하나를 받는다. */
const exchange = (m: ReferenceStateMachine, request: string): string => toHex(m.process(fromHex(request)));

const SELECT_AID = '00A4040007D2760000850101';
const SELECT_AID_WITH_LE = '00A4040007D276000085010100';
const SELECT_CC = '00A4000C02E103';
const SELECT_NDEF = '00A4000C02E104';

/** `00 D6 <offset 빅엔디언> <Lc> <data>`. */
const updateBinary = (offset: number, data: Uint8Array): string =>
  `00D6${toHex(Uint8Array.from([(offset >> 8) & 0xff, offset & 0xff, data.length]))}${toHex(data)}`;

const nlen = (length: number): Uint8Array =>
  Uint8Array.from([(length >> 8) & 0xff, length & 0xff]);

function run(m: ReferenceStateMachine, script: ReadonlyArray<readonly [string, string]>): void {
  for (const [request, expected] of script) {
    expect(`${request} → ${exchange(m, request)}`).toBe(`${request} → ${expected}`);
  }
}

/** SELECT AID → SELECT E104. 쓰기는 NDEF 파일을 고른 뒤에만 된다. */
function openNdefFile(m: ReferenceStateMachine): void {
  run(m, [
    [SELECT_AID, '9000'],
    [SELECT_NDEF, '9000'],
  ]);
}

/**
 * 리더의 세 단계를 그대로 보낸다: NLEN 0 → 본문 조각들 → 실제 NLEN.
 * 마지막 NLEN 전에는 이벤트가 하나도 늘지 않는지 조각마다 확인한다.
 */
function writeMessage(m: ReferenceStateMachine, message: Uint8Array, chunk = MLC): void {
  const before = m.messages.length;
  run(m, [[updateBinary(0, nlen(0)), '9000']]);
  for (let sent = 0; sent < message.length; sent += chunk) {
    run(m, [[updateBinary(2 + sent, message.slice(sent, sent + chunk)), '9000']]);
    expect(m.messages).toHaveLength(before);
  }
  run(m, [[updateBinary(0, nlen(message.length)), '9000']]);
}

/** 이벤트가 정확히 하나이고, 그 바이트가 기대한 메시지 그대로인지 본다. */
function expectOneMessage(m: ReferenceStateMachine, expected: Uint8Array): void {
  expect(m.messages.map(toHex)).toEqual([toHex(expected)]);
}

describe('the sequence an iPhone (Core NFC) sends', () => {
  it('answers SELECT AID with a bare 9000 and no FCI', () => {
    // FCI를 붙이면 아이폰이 세션을 끊는다. 두 바이트뿐이어야 한다.
    expect(exchange(machine(), SELECT_AID)).toBe('9000');
    // 아이폰은 Le 바이트(00)를 붙여 보내기도 한다. 둘 다 받아야 한다.
    expect(exchange(machine(), SELECT_AID_WITH_LE)).toBe('9000');
  });

  it('walks SELECT AID → SELECT CC → READ BINARY → SELECT NDEF → READ BINARY', () => {
    run(machine(), [
      [SELECT_AID_WITH_LE, '9000'],
      [SELECT_CC, '9000'],
      ['00B000000F', `${CC_HEX}9000`], // CC 15바이트
      [SELECT_NDEF, '9000'],
      ['00B0000002', '00129000'], // NLEN 먼저
      ['00B0000212', `${toHex(SHORT_RECORD)}9000`], // NLEN 다음(오프셋 2)부터가 메시지
    ]);
  });

  it('truncates a read to what the file actually holds', () => {
    const m = machine();
    run(m, [
      [SELECT_AID, '9000'],
      [SELECT_NDEF, '9000'],
      // 파일은 20바이트뿐인데 255를 달라고 한다.
      ['00B00000FF', `0012${toHex(SHORT_RECORD)}9000`],
    ]);
  });

  it('gives at most the MLe the CC declares when Le says 0', () => {
    // ISO 7816-4 단축 APDU에서 Le = 0 은 256이지만, CC 가 선언한 MLe 는 255다.
    const record = gateRecord();
    const m = machine(record);
    run(m, [
      [SELECT_AID, '9000'],
      [SELECT_NDEF, '9000'],
      ['00B0000200', `${toHex(record.slice(0, MLE))}9000`],
    ]);
    expect(MLE).toBe(255);
    expect(Number.parseInt(CC_HEX.slice(6, 10), 16)).toBe(MLE); // CC 인덱스 3~4
  });

  it('reads the capability container back byte for byte', () => {
    const m = machine();
    run(m, [
      [SELECT_AID, '9000'],
      [SELECT_CC, '9000'],
      ['00B0000002', `${CC_HEX.slice(0, 4)}9000`], // 앞 두 바이트 = CCLEN 000F
      ['00B000000F', `${CC_HEX}9000`],
      ['00B0000F01', '9000'], // 오프셋 == 파일 크기: 빈 응답
      ['00B0004001', '6A86'], // 그보다 크면 파일 밖이다
    ]);
  });
});

describe('a long-form (0xC4) gate record', () => {
  const record = gateRecord();

  it('is the 406-byte shape a ~389-byte gate code actually makes', () => {
    expect(record.length).toBe(406);
    expect(record[0]).toBe(0xc4); // short record 가 아니다
    expect(toHex(record.slice(2, 6))).toBe('00000185'); // payload length 4바이트
    expect(record.length + 2).toBeLessThanOrEqual(NDEF_FILE_SIZE);
  });

  it('is read back in MLe-sized windows that cross the 255-byte boundary', () => {
    const m = machine(record);
    run(m, [
      [SELECT_AID, '9000'],
      [SELECT_NDEF, '9000'],
      ['00B0000002', '01969000'], // NLEN = 406
      // 첫 창: 오프셋 2 부터 255바이트 = 레코드 0..254
      ['00B00002FF', `${toHex(record.slice(0, 255))}9000`],
      // 두 번째 창: 오프셋 257(0x0101) 부터 남은 151바이트 = 레코드 255..405
      ['00B00101FF', `${toHex(record.slice(255))}9000`],
      // 경계를 가운데 두고 읽는 창: 파일 오프셋 254 = 레코드 252, 10바이트
      ['00B000FE0A', `${toHex(record.slice(252, 262))}9000`],
    ]);
  });

  it('reassembles to exactly the record a reader looping over offsets sees', () => {
    const m = machine(record);
    exchange(m, SELECT_AID);
    exchange(m, SELECT_NDEF);
    const declared = Number.parseInt(exchange(m, '00B0000002').slice(0, 4), 16);
    expect(declared).toBe(record.length);

    const assembled: number[] = [];
    let offset = 2;
    while (assembled.length < declared) {
      const high = (offset >> 8) & 0xff;
      const low = offset & 0xff;
      const response = fromHex(
        exchange(m, `00B0${toHex(Uint8Array.from([high, low]))}FF`),
      );
      const data = response.slice(0, response.length - 2);
      expect(data.length).toBeGreaterThan(0);
      expect(data.length).toBeLessThanOrEqual(255); // MLe 를 넘겨 주면 안 된다
      expect(toHex(response.slice(response.length - 2))).toBe('9000');
      assembled.push(...data);
      offset += data.length;
    }
    expect(toHex(Uint8Array.from(assembled))).toBe(toHex(record));
    expect(offset).toBe(2 + declared);
  });
});

describe('the write an attendee phone performs (UPDATE BINARY)', () => {
  it('carries the real GateResponseWire: 162 bytes of CBOR in a 176-byte record', () => {
    expect(RESPONSE_CBOR.length).toBe(162);
    expect(RESPONSE_RECORD.length).toBe(176);
    expect(RESPONSE_RECORD[0]).toBe(0xd4); // 255 이하 페이로드 → SR=1 short record
    expect(RESPONSE_RECORD.length).toBeLessThanOrEqual(MLC); // 한 조각에 들어간다
    expect(toHex(RESPONSE_RECORD.slice(3, 3 + NDEF_RESPONSE_TYPE.length))).toBe(
      toHex(Uint8Array.from([...NDEF_RESPONSE_TYPE].map((c) => c.charCodeAt(0)))),
    );
  });

  it('fires one write event, and only when the final NLEN lands', () => {
    const m = machine();
    openNdefFile(m);
    // 1) 파일을 비운다
    run(m, [[updateBinary(0, nlen(0)), '9000']]);
    expect(m.messages).toHaveLength(0);
    // 2) 본문
    run(m, [[updateBinary(2, RESPONSE_RECORD), '9000']]);
    expect(m.messages).toHaveLength(0); // 본문만으로는 완성이 아니다 — NLEN 이 아직 0 이다
    // 3) 실제 길이
    run(m, [[updateBinary(0, nlen(RESPONSE_RECORD.length)), '9000']]);
    expectOneMessage(m, RESPONSE_RECORD);
  });

  it('reassembles a body split into small windows', () => {
    const m = machine();
    openNdefFile(m);
    writeMessage(m, RESPONSE_RECORD, 64); // 창이 작은 리더
    expectOneMessage(m, RESPONSE_RECORD);
  });

  it('takes a long-form record whose second window starts at offset 0101', () => {
    expect(LONG_RESPONSE_RECORD.length).toBe(417);
    expect(LONG_RESPONSE_RECORD[0]).toBe(0xc4);
    const m = machine();
    openNdefFile(m);
    run(m, [
      [updateBinary(0, nlen(0)), '9000'],
      [`00D60002FF${toHex(LONG_RESPONSE_RECORD.slice(0, 255))}`, '9000'],
      // 오프셋 257 = P1P2 0101. 리틀엔디언으로 읽으면 여기서 어긋난다.
      [`00D60101A2${toHex(LONG_RESPONSE_RECORD.slice(255))}`, '9000'],
      [updateBinary(0, nlen(LONG_RESPONSE_RECORD.length)), '9000'],
    ]);
    expectOneMessage(m, LONG_RESPONSE_RECORD);
  });

  it('puts an out-of-order chunk where its offset says, not where it arrived', () => {
    const m = machine();
    openNdefFile(m);
    run(m, [
      [updateBinary(0, nlen(0)), '9000'],
      // 꼬리를 먼저 보낸다.
      [updateBinary(2 + 100, RESPONSE_RECORD.slice(100)), '9000'],
      [updateBinary(2, RESPONSE_RECORD.slice(0, 100)), '9000'],
    ]);
    expect(m.messages).toHaveLength(0);
    run(m, [[updateBinary(0, nlen(RESPONSE_RECORD.length)), '9000']]);
    expectOneMessage(m, RESPONSE_RECORD);
  });

  it('takes the single-shot write an Android reader sends', () => {
    const m = machine();
    openNdefFile(m);
    // NLEN 과 본문이 한 APDU 안에 있다.
    const combined = new Uint8Array(2 + RESPONSE_RECORD.length);
    combined.set(nlen(RESPONSE_RECORD.length), 0);
    combined.set(RESPONSE_RECORD, 2);
    run(m, [[updateBinary(0, combined), '9000']]);
    expectOneMessage(m, RESPONSE_RECORD);
  });

  it('fires twice for two writes in one session, once each', () => {
    const m = machine();
    openNdefFile(m);
    writeMessage(m, SHORT_RECORD);
    writeMessage(m, RESPONSE_RECORD);
    expect(m.messages.map(toHex)).toEqual([toHex(SHORT_RECORD), toHex(RESPONSE_RECORD)]);
  });

  it('fires once even when the callback pushes the reader\'s retry straight back in', () => {
    const m = machine();
    openNdefFile(m);
    const finalNlen = updateBinary(0, nlen(RESPONSE_RECORD.length));
    let reentered = 0;
    m.onMessage = () => {
      if (reentered > 0) return;
      reentered += 1;
      // 서비스가 이벤트를 받자마자 리더의 재시도 APDU 를 그대로 다시 밀어 넣었다.
      expect(exchange(m, finalNlen)).toBe('9000');
    };
    run(m, [
      [updateBinary(0, nlen(0)), '9000'],
      [updateBinary(2, RESPONSE_RECORD), '9000'],
      [finalNlen, '9000'],
    ]);
    expect(reentered).toBe(1);
    expectOneMessage(m, RESPONSE_RECORD);
  });

  it('fires once even when the reader repeats the final NLEN', () => {
    const m = machine();
    openNdefFile(m);
    writeMessage(m, RESPONSE_RECORD);
    // 리더가 마지막 APDU 의 응답을 놓쳐 다시 보냈다.
    run(m, [[updateBinary(0, nlen(RESPONSE_RECORD.length)), '9000']]);
    expectOneMessage(m, RESPONSE_RECORD);
  });
});

describe('a write that never finishes', () => {
  it('never fires, and leaves nothing behind for the next tap', () => {
    const m = machine();
    openNdefFile(m);
    run(m, [
      [updateBinary(0, nlen(0)), '9000'],
      [updateBinary(2, RESPONSE_RECORD.slice(0, 100)), '9000'],
    ]);
    m.onDeactivated(); // 리더가 사라졌다
    expect(m.messages).toHaveLength(0);

    // 다음 탭이 다른 메시지를 다 써 넣으면 나오는 건 그 메시지 하나뿐이어야 한다.
    openNdefFile(m);
    writeMessage(m, SHORT_RECORD);
    expectOneMessage(m, SHORT_RECORD);
  });

  it('is dropped when a new session opens without a deactivation', () => {
    const m = machine();
    openNdefFile(m);
    run(m, [
      [updateBinary(0, nlen(0)), '9000'],
      [updateBinary(2, RESPONSE_RECORD.slice(0, 100)), '9000'],
    ]);
    // 링크가 끊겨 onDeactivated 가 오지 못했다. 다음 SELECT AID 가 세션을 새로 연다.
    openNdefFile(m);
    run(m, [[updateBinary(0, nlen(100)), '9000']]);
    expect(m.messages).toHaveLength(0); // 지난 탭의 바이트로 메시지를 만들어 내면 안 된다
  });

  it('does not mistake a gap in the middle for a finished message', () => {
    const m = machine();
    openNdefFile(m);
    run(m, [
      [updateBinary(0, nlen(0)), '9000'],
      // 꼬리만 도착했다. 앞 100바이트는 비어 있다.
      [updateBinary(2 + 100, RESPONSE_RECORD.slice(100)), '9000'],
      // "지금까지 본 가장 먼 오프셋"으로 세면 176이라 완성으로 보인다. 실제로는 구멍이 있다.
      [updateBinary(0, nlen(RESPONSE_RECORD.length)), '9000'],
    ]);
    expect(m.messages).toHaveLength(0);
    // 구멍이 메워지는 순간 한 번 나간다.
    run(m, [[updateBinary(2, RESPONSE_RECORD.slice(0, 100)), '9000']]);
    expectOneMessage(m, RESPONSE_RECORD);
  });

  it('waits when the NLEN declares more than was written, and fires when the rest lands', () => {
    const m = machine();
    openNdefFile(m);
    run(m, [
      [updateBinary(0, nlen(0)), '9000'],
      [updateBinary(2, RESPONSE_RECORD.slice(0, 100)), '9000'],
      // 100바이트만 쓰고 176을 선언했다.
      [updateBinary(0, nlen(RESPONSE_RECORD.length)), '9000'],
    ]);
    expect(m.messages).toHaveLength(0);
    // 남은 76바이트가 도착하면 그때 한 번 나간다(NLEN 을 먼저 쓰는 리더도 이 길로 통과한다).
    run(m, [[updateBinary(2 + 100, RESPONSE_RECORD.slice(100)), '9000']]);
    expectOneMessage(m, RESPONSE_RECORD);
  });
});

describe('what the state machine refuses', () => {
  it('refuses to read before the application is selected', () => {
    expect(exchange(machine(), '00B000000F')).toBe('6982');
  });

  it('refuses to read when no file is selected', () => {
    const m = machine();
    run(m, [
      [SELECT_AID, '9000'],
      ['00B000000F', '6982'],
    ]);
  });

  it('refuses a write before the NDEF file is selected', () => {
    const m = machine();
    run(m, [
      [updateBinary(0, nlen(0)), '6982'], // 앱조차 고르지 않았다
      [SELECT_AID, '9000'],
      [updateBinary(0, nlen(0)), '6982'], // 파일을 고르지 않았다
      [SELECT_CC, '9000'],
      [updateBinary(0, nlen(0)), '6982'], // CC 파일에는 쓸 수 없다
    ]);
    expect(m.messages).toHaveLength(0);
  });

  it('refuses a write that would run past the declared file', () => {
    const m = machine();
    openNdefFile(m);
    run(m, [
      [updateBinary(2100, fromHex('01')), '6A86'],
      // 경계: 파일의 마지막 바이트(오프셋 2 + 2045)는 들어가고 그 다음은 파일 밖이다.
      [updateBinary(2 + MAX_NDEF_SIZE - 1, fromHex('01')), '9000'],
      [updateBinary(2 + MAX_NDEF_SIZE, fromHex('01')), '6A86'],
      // 오프셋 1은 NLEN 의 뒷바이트다 — 본문도 NLEN 도 아닌 자리다.
      [updateBinary(1, fromHex('01')), '6A86'],
    ]);
  });

  it('refuses an NLEN larger than the file can hold', () => {
    const m = machine();
    openNdefFile(m);
    run(m, [
      ['00D6000002' + '0FFF', '6A86'],
      // 한도까지는 받는다. 본문이 아직 없으니 이벤트는 나가지 않는다.
      [updateBinary(0, nlen(MAX_NDEF_SIZE)), '9000'],
    ]);
    expect(m.messages).toHaveLength(0);
  });

  it('refuses an UPDATE BINARY that claims more than it carries', () => {
    const m = machine();
    openNdefFile(m);
    run(m, [
      ['00D60000', '6700'], // Lc 가 없다
      ['00D6000002' + '00', '6700'], // Lc = 2 인데 한 바이트만 실었다
      [updateBinary(0, fromHex('00')), '6700'], // NLEN 은 두 바이트다
    ]);
  });

  it('answers 6A82 for a file id it does not serve', () => {
    const m = machine();
    run(m, [
      [SELECT_AID, '9000'],
      ['00A4000C02E105', '6A82'],
    ]);
  });

  it('answers 6A82 for some other application, and stays closed', () => {
    const m = machine();
    run(m, [
      ['00A4040007D276000085010200', '6A82'], // AID 마지막 바이트가 다르다
      ['00B000000F', '6982'],
    ]);
  });

  it('answers 6A86 for a SELECT with P1P2 it does not implement', () => {
    const m = machine();
    run(m, [
      [SELECT_AID, '9000'],
      ['00A4020002E104', '6A86'],
    ]);
  });

  it('answers 6D00 for an unknown instruction and keeps the session alive', () => {
    const m = machine();
    run(m, [
      [SELECT_AID, '9000'],
      ['00CA000000', '6D00'],
      [SELECT_CC, '9000'],
    ]);
  });

  it('answers 6E00 for a class other than 0x00', () => {
    const m = machine();
    run(m, [
      [SELECT_AID, '9000'],
      ['80B0000002', '6E00'],
      [SELECT_CC, '9000'],
    ]);
  });

  it('answers 6700 for an APDU that claims more than it carries', () => {
    const m = machine();
    run(m, [
      ['00A404', '6700'], // 4바이트도 안 된다
      [SELECT_AID, '9000'],
      ['00A4000C02E1', '6700'], // Lc = 2 인데 한 바이트만 실었다
      ['00A4000C03E10400', '6700'], // 파일 id 는 정확히 두 바이트다
    ]);
  });
});

describe('when the payload changes', () => {
  it('keeps one tap on one message and shows the new one to the next tap', () => {
    const m = machine();
    run(m, [
      [SELECT_AID, '9000'],
      [SELECT_NDEF, '9000'],
    ]);
    m.setPendingPayload(OTHER_RECORD);
    // 진행 중인 탭은 끝까지 같은 메시지를 읽어 간다 — 길이가 도중에 줄면 리더가 깨진다.
    expect(exchange(m, '00B0000002')).toBe('00129000');
    expect(toHex(m.activePayload)).toBe(toHex(SHORT_RECORD));

    m.onDeactivated();
    expect(toHex(m.activePayload)).toBe(toHex(OTHER_RECORD));
    run(m, [
      [SELECT_AID, '9000'],
      [SELECT_NDEF, '9000'],
      ['00B0000002', '00089000'],
    ]);
  });

  it('refuses a message the declared file cannot hold', () => {
    expect(() => machine().setPendingPayload(new Uint8Array(MAX_NDEF_SIZE + 1))).toThrow(RangeError);
    const m = machine(new Uint8Array(MAX_NDEF_SIZE));
    expect(m.activePayload.length).toBe(MAX_NDEF_SIZE);
    run(m, [
      [SELECT_AID, '9000'],
      [SELECT_NDEF, '9000'],
      ['00B0000002', '07FE9000'], // NLEN = 2046, 파일은 정확히 2048
    ]);
  });
});

// ── §source pins: 위 벡터가 기대는 결정표가 Kotlin 원본에 실제로 있는가 ───────

/** `signature` 로 시작하는 함수의 본문(중괄호 균형)을 잘라낸다. */
function kotlinFunctionBody(source: string, signature: string): string {
  const signatureAt = source.indexOf(signature);
  if (signatureAt < 0) throw new Error(`${signature} 을 찾지 못했다`);
  let cursor = source.indexOf('{', signatureAt);
  if (cursor < 0) throw new Error(`${signature} 에 본문이 없다`);
  const start = cursor;
  let depth = 0;
  do {
    const char = source[cursor];
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    cursor += 1;
  } while (depth > 0 && cursor < source.length);
  if (depth !== 0) throw new Error(`${signature} 의 중괄호가 닫히지 않았다`);
  return source.slice(start, cursor);
}

/** 줄바꿈·들여쓰기를 지워 한 줄로 만든다. 줄을 접어도 핀이 깨지지 않게. */
const squeeze = (text: string): string => text.replace(/\s+/g, ' ').trim();

/**
 * 분기마다 **그 함수 안에서** 찾는다. 같은 줄이 두 함수에 나오기 때문이다
 * (`if (!appSelected) return ... SW_SECURITY` 는 handleSelect·handleReadBinary·
 * handleUpdateBinary 세 곳에 있다). 원본 전체에서 찾으면 한쪽을 망가뜨려도 다른 쪽이
 * 핀을 만족시켜 버린다.
 */
const scope = {
  process: kotlinFunctionBody(machineSource, 'fun process(apdu: ByteArray)'),
  setPendingPayload: kotlinFunctionBody(machineSource, 'fun setPendingPayload'),
  onDeactivated: kotlinFunctionBody(machineSource, 'fun onDeactivated'),
  handleSelect: kotlinFunctionBody(machineSource, 'private fun handleSelect'),
  currentFile: kotlinFunctionBody(machineSource, 'private fun currentFile'),
  handleReadBinary: kotlinFunctionBody(machineSource, 'private fun handleReadBinary'),
  handleUpdateBinary: kotlinFunctionBody(machineSource, 'private fun handleUpdateBinary'),
  markWritten: kotlinFunctionBody(machineSource, 'private fun markWritten'),
  emitIfComplete: kotlinFunctionBody(machineSource, 'private fun emitIfComplete'),
  resetWriteState: kotlinFunctionBody(machineSource, 'private fun resetWriteState'),
  respond: kotlinFunctionBody(statusSource, 'fun respond'),
} as const;

const pins: ReadonlyArray<readonly [keyof typeof scope, string, string]> = [
  ['respond', 'the status word goes on big-endian', 'out[data.size] = ((sw shr 8) and 0xFF).toByte()'],
  ['respond', 'and its low byte last', 'out[data.size + 1] = (sw and 0xFF).toByte()'],
  ['respond', 'into an array made for this one answer', 'val out = ByteArray(data.size + 2)'],

  ['process', 'an APDU shorter than a header is 6700', 'if (apdu.size < 4) return ApduStatus.respond(sw = ApduStatus.SW_WRONG_LENGTH)'],
  ['process', 'a class other than 0x00 is 6E00', 'if (cla != 0x00) return ApduStatus.respond(sw = ApduStatus.SW_CLASS_NOT_SUPPORTED)'],
  ['process', 'INS 0xA4 is SELECT', '0xA4 -> handleSelect(apdu)'],
  ['process', 'INS 0xB0 is READ BINARY', '0xB0 -> handleReadBinary(apdu)'],
  ['process', 'INS 0xD6 is UPDATE BINARY', '0xD6 -> handleUpdateBinary(apdu)'],
  ['process', 'any other INS is 6D00', 'else -> ApduStatus.respond(sw = ApduStatus.SW_INS_NOT_SUPPORTED)'],

  ['handleSelect', 'SELECT by name is P1P2 = 0400', 'if (p1 == 0x04 && p2 == 0x00)'],
  ['handleSelect', 'a foreign AID is 6A82', 'if (!data.contentEquals(aid)) return ApduStatus.respond(sw = ApduStatus.SW_FILE_NOT_FOUND)'],
  ['handleSelect', 'SELECT AID answers with the status word alone — no FCI', 'return ApduStatus.respond(sw = ApduStatus.SW_OK)'],
  ['handleSelect', 'SELECT AID starts a session and drops what the last tap was writing', 'promotePendingPayload() resetWriteState() appSelected = true selected = Selected.NONE'],
  ['handleSelect', 'SELECT by file id is P1P2 = 000C', 'if (p1 == 0x00 && p2 == 0x0C)'],
  ['handleSelect', 'choosing a file before the application is 6982', 'if (!appSelected) return ApduStatus.respond(sw = ApduStatus.SW_SECURITY)'],
  ['handleSelect', 'a file id is exactly two bytes', 'if (lc != 2) return ApduStatus.respond(sw = ApduStatus.SW_WRONG_LENGTH)'],
  ['handleSelect', 'E103 selects the capability container and answers 9000', 'data.contentEquals(Type4Files.CC_FILE_ID) -> { selected = Selected.CC ApduStatus.respond(sw = ApduStatus.SW_OK) }'],
  ['handleSelect', 'E104 selects the NDEF file and answers 9000', 'data.contentEquals(Type4Files.NDEF_FILE_ID) -> { selected = Selected.NDEF ApduStatus.respond(sw = ApduStatus.SW_OK) }'],
  ['handleSelect', 'any other file id is 6A82', 'else -> ApduStatus.respond(sw = ApduStatus.SW_FILE_NOT_FOUND)'],
  ['handleSelect', 'any other SELECT is 6A86', 'return ApduStatus.respond(sw = ApduStatus.SW_WRONG_P1P2)'],

  ['currentFile', 'the CC file is the 15 bytes Type4Files builds', 'Selected.CC -> Type4Files.capabilityContainer()'],
  ['currentFile', 'the NDEF file is NLEN + the active payload', 'Selected.NDEF -> Type4Files.ndefFileBytes(activePayload)'],
  ['currentFile', 'nothing is readable with no file chosen', 'Selected.NONE -> null'],

  ['handleReadBinary', 'reading before the application is 6982', 'if (!appSelected) return ApduStatus.respond(sw = ApduStatus.SW_SECURITY)'],
  ['handleReadBinary', 'reading with no file chosen is 6982', 'val file = currentFile() ?: return ApduStatus.respond(sw = ApduStatus.SW_SECURITY)'],
  ['handleReadBinary', 'the read offset is P1P2 big-endian', 'val offset = ((apdu[2].toInt() and 0xFF) shl 8) or (apdu[3].toInt() and 0xFF)'],
  ['handleReadBinary', 'reading past the end of the file is 6A86', 'if (offset > file.size) return ApduStatus.respond(sw = ApduStatus.SW_WRONG_P1P2)'],
  ['handleReadBinary', 'Le comes out of the APDU, 0 meaning the MLe the CC declares', 'var le = if (apdu.size > 4) apdu[4].toInt() and 0xFF else 0 if (le == 0) le = Type4Files.MLE'],
  ['handleReadBinary', 'a read never overruns the file', 'val length = minOf(le, file.size - offset)'],
  ['handleReadBinary', 'the window comes out of the chosen file', 'return ApduStatus.respond(file.copyOfRange(offset, offset + length), ApduStatus.SW_OK)'],

  ['handleUpdateBinary', 'writing before the application is 6982', 'if (!appSelected) return ApduStatus.respond(sw = ApduStatus.SW_SECURITY)'],
  ['handleUpdateBinary', 'writing anywhere but the NDEF file is 6982', 'if (selected != Selected.NDEF) return ApduStatus.respond(sw = ApduStatus.SW_SECURITY)'],
  ['handleUpdateBinary', 'an APDU that claims more than it carries is 6700', 'if (apdu.size < 5 + lc) return ApduStatus.respond(sw = ApduStatus.SW_WRONG_LENGTH)'],
  ['handleUpdateBinary', 'the write offset is P1P2 big-endian', 'val offset = ((apdu[2].toInt() and 0xFF) shl 8) or (apdu[3].toInt() and 0xFF)'],
  ['handleUpdateBinary', 'offset 0 is the NLEN, and an NLEN is two bytes', 'if (lc < 2) return ApduStatus.respond(sw = ApduStatus.SW_WRONG_LENGTH)'],
  ['handleUpdateBinary', 'the NLEN is big-endian too', 'val declared = ((data[0].toInt() and 0xFF) shl 8) or (data[1].toInt() and 0xFF)'],
  ['handleUpdateBinary', 'an NLEN past the declared file is 6A86', 'if (declared > Type4Files.MAX_NDEF_SIZE) return ApduStatus.respond(sw = ApduStatus.SW_WRONG_P1P2)'],
  ['handleUpdateBinary', 'NLEN 0 empties the file and throws away what was collected', 'if (declared == 0) { resetWriteState() return ApduStatus.respond(sw = ApduStatus.SW_OK) }'],
  ['handleUpdateBinary', 'a single-shot write carries the body behind the NLEN', 'if (lc > 2) { data.copyInto(writeBuffer, 0, 2, lc) markWritten(0, lc - 2) }'],
  ['handleUpdateBinary', 'the body starts two bytes into the file', 'val bodyOffset = offset - 2'],
  ['handleUpdateBinary', 'a body write outside the file is 6A86', 'if (bodyOffset < 0 || bodyOffset + lc > Type4Files.MAX_NDEF_SIZE) { return ApduStatus.respond(sw = ApduStatus.SW_WRONG_P1P2) }'],
  ['handleUpdateBinary', 'a chunk lands where its offset says', 'data.copyInto(writeBuffer, bodyOffset) markWritten(bodyOffset, lc)'],
  ['handleUpdateBinary', 'every accepted write is acknowledged 9000, complete or not', 'emitIfComplete() return ApduStatus.respond(sw = ApduStatus.SW_OK)'],

  ['markWritten', 'every byte of the window is marked', 'for (i in from until from + length) writtenBytes[i] = true'],
  ['markWritten', 'the prefix stops at the first hole', 'while (completePrefix < writtenBytes.size && writtenBytes[completePrefix]) completePrefix += 1'],

  ['emitIfComplete', 'nothing fires until the declared length is covered from the front', 'if (declaredLength == 0 || completePrefix < declaredLength) return'],
  ['emitIfComplete', 'the event carries exactly the declared bytes', 'val message = writeBuffer.copyOfRange(0, declaredLength)'],
  ['emitIfComplete', 'the state is cleared before the callback, so one message fires once', 'resetWriteState() onMessage(message)'],

  ['resetWriteState', 'forgets the declared length and every byte written', 'declaredLength = 0 completePrefix = 0 writtenBytes.fill(false)'],

  ['setPendingPayload', 'a message too big for the declared file is refused', 'require(ndef.size <= Type4Files.MAX_NDEF_SIZE)'],
  ['setPendingPayload', 'the payload only moves while no session is open', 'if (!appSelected) promotePendingPayload()'],
  ['onDeactivated', 'a tap that ends closes the session, drops a half write and promotes what is waiting', 'appSelected = false selected = Selected.NONE resetWriteState() promotePendingPayload()'],
];

describe('the Kotlin the vectors stand for', () => {
  it('reads the AID and the file ids out of the Kotlin, not out of this file', () => {
    expect(toHex(AID)).toBe('D2760000850101');
    expect(toHex(CC_FILE_ID)).toBe('E103');
    expect(toHex(NDEF_FILE_ID)).toBe('E104');
  });

  it('assembles every response through the one assembler, never a shared array', () => {
    expect(statusSource).toContain('fun respond(data: ByteArray = EMPTY, sw: Int): ByteArray');
    // 상태 기계가 상태어를 꺼내 쓰는 자리마다 respond() 가 하나씩 있다 = 배열을 손으로
    // 조립하거나 공유 배열을 그대로 돌려주는 자리가 하나도 없다.
    const words = (machineSource.match(/ApduStatus\.SW_[A-Z_0-9]+/g) ?? []).length;
    const assemblies = (machineSource.match(/ApduStatus\.respond\(/g) ?? []).length;
    expect(assemblies).toBeGreaterThanOrEqual(20);
    expect(words).toBe(assemblies);
  });

  it('keeps one buffer for the write path, sized by the declared file', () => {
    // 버퍼와 표가 같은 길이여야 markWritten 의 인덱스 검사가 UPDATE BINARY 의 경계 검사와
    // 같은 뜻이 된다.
    expect(squeeze(machineSource)).toContain('private val writeBuffer = ByteArray(Type4Files.MAX_NDEF_SIZE)');
    expect(squeeze(machineSource)).toContain('private val writtenBytes = BooleanArray(Type4Files.MAX_NDEF_SIZE)');
  });

  for (const [where, what, line] of pins) {
    it(`${where}: ${what}`, () => {
      expect(squeeze(scope[where])).toContain(squeeze(line));
    });
  }
});
