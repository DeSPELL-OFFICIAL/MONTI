import { describe, expect, it } from 'vitest';
import { toFunctionSelector, type Abi, type AbiFunction } from 'viem';
import { identityAbi, organizersAbi, ticketAbi } from '@monti/shared';
import { ACTION_ALLOWLIST, type ActionTarget } from '../src/lib/actionAllowlist.js';

/**
 * actionAllowlist 의 (시그니처, selector) 는 손으로 적은 값이고, 대상 ABI 는 컨트랙트에서 뽑아
 * 온다. 컨트랙트가 인자 타입을 바꾸면 selector 가 어긋나 대납이 조용히 거절되거나(최선) 엉뚱한
 * 함수로 나간다(최악). 이 테스트가 그 드리프트를 배포 전에 잡는다.
 */
const abiFor = (t: ActionTarget): Abi =>
  t === 'organizers' ? organizersAbi : t === 'identity' ? identityAbi : ticketAbi;

const functionsOf = (abi: Abi): AbiFunction[] =>
  (abi as readonly { type: string }[]).filter((i): i is AbiFunction => i.type === 'function');

describe('actionAllowlist — v2 off-chain moves', () => {
  it('no longer relays requestOverride (v2 P4: requests live in Firestore)', () => {
    expect(ACTION_ALLOWLIST.requestOverride).toBeUndefined();
    const present = new Set(Object.values(ACTION_ALLOWLIST).map((e) => e.selector));
    expect(present.has(toFunctionSelector('function requestOverride(uint256,uint256,uint8)'))).toBe(false);
  });
});

describe('actionAllowlist ↔ generated ABI (drift guard)', () => {
  it('every allowlisted signature is self-consistent (toFunctionSelector(signature) === selector)', () => {
    for (const [kind, entry] of Object.entries(ACTION_ALLOWLIST)) {
      expect(toFunctionSelector(entry.signature), kind).toBe(entry.selector);
    }
  });

  it('every allowlisted signature exists in the generated target ABI with the same selector and name', () => {
    for (const [kind, entry] of Object.entries(ACTION_ALLOWLIST)) {
      const name = entry.signature.match(/function\s+([A-Za-z0-9_]+)\s*\(/)?.[1];
      expect(name, `${kind}: 시그니처에서 함수 이름을 뽑지 못했다`).toBeTruthy();
      const bySelector = functionsOf(abiFor(entry.target)).filter(
        (fn) => toFunctionSelector(fn) === entry.selector,
      );
      expect(
        bySelector,
        `${kind} → ${entry.target}: selector ${entry.selector} 가 생성 ABI 에 없다`,
      ).toHaveLength(1);
      expect(bySelector[0]!.name, `${kind}: 이름 드리프트`).toBe(name);
    }
  });
});
