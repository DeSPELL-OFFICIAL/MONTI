import { describe, expect, it } from 'vitest';
import type { GateCodeWire, GateResponseWire } from '@monti/shared';
import {
  NDEF_GATE_TYPE,
  NDEF_RESPONSE_TYPE,
  encodeGateCode,
  encodeGateResponse,
} from '@monti/shared';
// The staff phone's HCE file model is Kotlin. It is read here rather than restated, so a change
// on that side that this codec could not survive fails in this file instead of at a gate.
import type4FilesKt from '../../../../../plugins/hce-android/android/src/main/java/app/monti/hce/Type4Files.kt?raw';
import { GATE_CODE_RECORD_TYPE, GATE_RESPONSE_RECORD_TYPE, TNF_EXTERNAL } from './records';
import {
  MAX_NDEF_SIZE,
  NDEF_DECODE_ERROR,
  NdefDecodeError,
  decodeExternalRecord,
  decodeGateCodeMessage,
  decodeGateResponseMessage,
  encodeExternalRecord,
  encodeGateCodeMessage,
  encodeGateResponseMessage,
  type NdefDecodeErrorCode,
} from './ndef';

// ── helpers ─────────────────────────────────────────────────────────────────

/**
 * The refusal reason, as a string, so a wrong-but-still-thrown error reads as a diff instead of
 * a bare "threw". Every rejection in this file names its code: two refusals that collapse into
 * one code are two bugs the gate can no longer tell apart.
 */
function refusal(run: () => unknown): NdefDecodeErrorCode | string {
  try {
    run();
  } catch (error) {
    if (error instanceof NdefDecodeError) return error.code;
    return `threw ${String(error)}, not an NdefDecodeError`;
  }
  return 'did not throw';
}

const ascii = (text: string): Uint8Array =>
  Uint8Array.from([...text].map((character) => character.charCodeAt(0)));

/** 0,1,2,… — a payload whose every byte says where it belongs, so a shifted window shows. */
const counting = (size: number): Uint8Array => Uint8Array.from({ length: size }, (_, i) => i & 0xff);

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

/**
 * A record built by hand — including records that are wrong on purpose. The encoder is what is
 * under test, so it cannot be what produces the decoder's input in a rejection case.
 */
function handBuilt(options: {
  header: number;
  type: string;
  payload: Uint8Array;
  longForm?: boolean;
  declaredPayloadLength?: number;
  declaredTypeLength?: number;
}): Uint8Array {
  const typeBytes = ascii(options.type);
  const longForm = options.longForm ?? options.payload.length > 255;
  const declared = options.declaredPayloadLength ?? options.payload.length;
  const headerSize = longForm ? 6 : 3;
  const out = new Uint8Array(headerSize + typeBytes.length + options.payload.length);
  out[0] = options.header;
  out[1] = options.declaredTypeLength ?? typeBytes.length;
  if (longForm) {
    out[2] = (declared >>> 24) & 0xff;
    out[3] = (declared >>> 16) & 0xff;
    out[4] = (declared >>> 8) & 0xff;
    out[5] = declared & 0xff;
  } else {
    out[2] = declared & 0xff;
  }
  out.set(typeBytes, headerSize);
  out.set(options.payload, headerSize + typeBytes.length);
  return out;
}

/** MB|ME|SR|TNF=4 and MB|ME|TNF=4 — the only two first bytes this codec ever writes. */
const SHORT_HEADER = 0xd4;
const LONG_HEADER = 0xc4;

// ── fixtures: the same bytes sub-plan 04's APDU vectors carry ────────────────

/** The attendee's real answer. `@monti/shared` sizes it, so a wire change lands here first. */
const RESPONSE_WIRE: GateResponseWire = {
  v: 1,
  tokenId: '1234567',
  deviceSig: `0x${'ab'.repeat(64)}`,
};
const RESPONSE_CBOR = encodeGateResponse(RESPONSE_WIRE);

const NONCE = `0x${'11'.repeat(32)}` as const;
const GATE_CODE: GateCodeWire = {
  v: 1,
  gateId: '7',
  eventId: '3',
  issuedAt: 1790000000,
  nonce: NONCE,
  kx: `0x${'aa'.repeat(32)}`,
  ky: `0x${'bb'.repeat(32)}`,
  sig: `0x${'cc'.repeat(64)}`,
};
const GATE_CODE_CBOR = encodeGateCode(GATE_CODE);

