import { describe, expect, it } from 'vitest';
import { sha256 } from 'viem';
import type { Address } from 'viem';
import {
  CLAIM_AUTH_TAG,
  claimAuthDigest,
  claimAuthPreimage,
  decodeClaimAuthStruct,
  encodeClaimAuthStruct,
  type ClaimAuth,
} from './claimAuth.js';
import { deviceDigest } from './encoding.js';
import type { Hex } from './types.js';

/**
 * 고정 벡터. 값은 실제 컨트랙트(MONTI-01b eee7660 Ticket.claimAuthDigest)를 forge 스크립트로 배포·호출해
 * 뽑았다 — viem 구현과 독립적이다. `ticket` 은 그 스크립트가 배포한 인스턴스 주소이고, 다이제스트가
 * abi.encode 에서 그 값을 쓰므로 벡터에 그대로 박는다.
 */
const VECTORS: {
  label: string;
  chainId: bigint;
  ticket: Address;
  auth: ClaimAuth;
  digest: Hex;
}[] = [
  {
    label: 'V1 all-zero',
    chainId: 10143n,
    ticket: '0x5aAdFB43eF8dAF45DD80F4676345b7676f1D70e3',
    auth: { eventId: 0n, tier: 0, account: '0x0000000000000000000000000000000000000000', nonce: 0n, deadline: 0n },
    digest: '0x596b33fc7eeda4e272dfe90dff9fb49d65e58070c1beb54d6f680adb8d9f43b3',
  },
  {
    label: 'V2 mid-range',
    chainId: 1n,
    ticket: '0xf13D09eD3cbdD1C930d4de74808de1f33B6b3D4f',
    auth: {
      eventId: 42n,
      tier: 3,
      account: '0x1111111111111111111111111111111111111111',
      nonce: 7n,
      deadline: 1893456000n,
    },
    digest: '0x983774083117fa232ce88f01557824f4073b7c5393935b4d7ce7b053376f56b9',
  },
  {
    label: 'V3 max edges',
    chainId: 84532n,
    ticket: '0x5c4a3C2CD1ffE6aAfDF62b64bb3E620C696c832E',
    auth: {
      eventId: (1n << 160n) - 1n,
      tier: 255,
      account: '0xffffffffffffffffffffffffffffffffffffffff',
      nonce: (1n << 256n) - 1n,
      deadline: (1n << 64n) - 1n,
    },
    digest: '0x4815096ff10842164b5713ac23e54ffa9c4d0d0acfc92e9115446bd38a187773',
  },
];

describe('CLAIM_AUTH_TAG', () => {
  it('is keccak256("MONTI:CLAIM_AUTH:v1")', () => {
    expect(CLAIM_AUTH_TAG).toBe('0x0c31019fd7c9f3057fb75521175f310ac14750eaec48c3211b12fb12bad708e8');
  });
});

describe('claimAuthDigest', () => {
  for (const v of VECTORS) {
    it(`matches the contract-derived vector: ${v.label}`, () => {
      expect(claimAuthDigest(v.chainId, v.ticket, v.auth)).toBe(v.digest);
    });
  }

  it('is sha256 of claimAuthPreimage, the bytes a verifier that hashes internally is handed', () => {
    const v = VECTORS[0]!;
    // abi.encode of (bytes32, uint256, address, uint256, uint8, address, uint256, uint64) is eight 32-byte words.
    const preimage = claimAuthPreimage(v.chainId, v.ticket, v.auth);
    expect(preimage).toBe(
      '0x' +
        CLAIM_AUTH_TAG.slice(2) +
        (10143).toString(16).padStart(64, '0') +
        '5aadfb43ef8daf45dd80f4676345b7676f1d70e3'.padStart(64, '0') +
        '0'.repeat(64) + // eventId
        '0'.repeat(64) + // tier
        '0'.repeat(64) + // account
        '0'.repeat(64) + // nonce
        '0'.repeat(64), // deadline
    );
    expect(sha256(preimage)).toBe(v.digest);
  });

  it('rejects a tier outside uint8', () => {
    expect(() => claimAuthDigest(1n, VECTORS[1]!.ticket, { ...VECTORS[1]!.auth, tier: 256 })).toThrow('BAD_TIER');
  });

  it('rejects a malformed ticket address', () => {
    expect(() => claimAuthDigest(1n, '0x1234' as Address, VECTORS[1]!.auth)).toThrow('BAD_TICKET_ADDRESS');
  });
});

describe('encodeClaimAuthStruct / decodeClaimAuthStruct', () => {
  it('round-trips through the JSON-safe wire form', () => {
    for (const v of VECTORS) {
      const wire = encodeClaimAuthStruct(v.auth);
      expect(JSON.parse(JSON.stringify(wire))).toEqual(wire); // JSON-safe: no bigint leaks
      expect(decodeClaimAuthStruct(wire)).toEqual(v.auth);
    }
  });

  it('serializes bigints as decimal strings in struct order', () => {
    const wire = encodeClaimAuthStruct(VECTORS[1]!.auth);
    expect(wire).toEqual({
      eventId: '42',
      tier: 3,
      account: '0x1111111111111111111111111111111111111111',
      nonce: '7',
      deadline: '1893456000',
    });
  });

  it('rejects a non-decimal nonce on decode', () => {
    expect(() =>
      decodeClaimAuthStruct({ ...encodeClaimAuthStruct(VECTORS[1]!.auth), nonce: '0x7' }),
    ).toThrow('BAD_DECIMAL');
  });
});

describe('domain separation from deviceDigest', () => {
  it('a claim digest never equals the check-in digest of the same numbers', () => {
    const chainId = 10143n;
    const ticket = '0x4B8353C9F3503Cdbd011E8f35da0a955D95b1367' as Hex;
    const eventId = 11n;
    const claim = claimAuthDigest(chainId, ticket, {
      eventId,
      tier: 0,
      account: '0x0000000000000000000000000000000000000001',
      nonce: 5n,
      deadline: 1n,
    });
    const checkIn = deviceDigest({
      chainId,
      ticket,
      tokenId: 1n,
      gateId: 5n,
      eventId,
      nonce: ('0x' + '00'.repeat(32)) as Hex,
      issuedAt: 1n,
    });
    expect(claim).not.toBe(checkIn);
  });
});
