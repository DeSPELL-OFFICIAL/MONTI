import { encodeAbiParameters, keccak256, parseAbiParameters, stringToHex, toHex, type Address } from 'viem';
import type { Hex } from './types.js';

/**
 * 오거나이저 화면이 입력하는 수취인 한 줄. `reason`/`tag` 는 사람이 읽는 문자열이고,
 * 체인에 올라가는 것은 각각 {@link reasonHash}/{@link tagToBytes32} 로 변환한 32바이트다.
 */
export interface PolicyRecipientInput {
  account: Address;
  /** basis points. 10_000 = 100%. 모든 수취인 bps 합은 반드시 10_000 이어야 한다. */
  bps: number;
  /** 정산 사유(예: "출연료"). keccak256 해서 체인에 올린다 — 원문은 올라가지 않는다. */
  reason: string;
  /** 짧은 분류 태그(예: "artist"/"venue"/"platform"). 32바이트로 우측 0 패딩해 올린다. */
  tag: string;
}

/**
 * 한 이벤트의 분할 정책 입력. `SettlementVault.hashPolicy` 가 서명하는 네 값과 1:1 이다.
 * `reserveBps`/`noShowRefund` 는 생략하면 각각 0/false 로 둔다 — 컨트랙트의 기본값과 같다.
 */
export interface PolicyInput {
  recipients: PolicyRecipientInput[];
  /** "platform" 태그 수취인의 bps 와 반드시 같아야 하고, 최소 500(5%) 이다(컨트랙트 검증). */
  platformBps: number;
  reserveBps?: number;
  noShowRefund?: boolean;
}

/**
 * 체인에 올라가는 수취인 형태. `SettlementVault.Recipient` 구조체와 필드·순서가 같다:
 * `{ address account; uint16 bps; bytes32 reasonHash; bytes32 tag; }`.
 */
export interface OnChainRecipient {
  account: Address;
  bps: number;
  reasonHash: Hex;
  tag: Hex;
}

/** 정산 사유를 체인에 올리는 형태. `keccak256(utf8Bytes(reason))`. */
export function reasonHash(reason: string): Hex {
  return keccak256(toHex(reason));
}

/**
 * 분류 태그를 체인에 올리는 형태. `stringToHex(tag, { size: 32 })` — ascii 를 32바이트로 우측
 * 0 패딩한다. solidity 의 `bytes32("artist")` 와 같은 바이트열이다. 태그가 32바이트를 넘으면
 * viem 이 던진다.
 */
export function tagToBytes32(tag: string): Hex {
  return stringToHex(tag, { size: 32 });
}

/** 입력 수취인들을 체인 형태로 변환한다. `reason`→`reasonHash`, `tag`→`tagToBytes32`. */
export function toOnChainRecipients(recipients: readonly PolicyRecipientInput[]): OnChainRecipient[] {
  return recipients.map((r) => ({
    account: r.account,
    bps: r.bps,
    reasonHash: reasonHash(r.reason),
    tag: tagToBytes32(r.tag),
  }));
}

/**
 * `SettlementVault.hashPolicy` 가 해싱하는 바로 그 바이트열(abi.encode). 순서는 컨트랙트와
 * 같다: `(Recipient[] recipients, uint16 platformBps, uint16 reserveBps, bool noShowRefund)`.
 * `frozen`/`version` 은 수명주기 상태라 서명 대상이 아니며 여기에도 없다.
 *
 * 따로 내보내는 이유는 {@link gateCodePreimage} 와 같다 — 해시와 원문이 한 함수에서 나와야
 * 서로 어긋나지 않는다.
 */
export function encodePolicyStruct(policy: PolicyInput): Hex {
  return encodeAbiParameters(
    parseAbiParameters(
      '(address account, uint16 bps, bytes32 reasonHash, bytes32 tag)[] recipients, uint16 platformBps, uint16 reserveBps, bool noShowRefund',
    ),
    [
      toOnChainRecipients(policy.recipients),
      policy.platformBps,
      policy.reserveBps ?? 0,
      policy.noShowRefund ?? false,
    ],
  );
}

/** `SettlementVault.hashPolicy(policy)` 와 같은 값. keccak256 of {@link encodePolicyStruct}. */
export function hashPolicy(policy: PolicyInput): Hex {
  return keccak256(encodePolicyStruct(policy));
}
