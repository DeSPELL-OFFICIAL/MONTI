import type { Hex } from '@monti/shared';
import type { TransactionReceipt } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { RELAYER_PK } from '../config.js';
import { publicClient, sendRelayerTx } from './chain.js';
import { withLease } from './txLease.js';

const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;
/**
 * 릴레이 한도 마진 = +3 %. Monad 는 한도로 과금하므로 어테스터 경로의 +7.5 %(shared `withGasMargin`)
 * 보다 좁게 잡는다. 근거는 실측(F2, 2026-09-29): 같은 상태에서 견적한 직후 보내므로 cold/warm 차이가
 * 끼어들 틈이 없고, estimate×1.03 으로 claimFor/checkInFor 7/7 성공. 100명 행사 기준 7.5 % → 3 % 는
 * 약 0.2 MON 차이다.
 */
const RELAY_GAS_MARGIN_BPS = 10_300n;
const BPS = 10_000n;

/** 릴레이 전송의 최종 가스 한도. 견적보다 작아지지 않는다. */
export function relayGasLimitFor(estimate: bigint): bigint {
  if (estimate < 0n) throw new Error('NEGATIVE_GAS_ESTIMATE');
  const limit = (estimate * RELAY_GAS_MARGIN_BPS) / BPS;
  return limit < estimate ? estimate : limit;
}
/** 영수증을 기다리는 상한. registerIdentity 와 동일하게 맞춘다. */
const RECEIPT_TIMEOUT_MS = 30_000;
/**
 * pending nonce 를 다시 읽어 재서명해도 안전한 거절. 둘 다 **우리 tx 가 풀에 들어가지 못했다**는
 * 뜻이라 다시 보내도 쓰기는 한 번이다:
 *  - `nonce too low`  — 그 nonce 가 이미 채굴됐다(직전 전송이 앞섰다).
 *  - `underpriced`    — 같은 nonce 의 다른 tx 가 이미 풀에 있다(`replacement transaction underpriced`,
 *                       동시 탭에서 pending 읽기가 한 박자 늦은 경우).
 * `already known` 은 일부러 뺀다 — 바로 그 서명된 tx 가 이미 풀에 있다는 뜻이라, 새 nonce 로
 * 재서명하면 같은 calldata 가 두 번 나간다(트레저리 예치/환불이면 이중 지급).
 */
const RETRYABLE_SEND_ERROR = /nonce (is )?too low|underpriced/i;
const NONCE_RETRY_DELAY_MS = 300;

/** 이 전송 실패가 pending nonce 재조회 + 재서명 1회로 다시 보내도 되는 거절인가. */
export function isRetryableSendError(error: unknown): boolean {
  const message = (error as { message?: unknown } | null | undefined)?.message;
  return typeof message === 'string' && RETRYABLE_SEND_ERROR.test(message);
}
/**
 * 릴레이어 리스 문서(`system/relayer`). 어테스터와 **분리된 EOA** 라 nonce 레인이 겹치지 않게
 * 리스 문서도 따로 둔다(설계 §5). 리스 구현 자체는 공용 `txLease.ts` 의 `withLease` 하나뿐이라
 * 릴레이어 전용 래퍼 모듈은 두지 않는다 — 문서 이름만 여기서 정한다.
 */
const RELAYER_LEASE_DOC = 'relayer';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ─────────────────────────────────────── 수수료 정책 (설계 §5, 순수 함수)

/** 팁은 2 gwei 고정. Monad 실제 과금은 base 이고 팁은 cap 에 얹는 값일 뿐이다. */
export const RELAYER_MAX_PRIORITY_FEE_WEI = 2_000_000_000n; // 2 gwei
/**
 * maxFee 상한. Monad base fee 는 100 gwei 고정이라 평소 2×base+tip = 202 gwei 로 앉지만,
 * RPC 가 튄 base 값을 돌려줘도 릴레이어 잔액이 한 번에 타지 않게 상한을 둔다. Monad 고정 base
 * 에서는 상한이 base+tip 아래로 내려가 트랜잭션을 무효로 만드는 일이 없다.
 */
export const RELAYER_MAX_FEE_CAP_WEI = 500_000_000_000n; // 500 gwei

