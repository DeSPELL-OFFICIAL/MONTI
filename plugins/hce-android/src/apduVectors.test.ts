import { describe, expect, it } from 'vitest';
import apduStateMachineKt from '../android/src/main/java/app/monti/hce/ApduStateMachine.kt?raw';
import apduStatusKt from '../android/src/main/java/app/monti/hce/ApduStatus.kt?raw';
import type4FilesKt from '../android/src/main/java/app/monti/hce/Type4Files.kt?raw';

/**
 * `ApduStateMachineTest.kt`와 **같은 APDU 요청/응답 벡터**를 오늘 실행한다. 이 기계에는
 * Android SDK가 없어 JUnit 쪽이 아직 한 번도 돌지 않았기 때문이다.
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

  setPendingPayload(ndef: Uint8Array): void {
    if (ndef.length > MAX_NDEF_SIZE) throw new RangeError(`NDEF message is ${ndef.length} bytes`);
    this.pendingPayload = ndef.slice();
    if (!this.appSelected) this.promotePendingPayload();
  }

  onDeactivated(): void {
    this.appSelected = false;
    this.selected = 'NONE';
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
    if (le === 0) le = 256;
    const length = Math.min(le, file.length - offset);
    return respond(file.slice(offset, offset + length), SW.OK);
  }
}

// ── 벡터 ────────────────────────────────────────────────────────────────────

/** monti.app:g 외부 타입 레코드, 페이로드 4바이트. 파일은 NLEN 포함 20바이트. */
const SHORT_RECORD = fromHex('D40B046D6F6E74692E6170703A6701020304');

/** 길이가 다른 두 번째 레코드. 페이로드 교체가 보이는지 보려고 쓴다. */
const OTHER_RECORD = fromHex('D40302666F6FAABB');

/**
 * 진짜 게이트 코드의 모양: ~389바이트 CBOR이 실리면 SR 비트가 꺼져 헤더가 long form(0xC4,
 * 4바이트 payload length)이 되고 레코드가 406바이트가 된다. MLe(255)를 넘는다.
 */
function gateRecord(payloadSize = 389): Uint8Array {
  const type = Uint8Array.from([...'monti.app:g'].map((c) => c.charCodeAt(0)));
  const record = new Uint8Array(6 + type.length + payloadSize);
  record[0] = 0xc4; // MB|ME|TNF=4(external), SR=0
  record[1] = type.length;
  record[2] = (payloadSize >> 24) & 0xff;
  record[3] = (payloadSize >> 16) & 0xff;
  record[4] = (payloadSize >> 8) & 0xff;
  record[5] = payloadSize & 0xff;
  record.set(type, 6);
  // 위치가 그대로 보이도록 0,1,2,… 로 채운다. 오프셋이 틀리면 창이 어긋난다.
  for (let i = 0; i < payloadSize; i += 1) record[6 + type.length + i] = i & 0xff;
  return record;
}

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

function run(m: ReferenceStateMachine, script: ReadonlyArray<readonly [string, string]>): void {
  for (const [request, expected] of script) {
    expect(`${request} → ${exchange(m, request)}`).toBe(`${request} → ${expected}`);
  }
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
      // UPDATE BINARY 도 아직 여기로 떨어진다 — 쓰기 경로는 Task 5 다.
      ['00D60000020000', '6D00'],
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
 * (`if (!appSelected) return ... SW_SECURITY` 는 handleSelect 에도 handleReadBinary 에도 있다).
 * 원본 전체에서 찾으면 한쪽을 망가뜨려도 다른 쪽이 핀을 만족시켜 버린다.
 */
const scope = {
  process: kotlinFunctionBody(machineSource, 'fun process(apdu: ByteArray)'),
  setPendingPayload: kotlinFunctionBody(machineSource, 'fun setPendingPayload'),
  onDeactivated: kotlinFunctionBody(machineSource, 'fun onDeactivated'),
  handleSelect: kotlinFunctionBody(machineSource, 'private fun handleSelect'),
  currentFile: kotlinFunctionBody(machineSource, 'private fun currentFile'),
  handleReadBinary: kotlinFunctionBody(machineSource, 'private fun handleReadBinary'),
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
  ['process', 'any other INS is 6D00', 'else -> ApduStatus.respond(sw = ApduStatus.SW_INS_NOT_SUPPORTED)'],

  ['handleSelect', 'SELECT by name is P1P2 = 0400', 'if (p1 == 0x04 && p2 == 0x00)'],
  ['handleSelect', 'a foreign AID is 6A82', 'if (!data.contentEquals(aid)) return ApduStatus.respond(sw = ApduStatus.SW_FILE_NOT_FOUND)'],
  ['handleSelect', 'SELECT AID answers with the status word alone — no FCI', 'return ApduStatus.respond(sw = ApduStatus.SW_OK)'],
  ['handleSelect', 'SELECT AID starts the session', 'promotePendingPayload() appSelected = true selected = Selected.NONE'],
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
  ['handleReadBinary', 'Le comes out of the APDU, 0 meaning 256', 'var le = if (apdu.size > 4) apdu[4].toInt() and 0xFF else 0 if (le == 0) le = 256'],
  ['handleReadBinary', 'a read never overruns the file', 'val length = minOf(le, file.size - offset)'],
  ['handleReadBinary', 'the window comes out of the chosen file', 'return ApduStatus.respond(file.copyOfRange(offset, offset + length), ApduStatus.SW_OK)'],

  ['setPendingPayload', 'a message too big for the declared file is refused', 'require(ndef.size <= Type4Files.MAX_NDEF_SIZE)'],
  ['setPendingPayload', 'the payload only moves while no session is open', 'if (!appSelected) promotePendingPayload()'],
  ['onDeactivated', 'a tap that ends closes the session and promotes what is waiting', 'appSelected = false selected = Selected.NONE promotePendingPayload()'],
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
    expect(assemblies).toBeGreaterThanOrEqual(12);
    expect(words).toBe(assemblies);
  });

  for (const [where, what, line] of pins) {
    it(`${where}: ${what}`, () => {
      expect(squeeze(scope[where])).toContain(squeeze(line));
    });
  }
});
