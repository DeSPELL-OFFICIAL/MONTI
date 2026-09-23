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
/** abi-delta-01b §7 의 가상 배포. 컨트랙트 쪽 고정 벡터와 같은 fixture 를 쓴다. */
const FIXTURE_CHAIN_ID = 31337;
const FIXTURE_TICKET = '0x7111111111111111111111111111111111111111' as Hex;
/** 2026-09-23 Monad 테스트넷(10143)에 실제로 올라간 Ticket. */
const LIVE_CHAIN_ID = 10143;
const LIVE_TICKET = '0x4B8353C9F3503Cdbd011E8f35da0a955D95b1367' as Hex;
const RECIPIENT = '0x0000000000000000000000000000000000000001' as Hex;

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
  const FIXTURE = {
    chainId: FIXTURE_CHAIN_ID,
    ticket: FIXTURE_TICKET,
    tokenId: 7n,
    gateId: 3n,
    eventId: 11n,
    nonce: NONCE,
    issuedAt: ISSUED_AT,
  };

  it('matches the fixed vector Ticket.deviceDigest recomputes on chain', () => {
    expect(deviceSigHash(FIXTURE)).toBe(
      '0xca378ab2af0962bff66d23c4ebb20198fb1a80fe94957e6520368bacae1ffe66',
    );
  });

  // 온체인 정합성 앵커. 2026-09-23 배포된 Ticket 0x4B83…1367 의 deviceDigest(7, 3, 11, 0x11*32,
  // 1789862400) 가 실제로 돌려준 값을 그대로 박았다(task-15 보고서). 클라이언트가 고를 수 없는 두
  // 워드(chainid, address(this))를 컨트랙트가 채운 결과라, 이 테스트만이 로컬 재구현을 검증한다.
  it('matches the value read back from the deployed Ticket on chain 10143', () => {
    expect(
      deviceSigHash({
        chainId: LIVE_CHAIN_ID,
        ticket: LIVE_TICKET,
        tokenId: 7n,
        gateId: 3n,
        eventId: 11n,
        nonce: NONCE,
        issuedAt: ISSUED_AT,
      }),
    ).toBe('0xec0c84e899cdacfab3dc560fc6ad89a3db7800cd07154b5ad3f24d0d4f46f8e9');
  });

  // 새로 붙은 두 워드의 존재 이유 그 자체.
  it('changes when the chain id or the Ticket address changes', () => {
    const base = deviceSigHash(FIXTURE);
    expect(deviceSigHash({ ...FIXTURE, chainId: LIVE_CHAIN_ID })).not.toBe(base);
    expect(deviceSigHash({ ...FIXTURE, ticket: LIVE_TICKET })).not.toBe(base);
  });

  it('is not the gate hash with the same inputs', () => {
    expect(deviceSigHash(FIXTURE)).not.toBe(
      gateCodeHash({ gateId: 3n, eventId: 11n, issuedAt: ISSUED_AT, nonce: NONCE }),
    );
  });

  it('rejects a nonce that is not 32 bytes', () => {
    expect(() => deviceSigHash({ ...FIXTURE, nonce: '0x11' as Hex })).toThrow('BAD_NONCE');
  });

  it('rejects a Ticket address that is not 20 bytes', () => {
    expect(() => deviceSigHash({ ...FIXTURE, ticket: '0x71' as Hex })).toThrow('BAD_TICKET');
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