/** Task 4's 176-byte short record and 417-byte long record, rebuilt by the codec under test. */
const SHORT_FIXTURE = encodeExternalRecord(NDEF_RESPONSE_TYPE, RESPONSE_CBOR);
const LONG_FIXTURE = encodeExternalRecord(NDEF_RESPONSE_TYPE, counting(400));

// ── the type strings ────────────────────────────────────────────────────────

describe('the external type strings', () => {
  it('comes from @monti/shared, never from a second spelling in this app', () => {
    expect(GATE_CODE_RECORD_TYPE).toBe(NDEF_GATE_TYPE);
    expect(GATE_RESPONSE_RECORD_TYPE).toBe(NDEF_RESPONSE_TYPE);
    expect(NDEF_GATE_TYPE).toBe('monti.app:g');
    expect(NDEF_RESPONSE_TYPE).toBe('monti.app:s');
  });

  it('is written into the record as its ASCII bytes, at the length the header declares', () => {
    const record = encodeExternalRecord(NDEF_GATE_TYPE, new Uint8Array([1, 2, 3]));
    expect(record[1]).toBe(NDEF_GATE_TYPE.length);
    expect([...record.slice(3, 3 + NDEF_GATE_TYPE.length)]).toEqual([...ascii(NDEF_GATE_TYPE)]);
  });
});

// ── encoding ────────────────────────────────────────────────────────────────

describe('encodeExternalRecord', () => {
  it('encodes a short record with MB|ME|SR and TNF 4', () => {
    const out = encodeExternalRecord(NDEF_GATE_TYPE, new Uint8Array([1, 2, 3]));
    expect(out[0]).toBe(SHORT_HEADER);
    expect(out[0]! & 0x07).toBe(TNF_EXTERNAL);
    expect(out[1]).toBe(11);
    expect(out[2]).toBe(3);
    expect(new TextDecoder().decode(out.slice(3, 14))).toBe('monti.app:g');
    expect([...out.slice(14)]).toEqual([1, 2, 3]);
  });

  it('sets MB and ME, because the message it writes is exactly one record', () => {
    const header = encodeExternalRecord(NDEF_RESPONSE_TYPE, counting(8))[0]!;
    expect(header & 0x80).toBe(0x80); // MB
    expect(header & 0x40).toBe(0x40); // ME
    expect(header & 0x20).toBe(0); // CF — never chunked
    expect(header & 0x08).toBe(0); // IL — never an ID field
  });

  it('switches to a long record above 255 payload bytes', () => {
    const out = encodeExternalRecord(NDEF_RESPONSE_TYPE, new Uint8Array(300));
    expect(out[0]).toBe(LONG_HEADER);
    expect([...out.slice(2, 6)]).toEqual([0, 0, 1, 44]);
    expect(out.length).toBe(1 + 1 + 4 + 11 + 300);
  });

  it('keeps 255 short and makes 256 long — the boundary the SR bit names', () => {
    const at255 = encodeExternalRecord(NDEF_GATE_TYPE, counting(255));
    expect(at255[0]).toBe(SHORT_HEADER);
    expect(at255[2]).toBe(255);
    expect(at255.length).toBe(3 + 11 + 255);

    const at256 = encodeExternalRecord(NDEF_GATE_TYPE, counting(256));
    expect(at256[0]).toBe(LONG_HEADER);
    expect([...at256.slice(2, 6)]).toEqual([0, 0, 1, 0]);
    expect(at256.length).toBe(6 + 11 + 256);
  });

  it('writes an empty payload as a short record of length 0', () => {
    const out = encodeExternalRecord(NDEF_RESPONSE_TYPE, new Uint8Array(0));
    expect(out[0]).toBe(SHORT_HEADER);
    expect(out[2]).toBe(0);
    expect(out.length).toBe(3 + 11);
    expect(decodeExternalRecord(out).payload.length).toBe(0);
  });

  it('refuses a record that would not fit the NDEF file the staff phone serves', () => {
    const largest = MAX_NDEF_SIZE - 6 - NDEF_RESPONSE_TYPE.length;
    expect(encodeExternalRecord(NDEF_RESPONSE_TYPE, counting(largest)).length).toBe(MAX_NDEF_SIZE);
    expect(refusal(() => encodeExternalRecord(NDEF_RESPONSE_TYPE, counting(largest + 1)))).toBe(
      NDEF_DECODE_ERROR.tooLarge,
    );
  });
});

