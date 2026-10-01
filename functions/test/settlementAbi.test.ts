import { describe, expect, it } from 'vitest';
import {
  parseAbi,
  toEventSelector,
  toFunctionSelector,
  type Abi,
  type AbiEvent,
  type AbiFunction,
} from 'viem';
import { settlementVaultAbi } from '@monti/shared';
import { settlementAbi } from '../src/lib/settlementAbi.js';

/**
 * settlementAbi 는 이제 01b 가 컴파일 산출물에서 뽑은 생성 ABI(@monti/shared 의 SettlementVault.json)
 * 다. 백엔드(settlement.ts)는 함수·이벤트를 **이름 문자열**로 부르고 revert 를 **에러 이름**으로
 * 매핑한다 — 컨트랙트가 인자 타입을 바꾸면 selector 가 어긋나 호출이 조용히 엉키거나 revert 디코딩이
 * 깨진다. 아래 참조 목록(= settlement.ts 가 실제로 부르는 것)을 생성 ABI 와 selector/이름으로 대조해
 * 그 드리프트를 배포 전에 잡는다. actionAllowlist.test.ts 와 같은 방식이다.
 */
const REFERENCED = parseAbi([
  'struct Recipient { address account; uint16 bps; bytes32 reasonHash; bytes32 tag; }',
  'struct SplitPolicy { Recipient[] recipients; uint16 platformBps; uint16 reserveBps; bool noShowRefund; bool frozen; uint32 version; }',
  'struct PolicyAuth { address organizer; uint256 nonce; uint64 deadline; }',
  // settlement.ts 가 vaultSimulate/vaultCalldata/readContract 로 부르는 함수들
  'function setPolicy(uint256 eventId, SplitPolicy policy, PolicyAuth auth, bytes deviceSig)',
  'function deposit(uint256 eventId, uint256 tokenId, address token, uint128 amount)',
  'function release(uint256 tokenId)',
  'function refund(uint256 tokenId)',
  'function settleNoShows(uint256 eventId, uint256[] tokenIds)',
  'function hashPolicy(SplitPolicy policy) pure returns (bytes32)',
  'function policyNonce(address organizer) view returns (uint256)',
  // logTokenIds 가 parseEventLogs 로 읽는 이벤트들
  'event NoShowSettled(uint256 indexed eventId, uint256 indexed tokenId, address token, uint256 amount)',
  'event Refunded(uint256 indexed eventId, uint256 indexed tokenId, address token, uint256 amount, address payer)',
]) as Abi;

/** settlement.ts 의 revert→code 테이블이 이름으로 디코딩하는 커스텀 에러들. */
const REFERENCED_ERRORS = [
  'UnknownEvent', 'NotPolicyAuthorizer', 'PolicyFrozen', 'AuthExpired', 'BadNonce', 'BadDeviceSignature',
  'InvalidRecipients', 'ZeroRecipient', 'ZeroBps', 'BadSplitSum', 'PlatformShareTooLow',
  'PlatformMirrorMismatch', 'BadReserve', 'Paused', 'NotDepositor', 'TokenNotAllowed', 'ZeroAmount',
  'AlreadyDeposited', 'EventMismatch', 'NoPolicy', 'NoEscrow', 'NothingToRefund', 'AlreadyCheckedIn',
  'EventEnded', 'EventNotEnded',
];

const functionsOf = (abi: Abi): AbiFunction[] =>
  (abi as readonly { type: string }[]).filter((i): i is AbiFunction => i.type === 'function');
const eventsOf = (abi: Abi): AbiEvent[] =>
  (abi as readonly { type: string }[]).filter((i): i is AbiEvent => i.type === 'event');
const errorNamesOf = (abi: Abi): Set<string> =>
  new Set(
    (abi as readonly { type: string; name?: string }[])
      .filter((i) => i.type === 'error' && i.name)
      .map((i) => i.name as string),
  );

describe('settlementAbi ↔ generated SettlementVault ABI (drift guard)', () => {
  it('the backend uses the generated shared ABI, not a hand-written placeholder', () => {
    expect(settlementAbi).toBe(settlementVaultAbi);
  });

  it('every referenced function exists in the generated ABI with the same selector and name', () => {
    for (const ref of REFERENCED.filter((i): i is AbiFunction => i.type === 'function')) {
      const selector = toFunctionSelector(ref);
      const bySelector = functionsOf(settlementVaultAbi).filter(
        (fn) => toFunctionSelector(fn) === selector,
      );
      expect(bySelector, `function ${ref.name}: selector ${selector} 가 생성 ABI 에 없다`).toHaveLength(1);
      expect(bySelector[0]!.name, `function ${ref.name}: 이름 드리프트`).toBe(ref.name);
    }
  });

  it('every referenced event exists in the generated ABI with the same topic and name', () => {
    for (const ref of REFERENCED.filter((i): i is AbiEvent => i.type === 'event')) {
      const topic = toEventSelector(ref);
      const byTopic = eventsOf(settlementVaultAbi).filter((ev) => toEventSelector(ev) === topic);
      expect(byTopic, `event ${ref.name}: topic ${topic} 가 생성 ABI 에 없다`).toHaveLength(1);
      expect(byTopic[0]!.name, `event ${ref.name}: 이름 드리프트`).toBe(ref.name);
    }
  });

  it('every revert code the backend maps exists as a custom error in the generated ABI', () => {
    const errors = errorNamesOf(settlementVaultAbi);
    for (const name of REFERENCED_ERRORS) {
      expect(errors.has(name), `error ${name} 가 생성 ABI 에 없다`).toBe(true);
    }
  });
});
