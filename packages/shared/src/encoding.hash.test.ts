import { describe, expect, it } from 'vitest';
import { keccak256, sha256 } from 'viem';
import {
  DEVICE_DIGEST_FORM,
  P256_HALF_ORDER,
  P256_ORDER,
} from './constants.js';
import {
  deviceDigest,
  deviceDigestPreimage,
  deviceDigestV2,
  deviceDigestPreimageV2,
  deviceSigHash,
  deviceSigPreimage,
  gateCodeHash,
  gateCodePreimage,
  nicknameHash,
  normalizeNickname,
  offerDigest,
  recipientCommitment,
} from './encoding.js';
import type { Hex } from './types.js';

const NONCE = ('0x' + '11'.repeat(32)) as Hex;
const ISSUED_AT = 1_789_862_400n; // 2026-09-20T00:00:00Z

describe('gateCodeHash', () => {
  it('matches the fixed vector for gateId=3 eventId=11 issuedAt=1789862400 nonce=0x11*32', () => {
    expect(gateCodeHash({ gateId: 3n, eventId: 11n, issuedAt: ISSUED_AT, nonce: NONCE })).toBe(
      '0xb284e28bf3727ec6a13b3fd1b195cadd348b187d2e904c4013961c068cbe121d',
    );
  });

  it('is sha256 of gateCodePreimage, the bytes a verifier that hashes internally is handed', () => {
    const preimage = gateCodePreimage({ gateId: 3n, eventId: 11n, issuedAt: ISSUED_AT, nonce: NONCE });
    // abi.encode of (uint256, uint256, uint64, bytes32) is four 32-byte words, in that order.
    expect(preimage).toBe(
      '0x' +
        '03'.padStart(64, '0') +
        '0b'.padStart(64, '0') +
        (1_789_862_400).toString(16).padStart(64, '0') +
        '11'.repeat(32),
    );
    expect(sha256(preimage)).toBe(gateCodeHash({ gateId: 3n, eventId: 11n, issuedAt: ISSUED_AT, nonce: NONCE }));
  });

  it('rejects a nonce that is not 32 bytes', () => {
    expect(() => gateCodePreimage({ gateId: 3n, eventId: 11n, issuedAt: ISSUED_AT, nonce: '0x11' as Hex })).toThrow(
      'BAD_NONCE',
    );
  });

  it('changes when any field changes', () => {
    const base = gateCodeHash({ gateId: 3n, eventId: 11n, issuedAt: ISSUED_AT, nonce: NONCE });
    expect(gateCodeHash({ gateId: 4n, eventId: 11n, issuedAt: ISSUED_AT, nonce: NONCE })).not.toBe(base);
    expect(gateCodeHash({ gateId: 3n, eventId: 12n, issuedAt: ISSUED_AT, nonce: NONCE })).not.toBe(base);
    expect(gateCodeHash({ gateId: 3n, eventId: 11n, issuedAt: ISSUED_AT + 1n, nonce: NONCE })).not.toBe(base);
  });
});

describe('deviceSigHash', () => {
  it('matches the fixed vector Ticket.checkIn recomputes on chain', () => {
    expect(
      deviceSigHash({ tokenId: 7n, gateId: 3n, eventId: 11n, nonce: NONCE, issuedAt: ISSUED_AT }),
    ).toBe('0xc99dfaef599235b36414480bc53054182d5f7fc67a33c60233f3f73f7fc560c7');
  });

  it('is not the gate hash with the same inputs', () => {
    expect(deviceSigHash({ tokenId: 7n, gateId: 3n, eventId: 11n, nonce: NONCE, issuedAt: ISSUED_AT })).not.toBe(
      gateCodeHash({ gateId: 3n, eventId: 11n, issuedAt: ISSUED_AT, nonce: NONCE }),
    );
  });

  it('rejects a nonce that is not 32 bytes', () => {
    expect(() =>
      deviceSigHash({ tokenId: 7n, gateId: 3n, eventId: 11n, nonce: '0x11' as Hex, issuedAt: ISSUED_AT }),
    ).toThrow('BAD_NONCE');
  });
});

/**
 * The domain-separated form `Ticket._deviceDigest` lands with sub-plan 01b:
 * `sha256(abi.encode(uint256 chainId, address ticket, uint256 tokenId, uint256 gateId,
 * uint256 eventId, bytes32 nonce, uint64 issuedAt))`. The two extra words stop a signature
 * collected on one chain, or by one Ticket deployment, from being replayed against another.
 */
const V2_INPUT = {
  chainId: 31337n,
  ticket: '0x7111111111111111111111111111111111111111' as Hex,
  tokenId: 7n,
  gateId: 3n,
  eventId: 11n,
  nonce: NONCE,
  issuedAt: ISSUED_AT,
};

