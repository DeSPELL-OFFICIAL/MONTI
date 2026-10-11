import { describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import type { Address } from 'viem';
import {
  encodePolicyStruct,
  hashPolicy,
  reasonHash,
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