// ── the two fixtures sub-plan 04's APDU vectors already carry ────────────────

describe('the records a real tap carries', () => {
  it('frames the real answer as the 176-byte short record the write vectors use', () => {
    expect(RESPONSE_CBOR.length).toBe(162);
    expect(SHORT_FIXTURE.length).toBe(176);
    expect(SHORT_FIXTURE[0]).toBe(SHORT_HEADER);
    expect([...SHORT_FIXTURE.slice(3, 3 + 11)]).toEqual([...ascii(NDEF_RESPONSE_TYPE)]);
    expect([...SHORT_FIXTURE.slice(14)]).toEqual([...RESPONSE_CBOR]);
  });

  it('frames a 400-byte payload as the 417-byte long record the write vectors use', () => {
    expect(LONG_FIXTURE.length).toBe(417);
    expect(LONG_FIXTURE[0]).toBe(LONG_HEADER);
    expect([...LONG_FIXTURE.slice(2, 6)]).toEqual([0, 0, 1, 0x90]); // 400
  });

  it('frames the real gate code as a 406-byte long record: 389 bytes of CBOR', () => {
    const record = encodeGateCodeMessage(GATE_CODE);
    expect(GATE_CODE_CBOR.length).toBe(389);
    expect(record.length).toBe(406);
    expect(record[0]).toBe(LONG_HEADER);
  });
});

// ── decoding ────────────────────────────────────────────────────────────────

describe('decodeExternalRecord', () => {
  it('round-trips', () => {
    const payload = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]);
    const decoded = decodeExternalRecord(encodeExternalRecord(NDEF_RESPONSE_TYPE, payload));
    expect(decoded.type).toBe('monti.app:s');
    expect([...decoded.payload]).toEqual([...payload]);
  });

  it('round-trips both fixtures byte for byte', () => {
    expect([...decodeExternalRecord(SHORT_FIXTURE).payload]).toEqual([...RESPONSE_CBOR]);
    expect(decodeExternalRecord(SHORT_FIXTURE).type).toBe(NDEF_RESPONSE_TYPE);
    expect([...decodeExternalRecord(LONG_FIXTURE).payload]).toEqual([...counting(400)]);
  });

  it('copies the payload out, so the caller may reuse the message buffer', () => {
    const message = Uint8Array.from(SHORT_FIXTURE);
    const decoded = decodeExternalRecord(message);
    message.fill(0);
    expect([...decoded.payload]).toEqual([...RESPONSE_CBOR]);
  });

  it('accepts a long-form record a reader could have written short', () => {
    // Not what this codec writes, but legal NDEF, and some readers do it. Refusing it would
    // turn an interoperable tap into a no-read for a difference that carries no meaning.
    const record = handBuilt({
      header: LONG_HEADER,
      type: NDEF_RESPONSE_TYPE,
      payload: counting(4),
      longForm: true,
    });
    expect([...decodeExternalRecord(record).payload]).toEqual([0, 1, 2, 3]);
  });
});