describe('deviceDigestV2', () => {
  it('matches the fixed vector the contracts pin (P256Vectors.SHARED_DIGEST)', () => {
    expect(deviceDigestV2(V2_INPUT)).toBe('0xca378ab2af0962bff66d23c4ebb20198fb1a80fe94957e6520368bacae1ffe66');
  });

  it('is sha256 of the seven-word preimage, spelled out by hand', () => {
    expect(deviceDigestPreimageV2(V2_INPUT)).toBe(
      '0x' +
        (31337).toString(16).padStart(64, '0') +
        '7111111111111111111111111111111111111111'.padStart(64, '0') +
        '07'.padStart(64, '0') +
        '03'.padStart(64, '0') +
        '0b'.padStart(64, '0') +
        '11'.repeat(32) +
        (1_789_862_400).toString(16).padStart(64, '0'),
    );
    expect(sha256(deviceDigestPreimageV2(V2_INPUT))).toBe(deviceDigestV2(V2_INPUT));
  });

  it('is not the five-field digest — otherwise the domain words did nothing', () => {
    expect(deviceDigestV2(V2_INPUT)).not.toBe(deviceSigHash(V2_INPUT));
  });

  it('changes with the chain and with the deployment', () => {
    expect(deviceDigestV2({ ...V2_INPUT, chainId: 10143n })).not.toBe(deviceDigestV2(V2_INPUT));
    expect(deviceDigestV2({ ...V2_INPUT, ticket: `0x${'22'.repeat(20)}` as Hex })).not.toBe(deviceDigestV2(V2_INPUT));
  });

  it('rejects a ticket that is not an address', () => {
    expect(() => deviceDigestV2({ ...V2_INPUT, ticket: '0x7111' as Hex })).toThrow('BAD_TICKET_ADDRESS');
  });
});

describe('deviceSigPreimage (v1)', () => {
  it('is what the deprecated five-field hash is sha256 of', () => {
    expect(sha256(deviceSigPreimage(V2_INPUT))).toBe(deviceSigHash(V2_INPUT));
  });
});

describe('the form this build signs', () => {
  it('follows DEVICE_DIGEST_FORM and nothing else', () => {
    const expected = DEVICE_DIGEST_FORM === 'v2-domainSeparated' ? deviceDigestV2(V2_INPUT) : deviceSigHash(V2_INPUT);
    expect(deviceDigest(V2_INPUT)).toBe(expected);
    expect(sha256(deviceDigestPreimage(V2_INPUT))).toBe(deviceDigest(V2_INPUT));
  });

  it('is still the five-field form, because the deployed Ticket.checkIn verifies that one', () => {
    // Flip this line together with DEVICE_DIGEST_FORM when 01b redeploys (its Task 15).
    expect(DEVICE_DIGEST_FORM).toBe('v1-fiveField');
  });
});

describe('the secp256r1 order', () => {
  it('is SEC 2 n, and half of it is the low-s boundary Solady enforces', () => {
    expect(P256_ORDER).toBe(0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n);
    expect(P256_HALF_ORDER).toBe(P256_ORDER / 2n);
  });
});

describe('nickname hashing', () => {
  it('normalizes case, width and surrounding whitespace', () => {
    expect(normalizeNickname('  ALEX  ')).toBe('alex');
    expect(normalizeNickname('ＡＬＥＸ')).toBe('alex');
    expect(nicknameHash('  ALEX  ')).toBe(nicknameHash('alex'));
  });

  it('matches keccak256(utf8("alex"))', () => {
    expect(nicknameHash('Alex')).toBe('0xb83330129510a2461236adc7254a3b4e2f2fa25457c7dcb82be80de0f8c96183');
    expect(nicknameHash('Alex')).toBe(keccak256(new TextEncoder().encode('alex')));
  });

  it('rejects an empty nickname', () => {
    expect(() => nicknameHash('   ')).toThrow('EMPTY_NICKNAME');
  });
});

describe('transfer commitments', () => {
  it('matches the fixed vector for hmacPhone 0x11*32', () => {
    expect(recipientCommitment('11'.repeat(32))).toBe(
      '0xb569321de72d0af89c2fb48a484de3fc9343f31600ae1f3e13d633cb48cbf816',
    );
  });

  it('accepts the 0x prefixed form identically', () => {
    expect(recipientCommitment('0x' + '11'.repeat(32))).toBe(recipientCommitment('11'.repeat(32)));
  });

  it('rejects a short hmacPhone', () => {
    expect(() => recipientCommitment('1111')).toThrow('BAD_HMAC_PHONE');
  });
});

describe('offerDigest', () => {
  it('matches the fixed vector the attester signs for acceptOffer', () => {
    expect(
      offerDigest({
        tokenId: 7n,
        recipientCommitment: ('0x' + '11'.repeat(32)) as Hex,
        recipientAccount: '0x0000000000000000000000000000000000000001' as Hex,
      }),
    ).toBe('0x90244cd7dea2e76fcbe10bb1f52ca2fe9bf143d9f9943bc8f792e664d052ed0a');
  });

  it('changes when the recipient account changes', () => {
    const a = offerDigest({
      tokenId: 7n,
      recipientCommitment: ('0x' + '11'.repeat(32)) as Hex,
      recipientAccount: '0x0000000000000000000000000000000000000001' as Hex,
    });
    const b = offerDigest({
      tokenId: 7n,
      recipientCommitment: ('0x' + '11'.repeat(32)) as Hex,
      recipientAccount: '0x0000000000000000000000000000000000000002' as Hex,
    });
    expect(a).not.toBe(b);
  });
});
