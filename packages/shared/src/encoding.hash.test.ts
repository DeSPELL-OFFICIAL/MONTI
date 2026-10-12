import { describe, expect, it } from 'vitest';
import { keccak256, sha256 } from 'viem';
import {
  DEVICE_DIGEST_FORM,
  MONAD_TESTNET_CHAIN_ID,
  P256_HALF_ORDER,
  P256_ORDER,
  ticketAddress,
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
/** abi-delta-01b §7 의 가상 배포. 컨트랙트 쪽 고정 벡터와 같은 fixture 를 쓴다. */
const FIXTURE_CHAIN_ID = 31337;
const FIXTURE_TICKET = '0x7111111111111111111111111111111111111111' as Hex;
/** Monad 테스트넷(10143)에 지금 올라가 있는 Ticket(v2 rc1, 2026-10-12). */
const LIVE_CHAIN_ID = 10143;
const LIVE_TICKET = '0x8544c531A3EF7f702fe3A64Ff20D57bA774d9edC' as Hex;
const RECIPIENT = '0x0000000000000000000000000000000000000001' as Hex;

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
  it('matches the fixed vector the retired Ticket.checkIn recomputed on chain', () => {
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

/**
 * 같은 공식을 두 도메인에서 못 박는다. 둘 다 필요하다.
 *
 * - 위 `V2_INPUT` 은 컨트랙트 테스트가 쓰는 가상의 배포본(chain 31337, Ticket 0x7111…1111)이라
 *   Solidity 쪽 고정 벡터(`P256Vectors.SHARED_DIGEST`)와 1:1 로 맞춰 볼 수 있다. 존재하지
 *   않는 주소이므로 체인에 물어볼 수는 없다.
 * - 아래 `LIVE_INPUT` 은 2026-09-23 에 실제로 올라간 Ticket 이 `deviceDigest(...)` 뷰로
 *   되돌려준 값이다(abi-delta-01b §10). 다섯 개의 caller 입력은 위와 똑같고, 앞의 두 워드
 *   —`chainid` 와 `address(this)`— 만 다르다.
 *
 * 그 두 워드가 바로 클라이언트가 고를 수 없는 입력이고, 로컬 재구현이 틀리는 곳도 정확히
 * 거기다. 한쪽만 남기면 "도메인 워드가 정말 다이제스트를 바꾸는가"와 "그 바꾸는 방식이
 * 배포된 컨트랙트와 같은가" 중 하나를 잃는다.
 */
describe('deviceDigestV2 against the deployed Ticket', () => {
  const LIVE_INPUT = {
    chainId: 10143n,
    // v2 rc1 Ticket(2026-10-12, block 70161104). 기대값은 그 컨트랙트의 deviceDigest(7,3,11,0x11*32,1789862400)
    // eth_call 이 돌려준 값이다 — 재배포하면 주소와 벡터를 함께 다시 떠야 한다.
    ticket: '0x8544c531A3EF7f702fe3A64Ff20D57bA774d9edC' as Hex,
    tokenId: 7n,
    gateId: 3n,
    eventId: 11n,
    nonce: NONCE,
    issuedAt: ISSUED_AT,
  };

  it('reproduces what the live deviceDigest(...) view returned on 10143', () => {
    expect(deviceDigestV2(LIVE_INPUT)).toBe(
      '0xcaba7b087bd89614721b46d73391176cf543c4ec91548b62e388c968a537b505',
    );
  });

  it('names the Ticket the deployment record names, so a redeploy cannot leave this behind', () => {
    expect(ticketAddress(MONAD_TESTNET_CHAIN_ID)).toBe(LIVE_INPUT.ticket);
  });

  it('differs from the 31337 vector on the two domain words alone', () => {
    expect({ ...LIVE_INPUT, chainId: V2_INPUT.chainId, ticket: V2_INPUT.ticket }).toEqual(V2_INPUT);
    expect(deviceDigestV2(LIVE_INPUT)).not.toBe(deviceDigestV2(V2_INPUT));
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

  it('is the domain-separated form, because that is what the deployed Ticket verifies', () => {
    // Pinned to the deployment, not to a plan: 01b went out on 2026-09-23 (chain 10143, Ticket
    // 0x4B8353C9…1367) and its `_deviceDigest` is the seven-word form. This line and
    // DEVICE_DIGEST_FORM move together, and only when a redeploy moves the contract.
    expect(DEVICE_DIGEST_FORM).toBe('v2-domainSeparated');
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
  const FIXTURE = {
    chainId: FIXTURE_CHAIN_ID,
    ticket: FIXTURE_TICKET,
    tokenId: 7n,
    recipientCommitment: NONCE,
    recipientAccount: RECIPIENT,
  };

  it('matches the EIP-712 vector the attester signs for acceptOffer', () => {
    expect(offerDigest(FIXTURE)).toBe(
      '0x7171ab3831d8e0d4a58ce6d8076a10c080c5a97849229aecf84c801dcafbc88d',
    );
  });

  it('changes when the recipient account changes', () => {
    expect(
      offerDigest({ ...FIXTURE, recipientAccount: '0x0000000000000000000000000000000000000002' as Hex }),
    ).not.toBe(offerDigest(FIXTURE));
  });

  // 도메인 분리. 옛 배포본·다른 체인에서 만든 서명이 새 배포본에서 살아남지 않는다.
  it('changes when the chain id or the Ticket address changes', () => {
    const base = offerDigest(FIXTURE);
    expect(offerDigest({ ...FIXTURE, chainId: LIVE_CHAIN_ID })).not.toBe(base);
    expect(offerDigest({ ...FIXTURE, ticket: LIVE_TICKET })).not.toBe(base);
  });

  it('rejects a Ticket address that is not 20 bytes', () => {
    expect(() => offerDigest({ ...FIXTURE, ticket: '0x71' as Hex })).toThrow('BAD_TICKET');
  });
});