describe('decodeExternalRecord refuses, each with its own code', () => {
  it('refuses a record that is not an external type', () => {
    const wellKnown = new Uint8Array([0xd1, 0x01, 0x01, 0x54, 0x41]); // TNF 1, "T" text record
    expect(refusal(() => decodeExternalRecord(wellKnown))).toBe(NDEF_DECODE_ERROR.unknownTnf);
  });

  it('refuses a message holding more than one record', () => {
    const first = handBuilt({
      header: 0x80 | 0x10 | TNF_EXTERNAL, // MB, no ME: another record follows
      type: NDEF_GATE_TYPE,
      payload: counting(4),
    });
    const second = handBuilt({
      header: 0x40 | 0x10 | TNF_EXTERNAL, // ME, no MB
      type: NDEF_RESPONSE_TYPE,
      payload: counting(4),
    });
    expect(refusal(() => decodeExternalRecord(concat(first, second)))).toBe(
      NDEF_DECODE_ERROR.notSingleRecord,
    );
  });

  it('refuses bytes left over after the one record ends', () => {
    expect(refusal(() => decodeExternalRecord(concat(SHORT_FIXTURE, SHORT_FIXTURE)))).toBe(
      NDEF_DECODE_ERROR.trailingBytes,
    );
    expect(refusal(() => decodeExternalRecord(concat(SHORT_FIXTURE, new Uint8Array([0]))))).toBe(
      NDEF_DECODE_ERROR.trailingBytes,
    );
  });

  it('refuses a chunked record', () => {
    const chunked = handBuilt({
      header: 0x80 | 0x20 | 0x10 | TNF_EXTERNAL, // CF
      type: NDEF_GATE_TYPE,
      payload: counting(4),
    });
    expect(refusal(() => decodeExternalRecord(chunked))).toBe(NDEF_DECODE_ERROR.chunked);
  });

  it('refuses a record carrying an ID field', () => {
    const withId = handBuilt({
      header: SHORT_HEADER | 0x08, // IL
      type: NDEF_GATE_TYPE,
      payload: counting(4),
    });
    expect(refusal(() => decodeExternalRecord(withId))).toBe(NDEF_DECODE_ERROR.idField);
  });

  it('refuses an external type outside the MONTI namespace', () => {
    const foreign = handBuilt({
      header: SHORT_HEADER,
      type: 'example.com:g',
      payload: counting(4),
    });
    expect(refusal(() => decodeExternalRecord(foreign))).toBe(NDEF_DECODE_ERROR.foreignType);
    const nearMiss = handBuilt({ header: SHORT_HEADER, type: 'monti.app:x', payload: counting(4) });
    expect(refusal(() => decodeExternalRecord(nearMiss))).toBe(NDEF_DECODE_ERROR.foreignType);
  });

  it('refuses a truncated record', () => {
    const good = encodeExternalRecord(NDEF_GATE_TYPE, new Uint8Array([1, 2, 3]));
    expect(refusal(() => decodeExternalRecord(good.slice(0, good.length - 1)))).toBe(
      NDEF_DECODE_ERROR.truncated,
    );
    expect(refusal(() => decodeExternalRecord(new Uint8Array(0)))).toBe(NDEF_DECODE_ERROR.truncated);
    expect(refusal(() => decodeExternalRecord(new Uint8Array([SHORT_HEADER, 11])))).toBe(
      NDEF_DECODE_ERROR.truncated,
    );
  });

  it('refuses a long record whose 4-byte length field is itself cut off', () => {
    expect(refusal(() => decodeExternalRecord(LONG_FIXTURE.slice(0, 5)))).toBe(
      NDEF_DECODE_ERROR.truncated,
    );
  });

  it('refuses a payload length that disagrees with the buffer', () => {
    const overLong = handBuilt({
      header: SHORT_HEADER,
      type: NDEF_RESPONSE_TYPE,
      payload: counting(4),
      declaredPayloadLength: 40, // claims 40 bytes, carries 4
    });
    expect(refusal(() => decodeExternalRecord(overLong))).toBe(NDEF_DECODE_ERROR.truncated);

    const underLong = handBuilt({
      header: SHORT_HEADER,
      type: NDEF_RESPONSE_TYPE,
      payload: counting(40),
      declaredPayloadLength: 4, // claims 4 bytes, carries 40
    });
    expect(refusal(() => decodeExternalRecord(underLong))).toBe(NDEF_DECODE_ERROR.trailingBytes);

    const wrongTypeLength = handBuilt({
      header: SHORT_HEADER,
      type: NDEF_RESPONSE_TYPE,
      payload: counting(4),
      declaredTypeLength: 200,
    });
    expect(refusal(() => decodeExternalRecord(wrongTypeLength))).toBe(NDEF_DECODE_ERROR.truncated);
  });

  it('refuses a message longer than the NDEF file could ever hold', () => {
    const tooBig = handBuilt({
      header: LONG_HEADER,
      type: NDEF_RESPONSE_TYPE,
      payload: counting(MAX_NDEF_SIZE),
    });
    expect(tooBig.length).toBeGreaterThan(MAX_NDEF_SIZE);
    expect(refusal(() => decodeExternalRecord(tooBig))).toBe(NDEF_DECODE_ERROR.tooLarge);
  });
});

// ── the gate payloads: framing only, the CBOR is @monti/shared's ─────────────

