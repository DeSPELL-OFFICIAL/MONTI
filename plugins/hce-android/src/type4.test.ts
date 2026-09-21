import { describe, expect, it } from 'vitest';
import apduStatusKt from '../android/src/main/java/app/monti/hce/ApduStatus.kt?raw';
import type4FilesKt from '../android/src/main/java/app/monti/hce/Type4Files.kt?raw';

/**
 * Type 4 Tag 바이트 벡터의 단일 진실 원천은 Kotlin이다. 이 기계에는 Android SDK가 없어
 * `android/src/test/.../Type4FilesTest.kt`가 오늘 돌지 않으므로, 이 파일이 **Kotlin 원본을
 * 직접 읽어** 상수를 뽑아내고 같은 벡터로 검사한다. 바이트를 여기서 새로 정의하지 않는다 —
 * 그러면 진실 원천이 둘이 되고, Kotlin이 틀려도 이 테스트는 계속 통과한다.
 *
 * 다만 `ndefFileBytes`는 상수가 아니라 알고리즘이라 원본에서 뽑아낼 수 없다. 그 부분만
 * 아래에 TS 참조 구현을 두고 같은 벡터로 돌린다(= 규약이 자기모순이 아님을 보인다).
 */

// ── Kotlin 원본에서 값 뽑아내기 ──────────────────────────────────────────────

const TOKEN = /0x[0-9a-fA-F]+|\d+|[A-Za-z_][A-Za-z0-9_]*|[()+-]/g;

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/** `(X shr 8) and 0xFF`, `NDEF_FILE_SIZE - 2`, `0xE1.toByte()` 정도만 다루는 최소 평가기. */
function evaluateKotlin(expression: string, scope: Record<string, number>): number {
  const tokens = expression.replace(/\.toByte\(\)/g, '').match(TOKEN) ?? [];
  let at = 0;

  const atom = (): number => {
    const token = tokens[at];
    if (token === undefined) throw new Error(`Kotlin 식이 도중에 끝났다: ${expression}`);
    at += 1;
    if (token === '(') {
      const inner = expr();
      if (tokens[at] !== ')') throw new Error(`괄호가 맞지 않는다: ${expression}`);
      at += 1;
      return inner;
    }
    if (token.startsWith('0x')) return Number.parseInt(token, 16);
    if (/^\d+$/.test(token)) return Number.parseInt(token, 10);
    const bound = scope[token];
    if (bound === undefined) throw new Error(`모르는 식별자 ${token}: ${expression}`);
    return bound;
  };

  const expr = (): number => {
    let value = atom();
    while (at < tokens.length && tokens[at] !== ')') {
      const operator = tokens[at];
      at += 1;
      const right = atom();
      if (operator === 'shr') value >>= right;
      else if (operator === 'shl') value <<= right;
      else if (operator === 'and') value &= right;
      else if (operator === 'or') value |= right;
      else if (operator === '-') value -= right;
      else if (operator === '+') value += right;
      else throw new Error(`지원하지 않는 연산자 ${operator}: ${expression}`);
    }
    return value;
  };

  const value = expr();
  if (at !== tokens.length) throw new Error(`식에 남은 토큰이 있다: ${expression}`);
  return value;
}

function kotlinConst(source: string, name: string, scope: Record<string, number> = {}): number {
  const match = new RegExp(`const val ${name}\\s*=\\s*([^\\n]+)`).exec(stripComments(source));
  if (match?.[1] === undefined) throw new Error(`const val ${name} 을 찾지 못했다`);
  return evaluateKotlin(match[1], scope);
}

/** `anchor` 뒤에 처음 나오는 `byteArrayOf(...)` 리터럴을 바이트 배열로 만든다. */
function kotlinByteArray(
  source: string,
  anchor: string,
  scope: Record<string, number> = {},
): Uint8Array {
  const clean = stripComments(source);
  const anchorAt = clean.indexOf(anchor);
  if (anchorAt < 0) throw new Error(`${anchor} 을 찾지 못했다`);
  const open = clean.indexOf('byteArrayOf(', anchorAt);
  if (open < 0) throw new Error(`${anchor} 뒤에 byteArrayOf( 가 없다`);

  let depth = 1;
  let cursor = open + 'byteArrayOf('.length;
  const start = cursor;
  while (depth > 0) {
    const char = clean[cursor];
    if (char === undefined) throw new Error(`${anchor} 의 byteArrayOf( 가 닫히지 않았다`);
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    cursor += 1;
  }

  const items: string[] = [];
  let nested = 0;
  let buffer = '';
  for (const char of clean.slice(start, cursor - 1)) {
    if (char === '(') nested += 1;
    if (char === ')') nested -= 1;
    if (char === ',' && nested === 0) {
      items.push(buffer);
      buffer = '';
    } else {
      buffer += char;
    }
  }
  items.push(buffer);

  return Uint8Array.from(
    items.filter((item) => item.trim() !== '').map((item) => evaluateKotlin(item, scope) & 0xff),
  );
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join('');
}

