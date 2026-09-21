import { describe, expect, it } from 'vitest';
import { keccak256 } from 'viem';
import {
  deviceSigHash,
  gateCodeHash,
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