describe('the gate-code and gate-response messages', () => {
  it('carries exactly the bytes @monti/shared encodes — no second CBOR codec here', () => {
    expect([...decodeExternalRecord(encodeGateCodeMessage(GATE_CODE)).payload]).toEqual([
      ...encodeGateCode(GATE_CODE),
    ]);
    expect([...decodeExternalRecord(encodeGateResponseMessage(RESPONSE_WIRE)).payload]).toEqual([
      ...encodeGateResponse(RESPONSE_WIRE),
    ]);
  });

  it('round-trips the gate code through the record and back', () => {
    expect(decodeGateCodeMessage(encodeGateCodeMessage(GATE_CODE))).toEqual(GATE_CODE);
  });

  it('round-trips the gate response through the record and back', () => {
    expect(decodeGateResponseMessage(encodeGateResponseMessage(RESPONSE_WIRE))).toEqual(
      RESPONSE_WIRE,
    );
  });

  it('frames each wire under its own type', () => {
    expect(decodeExternalRecord(encodeGateCodeMessage(GATE_CODE)).type).toBe(NDEF_GATE_TYPE);
    expect(decodeExternalRecord(encodeGateResponseMessage(RESPONSE_WIRE)).type).toBe(
      NDEF_RESPONSE_TYPE,
    );
  });

  it('refuses to read a response record as a gate code, and the other way round', () => {
    expect(refusal(() => decodeGateCodeMessage(encodeGateResponseMessage(RESPONSE_WIRE)))).toBe(
      NDEF_DECODE_ERROR.foreignType,
    );
    expect(refusal(() => decodeGateResponseMessage(encodeGateCodeMessage(GATE_CODE)))).toBe(
      NDEF_DECODE_ERROR.foreignType,
    );
  });

  it('refuses a payload the shared decoder rejects, and says which one it was', () => {
    const wrongVersion = Uint8Array.from(GATE_CODE_CBOR);
    wrongVersion[2] = 0x02; // the value byte of "v"
    const message = encodeExternalRecord(NDEF_GATE_TYPE, wrongVersion);
    expect(refusal(() => decodeGateCodeMessage(message))).toBe(NDEF_DECODE_ERROR.badPayload);

    const junk = encodeExternalRecord(NDEF_RESPONSE_TYPE, counting(16));
    expect(refusal(() => decodeGateResponseMessage(junk))).toBe(NDEF_DECODE_ERROR.badPayload);
  });

  it('keeps the shared decoder’s own reason as the cause', () => {
    const junk = encodeExternalRecord(NDEF_RESPONSE_TYPE, counting(16));
    try {
      decodeGateResponseMessage(junk);
      expect.unreachable('a junk payload must not decode');
    } catch (error) {
      expect(error).toBeInstanceOf(NdefDecodeError);
      expect(String((error as NdefDecodeError).cause)).toContain('BAD_GATE_RESPONSE');
    }
  });

  it('refuses a framing fault before it ever reaches the CBOR decoder', () => {
    const wellKnown = new Uint8Array([0xd1, 0x01, 0x01, 0x54, 0x41]);
    expect(refusal(() => decodeGateCodeMessage(wellKnown))).toBe(NDEF_DECODE_ERROR.unknownTnf);
  });
});

// ── property: every size the NDEF file can hold ─────────────────────────────

