import { encodeAbiParameters, keccak256, stringToHex, toHex, type Hex } from 'viem';
import { settlementVaultAbi } from '@monti/shared';

/**
 * SettlementVault 의 ABI — 01b 가 컴파일 산출물에서 뽑아 `packages/shared/src/abi/SettlementVault.json`
 * 으로 내보낸 **생성 ABI** 다(B2 에서 손으로 적던 parseAbi 자리표시자를 교체). 함수·이벤트·에러
 * 시그니처는 `functions/test/settlementAbi.test.ts` 가 참조 목록과 selector 로 드리프트를 막는다.
 */
export const settlementAbi = settlementVaultAbi;

/** 금고가 쓰는 escrow status 코드(ISettlementVault.Escrow.status). */
export const ESCROW_STATUS = { none: 0, held: 1, released: 2, refunded: 3 } as const;

/** 온체인에 올라가는 수취인 한 줄(해시·태그는 이미 bytes32 로 변환된 값). */
export interface OnChainRecipient {
  account: Hex;
  bps: number;
  reasonHash: Hex;
  tag: Hex;
}
/** `hashPolicy` 가 서명 대상으로 삼는 네 칸(frozen/version 은 수명 상태라 서명하지 않는다). */
export interface SignedPolicy {
  recipients: OnChainRecipient[];
  platformBps: number;
  reserveBps: number;
  noShowRefund: boolean;
}

const RECIPIENTS_TUPLE = {
  type: 'tuple[]',
  components: [
    { name: 'account', type: 'address' },
    { name: 'bps', type: 'uint16' },
    { name: 'reasonHash', type: 'bytes32' },
    { name: 'tag', type: 'bytes32' },
  ],
} as const;

/**
 * `SettlementVault.hashPolicy` 와 **바이트 단위로 같은** 해시를 오프체인에서 계산한다:
 * `keccak256(abi.encode(recipients, platformBps, reserveBps, noShowRefund))`. 서버는 금고의
 * `hashPolicy` view 로도 교차검증하지만, view 가 없거나(배포 전) 테스트에서도 이 함수로 해시 패리티를
 * 증명한다. `abi.encode(a,b,c,d)` 는 같은 순서의 파라미터 묶음에 대한 `encodeAbiParameters` 와 동치다.
 */
export function hashPolicy(policy: SignedPolicy): Hex {
  return keccak256(
    encodeAbiParameters(
      [RECIPIENTS_TUPLE, { type: 'uint16' }, { type: 'uint16' }, { type: 'bool' }],
      [policy.recipients, policy.platformBps, policy.reserveBps, policy.noShowRefund],
    ),
  );
}

/** 짧은 분류 태그(예: "platform")를 Solidity `bytes32` 리터럴과 같게 우측 0 패딩한다. */
export function tagToBytes32(tag: string): Hex {
  return stringToHex(tag, { size: 32 });
}

/** 사유 원문의 keccak256(utf8). 온체인에는 이 해시만, 원문은 settlements 거울에 둔다(설계 §1). */
export function reasonHashOf(reason: string): Hex {
  return keccak256(toHex(reason));
}