const NDEF_FILE_SIZE = kotlinConst(type4FilesKt, 'NDEF_FILE_SIZE');
const MAX_NDEF_SIZE = kotlinConst(type4FilesKt, 'MAX_NDEF_SIZE', { NDEF_FILE_SIZE });
const CC = kotlinByteArray(type4FilesKt, 'fun capabilityContainer()', { NDEF_FILE_SIZE });

// ── TS 참조 구현 (Type4Files.ndefFileBytes 와 같은 규약) ─────────────────────

function ndefFile(message: Uint8Array): Uint8Array {
  if (message.length > MAX_NDEF_SIZE) {
    throw new RangeError(`NDEF message is ${message.length} bytes; the file holds ${MAX_NDEF_SIZE}`);
  }
  const file = new Uint8Array(message.length + 2);
  file[0] = (message.length >> 8) & 0xff;
  file[1] = message.length & 0xff;
  file.set(message, 2);
  return file;
}

// ── 검사 ────────────────────────────────────────────────────────────────────

describe('capability container (Kotlin 원본에서 읽어낸 바이트)', () => {
  it('is the 15 bytes a Type 4 reader reads first', () => {
    expect(CC).toHaveLength(15);
    // CCLEN 000F | mapping 20 | MLe 00FF | MLc 00FF | TLV 04 06 E104 0800 00 00
    expect(hex(CC)).toBe('000F2000FF00FF0406E10408000000');
  });

  it('declares the same NDEF file size the constant says, big-endian', () => {
    expect((CC[11] ?? 0) * 256 + (CC[12] ?? 0)).toBe(NDEF_FILE_SIZE);
  });

  it('names the files E103 and E104', () => {
    expect(hex(kotlinByteArray(type4FilesKt, 'val CC_FILE_ID'))).toBe('E103');
    expect(hex(kotlinByteArray(type4FilesKt, 'val NDEF_FILE_ID'))).toBe('E104');
    // TLV 안의 파일 id가 NDEF_FILE_ID 와 같아야 리더가 같은 파일을 연다.
    expect(hex(CC.slice(9, 11))).toBe('E104');
  });
});

describe('NDEF file capacity', () => {
  it('reserves the two NLEN bytes out of the declared file size', () => {
    expect(NDEF_FILE_SIZE).toBe(2048);
    expect(MAX_NDEF_SIZE).toBe(2046);
    expect(MAX_NDEF_SIZE).toBe(NDEF_FILE_SIZE - 2);
  });

  it('holds a long-form gate record with room to spare', () => {
    // 게이트 코드는 ~389바이트 CBOR이라 레코드 헤더가 long form(0xC4)으로 붙어 ~420바이트가 된다.
    expect(MAX_NDEF_SIZE).toBeGreaterThanOrEqual(420);
  });

  it('is the bound the Kotlin actually checks', () => {
    // 이 한 줄만은 실행이 아니라 원본 대조다 — require() 는 상수가 아니라 코드라 뽑아낼 수 없다.
    expect(stripComments(type4FilesKt)).toContain('require(message.size <= MAX_NDEF_SIZE)');
  });
});

describe('NDEF file layout (NLEN + message)', () => {
  it('writes an empty file as two zero bytes', () => {
    expect(hex(ndefFile(new Uint8Array(0)))).toBe('0000');
  });

  it('prefixes NLEN big-endian', () => {
    const file = ndefFile(new Uint8Array(300).fill(0x41));
    expect(file).toHaveLength(302);
    expect(hex(file.slice(0, 2))).toBe('012C');
    expect(file[2]).toBe(0x41);
    expect(file[301]).toBe(0x41);
  });

  it('carries a 420-byte long-form record', () => {
    const file = ndefFile(new Uint8Array(420).fill(0xc4));
    expect(file).toHaveLength(422);
    expect(hex(file.slice(0, 2))).toBe('01A4');
  });

  it('fills the declared file exactly at the limit and refuses one byte more', () => {
    const full = ndefFile(new Uint8Array(MAX_NDEF_SIZE));
    expect(full).toHaveLength(NDEF_FILE_SIZE);
    expect(hex(full.slice(0, 2))).toBe('07FE');
    expect(() => ndefFile(new Uint8Array(MAX_NDEF_SIZE + 1))).toThrow(RangeError);
  });
});

describe('ISO 7816-4 status words (Kotlin 원본에서 읽어낸 바이트)', () => {
  const expected: Record<string, string> = {
    SW_OK: '9000',
    SW_FILE_NOT_FOUND: '6A82',
    SW_SECURITY: '6982',
    SW_WRONG_P1P2: '6A86',
    SW_WRONG_LENGTH: '6700',
    SW_INS_NOT_SUPPORTED: '6D00',
    SW_CLASS_NOT_SUPPORTED: '6E00',
  };

  for (const [name, word] of Object.entries(expected)) {
    it(`${name} is ${word}`, () => {
      expect(hex(kotlinByteArray(apduStatusKt, `val ${name}`))).toBe(word);
    });
  }
});