export interface RelayerFees {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

/**
 * maxFeePerGas = 2×baseFee + tip (설계 §5). base 를 두 배로 덮어 고정 base 에 여유를 주고,
 * 팁을 더해 팁이 언제나 지급 가능하게 한다. 상한을 넘으면 상한으로 자른다.
 */
export function relayerFees(baseFeeWei: bigint): RelayerFees {
  const maxPriorityFeePerGas = RELAYER_MAX_PRIORITY_FEE_WEI;
  const uncapped = baseFeeWei * 2n + maxPriorityFeePerGas;
  const maxFeePerGas = uncapped > RELAYER_MAX_FEE_CAP_WEI ? RELAYER_MAX_FEE_CAP_WEI : uncapped;
  return { maxFeePerGas, maxPriorityFeePerGas };
}

// ─────────────────────────────────────── 릴레이어 계정 / 전송

let cached: { key: string; account: PrivateKeyAccount } | undefined;

/**
 * 릴레이어 계정. Secret Manager `RELAYER_PK` 하나만 읽는다. 어테스터와 **분리된 EOA** 다(설계 §5).
 * 시크릿은 **호출 시점에만** 읽는다 — 모듈 로드 시점에 읽으면 배포(analyze) 단계에서 터진다.
 */
export function getRelayerAccount(privateKey?: string): PrivateKeyAccount {
  const pk = privateKey ?? RELAYER_PK.value();
  if (!PRIVATE_KEY_RE.test(pk)) throw new Error('MISSING_RELAYER_PK');
  if (cached?.key !== pk) cached = { key: pk, account: privateKeyToAccount(pk as Hex) };
  return cached.account;
}

export interface RelayedRequest {
  to: Hex;
  data: Hex;
  /** eth_estimateGas 원값(리스 밖에서 추정). +3% 릴레이 마진은 여기서 relayGasLimitFor 로 얹는다. */
  gasLimit: bigint;
}

export interface SentRelayed {
  /** 브로드캐스트한 트랜잭션 해시. C2 의 relays 문서 `txHash`. */
  hash: Hex;
  /** 이 전송에 배정한 nonce. relays 문서 `nonce`. */
  nonce: number;
  /** 실제로 보낸, +3% 마진을 얹은 최종 가스 한도. */
  gasLimit: bigint;
  /** 브로드캐스트 시각(ms). */
  sentAt: number;
}

/**
 * 서명된 승인서(raw `to`/`data`)를 릴레이어 EOA 로 **일반 트랜잭션 1건**으로 보낸다(설계 §5).
 *
 * 리스 밖에서 느린 준비(수수료용 base fee 읽기, +3% 마진)를 끝내고, 리스 안에서는
 * **pending nonce 명시 읽기 + 서명 + 브로드캐스트**만 한다 — 임계구역이 짧을수록 버스트
 * (~50건/10초)를 큐잉으로 흡수한다. 브로드캐스트가 끝나면 finality 를 기다리지 않고 반납한다.
 *
 * `nonce too low`·`underpriced` 는 우리 nonce 가 밀린 경우라 pending nonce 를 다시 읽어
 * **1회만** 재시도한다(`isRetryableSendError`, 기존 `sendSerialized` 규약).
 *
 * gasLimit 은 raw estimate 를 받아 `relayGasLimitFor`(+3%)로 얹는다 — Monad 는 한도로 과금하므로
 * 한도를 이보다 더 부풀리지 않는다. `to`/`data` 는 C2 가 claimFor/checkInFor 로 인코딩해 넘긴다.
 */
export async function sendRelayed(req: RelayedRequest): Promise<SentRelayed> {
  const account = getRelayerAccount();
  const pc = publicClient();
  const gas = relayGasLimitFor(req.gasLimit);

  // 리스 밖: 느린 RPC 를 임계구역에서 뺀다(설계 §5).
  const block = await pc.getBlock({ blockTag: 'latest' });
  const { maxFeePerGas, maxPriorityFeePerGas } = relayerFees(block.baseFeePerGas ?? 0n);

  return withLease(RELAYER_LEASE_DOC, async () => {
    const broadcast = async (): Promise<SentRelayed> => {
      // in-flight 를 포함한 pending nonce 를 명시적으로 읽어 연속 증가를 보장한다(설계 §5).
      const nonce = await pc.getTransactionCount({ address: account.address, blockTag: 'pending' });
      const hash = await sendRelayerTx({
        account,
        to: req.to,
        data: req.data,
        gas,
        nonce,
        maxFeePerGas,
        maxPriorityFeePerGas,
      });
      return { hash, nonce, gasLimit: gas, sentAt: Date.now() };
    };
    try {
      return await broadcast();
    } catch (error) {
      if (!isRetryableSendError(error)) throw error;
      await sleep(NONCE_RETRY_DELAY_MS);
      return broadcast();
    }
  });
}

/** 브로드캐스트한 트랜잭션의 영수증을 기다린다. registerIdentity 와 같은 상한(30s). */
export async function waitRelayed(hash: Hex): Promise<TransactionReceipt> {
  return publicClient().waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
}