/** Seeded so a failure is reproducible; a random seed would make a red run unrepeatable. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const recordSize = (type: string, payloadSize: number): number =>
  (payloadSize <= 255 ? 3 : 6) + type.length + payloadSize;

describe('every payload size the NDEF file can hold', () => {
  it('round-trips random sizes across 0..MAX_NDEF_SIZE, and refuses only what cannot fit', () => {
    const random = mulberry32(0x4d4f4e54); // "MONT"
    const sizes = new Set<number>([0, 1, 2, 254, 255, 256, 257, MAX_NDEF_SIZE]);
    for (let i = 0; i < 160; i += 1) sizes.add(Math.floor(random() * (MAX_NDEF_SIZE + 1)));

    for (const size of sizes) {
      const type = size % 2 === 0 ? NDEF_GATE_TYPE : NDEF_RESPONSE_TYPE;
      const payload = counting(size);
      const framed = recordSize(type, size);
      if (framed > MAX_NDEF_SIZE) {
        expect(`${size} → ${refusal(() => encodeExternalRecord(type, payload))}`).toBe(
          `${size} → ${NDEF_DECODE_ERROR.tooLarge}`,
        );
        continue;
      }
      const record = encodeExternalRecord(type, payload);
      expect(`${size} → ${record.length}`).toBe(`${size} → ${framed}`);
      const decoded = decodeExternalRecord(record);
      expect(`${size} → ${decoded.type}`).toBe(`${size} → ${type}`);
      expect(`${size} → ${decoded.payload.length}`).toBe(`${size} → ${size}`);
      expect(decoded.payload).toEqual(payload);
    }
  });

  it('puts the short/long boundary at 255 for every size, not only at the fixtures', () => {
    for (const size of [0, 1, 254, 255, 256, 257, 1000, 2029]) {
      const record = encodeExternalRecord(NDEF_RESPONSE_TYPE, counting(size));
      expect(`${size} → ${record[0]!.toString(16)}`).toBe(
        `${size} → ${(size <= 255 ? SHORT_HEADER : LONG_HEADER).toString(16)}`,
      );
    }
  });
});

// ── source pin: the Kotlin file model the staff phone actually serves ───────

const kotlin = type4FilesKt.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
const squeeze = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** `const val NAME = 2048` or `const val NAME = OTHER - 2`. Anything else must fail loudly. */
function kotlinIntConst(name: string, scope: Record<string, number> = {}): number {
  const match = new RegExp(`const val ${name}\\s*=\\s*([^\\n]+)`).exec(kotlin);
  if (!match?.[1]) throw new Error(`Type4Files.kt no longer declares ${name}`);
  const expression = squeeze(match[1]);
  const literal = /^(\d+)$/.exec(expression);
  if (literal?.[1]) return Number.parseInt(literal[1], 10);
  const subtraction = /^([A-Z_]+) - (\d+)$/.exec(expression);
  if (subtraction?.[1] && subtraction[2]) {
    const left = scope[subtraction[1]];
    if (left === undefined) throw new Error(`unknown ${subtraction[1]} in ${name} = ${expression}`);
    return left - Number.parseInt(subtraction[2], 10);
  }
  throw new Error(`${name} = ${expression} is beyond this pin's tiny evaluator`);
}

describe('the Kotlin NDEF file model this codec is sized against', () => {
  it('takes MAX_NDEF_SIZE from Type4Files.kt rather than restating it', () => {
    const fileSize = kotlinIntConst('NDEF_FILE_SIZE');
    const maxMessage = kotlinIntConst('MAX_NDEF_SIZE', { NDEF_FILE_SIZE: fileSize });
    expect(fileSize).toBe(2048);
    expect(maxMessage).toBe(2046); // the file, less the two NLEN bytes
    expect(MAX_NDEF_SIZE).toBe(maxMessage);
  });

  it('pins the NLEN layout the reader depends on: big-endian, two bytes, then the message', () => {
    const body = /fun ndefFileBytes\(message: ByteArray\): ByteArray \{([\s\S]*?)\n {4}\}/.exec(
      kotlin,
    )?.[1];
    expect(body, 'Type4Files.ndefFileBytes moved or changed shape').toBeTruthy();
    const source = squeeze(body ?? '');
    expect(source).toContain('out[0] = ((message.size shr 8) and 0xFF).toByte()');
    expect(source).toContain('out[1] = (message.size and 0xFF).toByte()');
    expect(source).toContain('message.copyInto(out, 2)');
    // The same guard the encoder's tooLarge refusal mirrors: the phone rejects what this codec
    // refuses to build, so the two boundaries cannot drift apart silently.
    expect(source).toContain('require(message.size <= MAX_NDEF_SIZE)');
  });

  it('serves this codec’s records at the NLEN the reader will read', () => {
    const nlen = (message: Uint8Array): number[] => [
      (message.length >> 8) & 0xff,
      message.length & 0xff,
    ];
    expect(nlen(SHORT_FIXTURE)).toEqual([0x00, 0xb0]); // 176
    expect(nlen(LONG_FIXTURE)).toEqual([0x01, 0xa1]); // 417
    expect(nlen(encodeGateCodeMessage(GATE_CODE))).toEqual([0x01, 0x96]); // 406
    // Two NLEN bytes can carry the biggest record the codec will build, with room to spare.
    expect(MAX_NDEF_SIZE).toBeLessThan(0x10000);
  });

  it('keeps the SR boundary independent of MLe, which happens to be 255 too', () => {
    // A reader splits its READ BINARY windows at MLe; a record picks short form at 255 payload
    // bytes. The two numbers are equal today by coincidence, and changing MLe must not move the
    // record threshold — this test is what says so.
    expect(kotlinIntConst('MLE')).toBe(255);
    expect(encodeExternalRecord(NDEF_GATE_TYPE, counting(255))[0]).toBe(SHORT_HEADER);
    expect(encodeExternalRecord(NDEF_GATE_TYPE, counting(256))[0]).toBe(LONG_HEADER);
  });
});
