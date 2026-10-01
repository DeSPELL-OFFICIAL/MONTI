import { describe, expect, it } from 'vitest';
import { keccak256, sha256, toHex } from 'viem';
import type { Address } from 'viem';
import {
  SETTLE_POLICY_TAG,
  buildPolicyDigest,
  encodePolicyStruct,
  hashPolicy,
  reasonHash,
  setPolicyDigest,
  setPolicyPreimage,
  tagToBytes32,
  type PolicyInput,
} from './settlement.js';
import type { Hex } from './types.js';

/**
 * 모든 벡터는 foundry `cast` 가 낸 것으로, `SettlementVault.sol` 이 쓰는 바로 그 ABI 인코더·
 * keccak256·sha256 이다. 여기 TS(viem) 구현이 이 값들을 **정확히** 재현해야 한다 — 그게 이
 * 모듈의 존재 이유다. `demoPolicy` 는 아티스트 6000 / 대관 2000 / 기획 1500 / 플랫폼 500 이다.
 */
const DEMO_POLICY: PolicyInput = {
  recipients: [
    { account: '0x1111111111111111111111111111111111111111' as Address, bps: 6000, reason: '출연료', tag: 'artist' },
    { account: '0x2222222222222222222222222222222222222222' as Address, bps: 2000, reason: '대관료', tag: 'venue' },
    { account: '0x3333333333333333333333333333333333333333' as Address, bps: 1500, reason: '기획비', tag: 'organizer' },
    { account: '0x4444444444444444444444444444444444444444' as Address, bps: 500, reason: '플랫폼 수수료', tag: 'platform' },
  ],
  platformBps: 500,
  reserveBps: 0,
  noShowRefund: false,
};

const POLICY_HASH = '0xa037c7b194d20b002c366e9531cb3035c02153d6d915235cb7c36378991ad117' as Hex;

// cast 가 낸 abi.encode(policy.recipients, platformBps, reserveBps, noShowRefund) 전체.
const ENCODE_POLICY_STRUCT =
  '0x000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000001f4000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000004000000000000000000000000111111111111111111111111111111111111111100000000000000000000000000000000000000000000000000000000000017700317227a1b6af3680671283b8d132ee1b863cb450f552b341c2bfc9d16b61c5b6172746973740000000000000000000000000000000000000000000000000000000000000000000000000000222222222222222222222222222222222222222200000000000000000000000000000000000000000000000000000000000007d024714faa06ac14645eee150f42abbc3e353aa5b8942b0fb88779ce3e4a4f692976656e7565000000000000000000000000000000000000000000000000000000000000000000000000000000333333333333333333333333333333333333333300000000000000000000000000000000000000000000000000000000000005dc0e7952ffdefcf900fcabd3e3d8ccfad7e9d5b08639c972ca039c05d65dedbe396f7267616e697a65720000000000000000000000000000000000000000000000000000000000000000000000444444444444444444444444444444444444444400000000000000000000000000000000000000000000000000000000000001f48ca51ea8718aad3a73de95f4af76dd64e19fe45bc5dc69c9778531dafff9bcd9706c6174666f726d000000000000000000000000000000000000000000000000' as Hex;

// 가상 금고 0x…beef, chainId 10143, eventId 1, nonce 0, deadline 1893456000.
const BEEF_VAULT = '0x000000000000000000000000000000000000beef' as Address;
const BEEF_CTX = { chainId: 10143n, vault: BEEF_VAULT, eventId: 1n, nonce: 0n, deadline: 1_893_456_000n };
const BEEF_PREIMAGE =
  '0xb87d1613d97a8a84ebfb6556e726ec88aa5c1aa27623e99d536c987b539efe8c000000000000000000000000000000000000000000000000000000000000279f000000000000000000000000000000000000000000000000000000000000beef0000000000000000000000000000000000000000000000000000000000000001a037c7b194d20b002c366e9531cb3035c02153d6d915235cb7c36378991ad11700000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000070dbd880' as Hex;
const BEEF_DIGEST = '0x2a9d9125f85618c1bff599ff8c28342f252165d45c95d0f45b63200b27b8e67d' as Hex;

// 실제 배포된 SettlementVault(Monad testnet 10143). cast call 로 hashPolicy/setPolicyDigest 뷰를
// 직접 대조한 값이라 ground truth 다.
const LIVE_VAULT = '0xA84FDb64C9DDc3B25eF8BDeA58561BDbE53ABD69' as Address;
const LIVE_DIGEST = '0xf1f98eb2ba42f05f7923ad0c03c4a959a3aa8bcf98a87ca31f0d848a20473b00' as Hex;

