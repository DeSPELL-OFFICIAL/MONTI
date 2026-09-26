import { p256 } from '@noble/curves/p256';
import { hexToBytes, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';

import {
  CLOCK_SKEW_SECONDS,
  CODE_WINDOW_SECONDS,
  encodeGateResponse,
  joinRs,
  splitRs,
  toQrPayload,
  type GateCodeWire,
  type GateResponseWire,
} from '@monti/shared';

import {
  NDEF_TYPE_RESPONSE,
} from '../constants';
import {
  encodeExternalRecord,
  encodeGateCodeMessage,
  encodeGateResponseMessage,
} from '../../shared/nfc/ndef';
import {
  RESPONSE_ERROR,
  ResponseDecodeError,
  decodeQrResponse,
  decodeTapResponse,
  matchIssuedCode,
} from './decodeResponse';

const NOW_SECONDS = 1_700_000_000;
const NOW_MS = NOW_SECONDS * 1000;
const NONCE = `0x${'11'.repeat(32)}` as const;

function code(overrides: Partial<GateCodeWire> = {}): GateCodeWire {
  return {
    v: 1,
    gateId: '7',
    eventId: '42',
    issuedAt: NOW_SECONDS,
    nonce: NONCE,
    kx: `0x${'aa'.repeat(32)}`,
    ky: `0x${'bb'.repeat(32)}`,
    sig: `0x${'cc'.repeat(64)}`,
    ...overrides,
  };
}

/**
 * The attendee's answer, built by the encoder the attendee phone actually ships
 * (`@monti/shared`'s `encodeGateResponse`) rather than by bytes typed here. `tokenId: '7'` and
 * `nonce: 0x11…` are the package's pinned cross-branch vector; the record around it is Task 9's.
 */
const RESPONSE: GateResponseWire = {
  v: 2,
  tokenId: '7',
  nonce: NONCE,
  deviceSig: `0x${'22'.repeat(32)}${'33'.repeat(32)}`,
};

/** The refusal code, or the returned value when nothing was refused. */
function refusal(run: () => unknown): unknown {
  try {
    return run();
  } catch (error) {
    if (error instanceof ResponseDecodeError) return error.code;
    throw error;
  }
}

function denyOf(run: () => unknown): unknown {
  try {
    return run();
  } catch (error) {
    if (error instanceof ResponseDecodeError) return error.deny;
    throw error;
  }
}

const toWord = (value: bigint): Hex => `0x${value.toString(16).padStart(64, '0')}`;

describe('decoding the answer a tap carries', () => {
  it('reads back exactly what the attendee encoder produced', () => {
    const message = encodeGateResponseMessage(RESPONSE);
    // The package's pinned vector, framed: 230 bytes of CBOR in a 244-byte short record.
    expect(encodeGateResponse(RESPONSE)).toHaveLength(230);
    expect(message).toHaveLength(244);
    expect(decodeTapResponse(message)).toEqual(RESPONSE);
  });

  it('refuses the gate’s own code echoed back at it, with no verdict for the attendee', () => {
    const echoed = encodeGateCodeMessage(code());
    expect(refusal(() => decodeTapResponse(echoed))).toBe(RESPONSE_ERROR.badTag);
    expect(denyOf(() => decodeTapResponse(echoed))).toBeUndefined();
  });

  it('refuses framing that is not ours and a payload that is not a response', () => {
    expect(refusal(() => decodeTapResponse(new Uint8Array([0, 1, 2])))).toBe(RESPONSE_ERROR.badTag);
    const truncated = encodeGateResponseMessage(RESPONSE).slice(0, 100);
    expect(refusal(() => decodeTapResponse(truncated))).toBe(RESPONSE_ERROR.badTag);
  });

  /**
   * A phone running a build from before the nonce landed writes a v1 answer. It is refused like
   * any other unreadable tag — but the reason survives on `cause`, because "that attendee needs
   * to update" is a different field report from "that was not a MONTI tag".
   */
  it('keeps the underlying refusal on `cause`, so a v1 answer is traceable', () => {
    // `a1 61 76 01` is CBOR for `{ v: 1 }` — the version byte is all this needs to carry.
    const v1 = encodeExternalRecord(NDEF_TYPE_RESPONSE, new Uint8Array([0xa1, 0x61, 0x76, 0x01]));
    try {
      decodeTapResponse(v1);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ResponseDecodeError);
      expect((error as ResponseDecodeError).code).toBe(RESPONSE_ERROR.badTag);
      expect(String((error as { cause?: { cause?: unknown } }).cause?.cause)).toContain(
        'GATE_RESPONSE_VERSION',
      );
    }
  });

  it('decodes the MONTI1: QR fallback into the very same object', () => {
    expect(decodeQrResponse(toQrPayload(RESPONSE))).toEqual(RESPONSE);
  });

  it('refuses a QR payload that is not ours', () => {
    expect(refusal(() => decodeQrResponse('https://example.com'))).toBe(RESPONSE_ERROR.badTag);
    expect(refusal(() => decodeQrResponse('MONTI2:AAEC'))).toBe(RESPONSE_ERROR.badTag);
    expect(refusal(() => decodeQrResponse('MONTI1:AAEC'))).toBe(RESPONSE_ERROR.badTag);
  });
});

