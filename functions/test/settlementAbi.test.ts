import { describe, expect, it } from 'vitest';
import {
  decodeErrorResult,
  encodeAbiParameters,
  encodeErrorResult,
  getAddress,
  keccak256,
  parseAbi,
  toEventSelector,
  toFunctionSelector,
  type Abi,
  type AbiEvent,
  type AbiFunction,
  type Hex,
} from 'viem';
import { settlementVaultAbi, ticketAbi } from '@monti/shared';
import {
  UNITS_PER_CENT,
  hashPolicy,
  purchaseSimAbi,
  reasonHashOf,
  settlementAbi,
  tagToBytes32,
} from '../src/lib/settlementAbi.js';

/**
 * settlementAbi 는 컴파일 산출물에서 뽑은 생성 ABI(@monti/shared 의 SettlementVault.json, v2 K1 동결)다.
 * 백엔드(settlement.ts)는 함수·이벤트를 **이름 문자열**로 부르고 revert 를 **에러 이름**으로 매핑한다 —
 * 컨트랙트가 인자 타입을 바꾸면 selector 가 어긋나 호출이 조용히 엉키거나 revert 디코딩이 깨진다.
 * 아래 참조 목록(= settlement.ts 가 실제로 부르는 것)을 생성 ABI 와 selector/이름으로 대조한다.
 */
const REFERENCED = parseAbi([
  'struct ClaimAuth { uint256 eventId; uint8 tier; address account; uint256 nonce; uint64 deadline; }',
  // settlement.ts 가 vaultSimulate/vaultCalldata/readContract 로 부르는 함수들
  'function purchase(ClaimAuth a, bytes deviceSig, address token) returns (uint256 tokenId)',
  'function release(uint256 tokenId)',
  'function refund(uint256 tokenId)',
  'function settleNoShows(uint256 eventId, uint256[] tokenIds)',
  'function UNITS_PER_CENT() view returns (uint256)',
  // logTokenIds 가 parseEventLogs 로 읽는 이벤트들
  'event NoShowSettled(uint256 indexed eventId, uint256 indexed tokenId, address token, uint256 amount)',
  'event Refunded(uint256 indexed eventId, uint256 indexed tokenId, address token, uint256 amount, address payer)',
]) as Abi;

/** settlement.ts 의 revert→code 테이블이 이름으로 디코딩하는 금고 커스텀 에러들. */
const REFERENCED_ERRORS = [
  'Paused', 'NotDepositor', 'TokenNotAllowed', 'NoEscrow', 'NothingToRefund', 'AlreadyCheckedIn',
  'EventEnded', 'EventNotEnded', 'AlreadySettled', 'NotCheckedIn',
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

  it('purchase has the frozen v2 selector 0xbff81841 (abi-delta-v2.md)', () => {
    const purchase = functionsOf(settlementVaultAbi).find((fn) => fn.name === 'purchase');
    expect(purchase && toFunctionSelector(purchase)).toBe('0xbff81841');
  });

  it('v2 removed deposit and the signed setPolicy path; setPolicyByTicket replaces it', () => {
    const names = new Set(functionsOf(settlementVaultAbi).map((fn) => fn.name));
    for (const gone of ['deposit', 'setPolicy', 'setPolicyDigest', 'policyNonce', 'SETTLE_POLICY_TAG', 'identity']) {
      expect(names.has(gone), `${gone} 는 v2 에서 삭제됐다`).toBe(false);
    }
    expect(names.has('setPolicyByTicket')).toBe(true);
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

  it('Ticket ABI has mintPaid and the NotPaidTier error the purchase path maps', () => {
    expect(functionsOf(ticketAbi).some((fn) => fn.name === 'mintPaid')).toBe(true);
    expect(errorNamesOf(ticketAbi).has('NotPaidTier')).toBe(true);
  });
});

describe('purchaseSimAbi', () => {
  it('decodes Ticket claim errors bubbled through mintPaid, vault errors and solady TransferFromFailed', () => {
    for (const errorName of ['SoldOut', 'NotPaidTier', 'KycRequired', 'Paused', 'NotDepositor', 'TransferFromFailed']) {
      const data = encodeErrorResult({ abi: purchaseSimAbi, errorName } as never);
      expect(decodeErrorResult({ abi: purchaseSimAbi, data }).errorName).toBe(errorName);
    }
  });

  it('TransferFromFailed has the solady selector 0x7939f424', () => {
    expect(encodeErrorResult({ abi: purchaseSimAbi, errorName: 'TransferFromFailed' } as never)).toBe('0x7939f424');
  });
});

describe('UNITS_PER_CENT', () => {
  it('mirrors the vault constant (6-decimal USDC: 1 cent = 1e4 units)', () => {
    expect(UNITS_PER_CENT).toBe(10_000n);
    expect(3000n * UNITS_PER_CENT).toBe(30_000_000n); // $30.00 = 30 USDC
  });
});

describe('hashPolicy (publish-hook mirror parity)', () => {
  const RECIPIENTS_TUPLE = {
    type: 'tuple[]',
    components: [
      { name: 'account', type: 'address' },
      { name: 'bps', type: 'uint16' },
      { name: 'reasonHash', type: 'bytes32' },
      { name: 'tag', type: 'bytes32' },
    ],
  } as const;

  it('equals keccak256(abi.encode(recipients, platformBps, reserveBps, noShowRefund))', () => {
    const recipients = [
      { account: getAddress(`0x${'a1'.repeat(20)}`), bps: 8000, reasonHash: reasonHashOf('출연료'), tag: tagToBytes32('artist') },
      { account: getAddress(`0x${'a5'.repeat(20)}`), bps: 2000, reasonHash: reasonHashOf('플랫폼 수수료'), tag: tagToBytes32('platform') },
    ];
    const expected: Hex = keccak256(
      encodeAbiParameters(
        [RECIPIENTS_TUPLE, { type: 'uint16' }, { type: 'uint16' }, { type: 'bool' }],
        [recipients, 2000, 0, false],
      ),
    );
    expect(hashPolicy({ recipients, platformBps: 2000, reserveBps: 0, noShowRefund: false })).toBe(expected);
  });
});