describe('reasonHash', () => {
  it('is keccak256(utf8Bytes(reason)) for each demo recipient', () => {
    expect(reasonHash('출연료')).toBe('0x0317227a1b6af3680671283b8d132ee1b863cb450f552b341c2bfc9d16b61c5b');
    expect(reasonHash('대관료')).toBe('0x24714faa06ac14645eee150f42abbc3e353aa5b8942b0fb88779ce3e4a4f6929');
    expect(reasonHash('기획비')).toBe('0x0e7952ffdefcf900fcabd3e3d8ccfad7e9d5b08639c972ca039c05d65dedbe39');
    expect(reasonHash('플랫폼 수수료')).toBe('0x8ca51ea8718aad3a73de95f4af76dd64e19fe45bc5dc69c9778531dafff9bcd9');
  });

  it('is exactly keccak256(toHex(reason))', () => {
    expect(reasonHash('출연료')).toBe(keccak256(toHex('출연료')));
  });
});

describe('tagToBytes32', () => {
  it('is stringToHex(tag, { size: 32 }) — ascii right-padded to 32 bytes', () => {
    expect(tagToBytes32('artist')).toBe('0x6172746973740000000000000000000000000000000000000000000000000000');
    expect(tagToBytes32('venue')).toBe('0x76656e7565000000000000000000000000000000000000000000000000000000');
    expect(tagToBytes32('organizer')).toBe('0x6f7267616e697a65720000000000000000000000000000000000000000000000');
    expect(tagToBytes32('platform')).toBe('0x706c6174666f726d000000000000000000000000000000000000000000000000');
  });
});

describe('SETTLE_POLICY_TAG', () => {
  it('matches keccak256("MONTI:SETTLE_POLICY:v1") as the contract pins it', () => {
    expect(SETTLE_POLICY_TAG).toBe('0xb87d1613d97a8a84ebfb6556e726ec88aa5c1aa27623e99d536c987b539efe8c');
  });
});

describe('encodePolicyStruct', () => {
  it('reproduces the foundry cast abi.encode of the demo policy byte for byte', () => {
    expect(encodePolicyStruct(DEMO_POLICY)).toBe(ENCODE_POLICY_STRUCT);
  });

  it('defaults reserveBps to 0 and noShowRefund to false', () => {
    const { reserveBps: _r, noShowRefund: _n, ...withoutDefaults } = DEMO_POLICY;
    expect(encodePolicyStruct(withoutDefaults)).toBe(ENCODE_POLICY_STRUCT);
  });
});

describe('hashPolicy', () => {
  it('is keccak256(encodePolicyStruct) and matches the cast vector', () => {
    expect(hashPolicy(DEMO_POLICY)).toBe(POLICY_HASH);
    expect(hashPolicy(DEMO_POLICY)).toBe(keccak256(encodePolicyStruct(DEMO_POLICY)));
  });
});

describe('setPolicyPreimage', () => {
  it('reproduces the cast abi.encode(tag, chainId, vault, eventId, policyHash, nonce, deadline)', () => {
    expect(setPolicyPreimage({ ...BEEF_CTX, policyHash: POLICY_HASH })).toBe(BEEF_PREIMAGE);
  });
});

describe('setPolicyDigest', () => {
  it('matches the cast sha256 vector for the 0x…beef vault', () => {
    expect(setPolicyDigest({ ...BEEF_CTX, policyHash: POLICY_HASH })).toBe(BEEF_DIGEST);
  });

  it('is sha256 of setPolicyPreimage with the same inputs', () => {
    const params = { ...BEEF_CTX, policyHash: POLICY_HASH };
    expect(setPolicyDigest(params)).toBe(sha256(setPolicyPreimage(params)));
  });
});

describe('buildPolicyDigest', () => {
  it('bundles policyHash, preimage and digest consistently (0x…beef vector)', () => {
    const built = buildPolicyDigest(DEMO_POLICY, BEEF_CTX);
    expect(built.policyHash).toBe(POLICY_HASH);
    expect(built.preimage).toBe(BEEF_PREIMAGE);
    expect(built.digest).toBe(BEEF_DIGEST);
  });

  it('reproduces the LIVE SettlementVault setPolicyDigest view (Monad testnet 10143)', () => {
    const built = buildPolicyDigest(DEMO_POLICY, {
      chainId: 10143n,
      vault: LIVE_VAULT,
      eventId: 1n,
      nonce: 0n,
      deadline: 1_893_456_000n,
    });
    expect(built.policyHash).toBe(POLICY_HASH);
    expect(built.digest).toBe(LIVE_DIGEST);
  });
});

describe('domain separation', () => {
  it('the settlement digest is sha256 of the preimage, not a naive keccak of the same bytes', () => {
    const params = { ...BEEF_CTX, policyHash: POLICY_HASH };
    expect(setPolicyDigest(params)).not.toBe(keccak256(setPolicyPreimage(params)));
  });

  it('a tag is a right-padded string, never keccak(tag)', () => {
    expect(tagToBytes32('artist')).not.toBe(keccak256(toHex('artist')));
  });

  it('changes with the vault and the chain — the two domain words the client cannot choose', () => {
    const base = setPolicyDigest({ ...BEEF_CTX, policyHash: POLICY_HASH });
    expect(setPolicyDigest({ ...BEEF_CTX, policyHash: POLICY_HASH, vault: LIVE_VAULT })).not.toBe(base);
    expect(setPolicyDigest({ ...BEEF_CTX, policyHash: POLICY_HASH, chainId: 1n })).not.toBe(base);
  });
});