describe('matching the answer to a code this gate actually served', () => {
  it('finds the ring entry the answer names, not the one now on the wire', () => {
    const answered = code({ nonce: NONCE, issuedAt: NOW_SECONDS - 6 });
    const ring = [code({ nonce: `0x${'aa'.repeat(32)}` }), code({ nonce: `0x${'bb'.repeat(32)}` }), answered];
    expect(matchIssuedCode({ response: RESPONSE, codes: ring, now: NOW_MS })).toEqual(answered);
  });

  it('UNKNOWN_CODE for a nonce this gate has no record of serving', () => {
    const run = () =>
      matchIssuedCode({ response: RESPONSE, codes: [code({ nonce: `0x${'ff'.repeat(32)}` })], now: NOW_MS });
    expect(refusal(run)).toBe(RESPONSE_ERROR.unknownCode);
    expect(denyOf(run)).toBe('EXPIRED_CODE');
  });

  it('UNKNOWN_CODE when the gate has served nothing at all', () => {
    expect(refusal(() => matchIssuedCode({ response: RESPONSE, codes: [], now: NOW_MS }))).toBe(
      RESPONSE_ERROR.unknownCode,
    );
  });

  it('CODE_EXPIRED — a code this gate did serve, past the window the chain would take', () => {
    const stale = code({ issuedAt: NOW_SECONDS - CODE_WINDOW_SECONDS - CLOCK_SKEW_SECONDS });
    const run = () => matchIssuedCode({ response: RESPONSE, codes: [stale], now: NOW_MS });
    expect(refusal(run)).toBe(RESPONSE_ERROR.codeExpired);
    expect(denyOf(run)).toBe('EXPIRED_CODE');
  });

  it('keeps a code the chain would still take at the very edge of the window', () => {
    const edge = code({ issuedAt: NOW_SECONDS - CODE_WINDOW_SECONDS - CLOCK_SKEW_SECONDS + 1 });
    expect(matchIssuedCode({ response: RESPONSE, codes: [edge], now: NOW_MS })).toEqual(edge);
  });

  it('refuses a high-s signature here, because the chain would only revert on it', () => {
    const { r, s } = splitRs(RESPONSE.deviceSig);
    const high = joinRs(r, toWord(p256.CURVE.n - BigInt(s)));
    const run = () =>
      matchIssuedCode({ response: { ...RESPONSE, deviceSig: high }, codes: [code()], now: NOW_MS });
    expect(refusal(run)).toBe(RESPONSE_ERROR.badSignature);
    expect(denyOf(run)).toBe('DEVICE_MISMATCH');
  });

  it('refuses r or s outside the curve order before anything is sent', () => {
    for (const deviceSig of [
      joinRs(toWord(p256.CURVE.n), toWord(1n)),
      joinRs(toWord(0n), toWord(1n)),
      joinRs(toWord(1n), toWord(0n)),
    ]) {
      expect(
        refusal(() => matchIssuedCode({ response: { ...RESPONSE, deviceSig }, codes: [code()], now: NOW_MS })),
      ).toBe(RESPONSE_ERROR.badSignature);
    }
  });

  it('takes a real low-s signature from a real P-256 key', () => {
    const signature = p256.sign(hexToBytes(`0x${'99'.repeat(32)}`), hexToBytes(`0x${'42'.repeat(32)}`), {
      prehash: false,
    });
    const deviceSig: Hex = `0x${signature.toCompactHex()}`;
    expect(BigInt(splitRs(deviceSig).s) <= p256.CURVE.n / 2n).toBe(true);
    expect(matchIssuedCode({ response: { ...RESPONSE, deviceSig }, codes: [code()], now: NOW_MS })).toEqual(
      code(),
    );
  });

  /**
   * `DEVICE_MISMATCH` is a claim about a device. The gate has no business making it about an
   * answer to a code it never issued — whoever tapped may simply be at the wrong gate, and
   * "다시 대세요" is the only honest thing to say to them.
   */
  it('looks the nonce up before it judges the signature', () => {
    const malformed = { ...RESPONSE, deviceSig: joinRs(toWord(1n), toWord(0n)) };
    const run = () => matchIssuedCode({ response: malformed, codes: [], now: NOW_MS });
    expect(refusal(run)).toBe(RESPONSE_ERROR.unknownCode);
    expect(denyOf(run)).toBe('EXPIRED_CODE');

    // Once the code is ours, the signature is worth judging — and before a transaction is paid.
    expect(
      refusal(() => matchIssuedCode({ response: malformed, codes: [code()], now: NOW_MS })),
    ).toBe(RESPONSE_ERROR.badSignature);
  });

  it('still prefers the expiry over the signature for a code it served too long ago', () => {
    const stale = code({ issuedAt: NOW_SECONDS - CODE_WINDOW_SECONDS - CLOCK_SKEW_SECONDS });
    expect(
      refusal(() =>
        matchIssuedCode({
          response: { ...RESPONSE, deviceSig: joinRs(toWord(1n), toWord(0n)) },
          codes: [stale],
          now: NOW_MS,
        }),
      ),
    ).toBe(RESPONSE_ERROR.codeExpired);
  });
});
