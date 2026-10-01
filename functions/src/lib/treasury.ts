import type { Hex } from '@monti/shared';
import type { TransactionReceipt } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { TREASURY_PK } from '../config.js';
import { publicClient, sendRelayerTx } from './chain.js';
import { relayGasLimitFor, relayerFees } from './relayer.js';
import { withLease } from './txLease.js';

/**
 * 트레저리 EOA — USDC 를 들고 금고에 예치/환불하는 지불처(설계 §2). 릴레이어(`relayer.ts`)와
 * **분리된 EOA·분리된 리스 문서**(`system/treasury`)라 nonce 레인·침해 반경이 겹치지 않는다
 * (설계 §5/§8). 전송 로직 자체는 릴레이어와 같아 수수료·+3% 마진 계산을 그대로 재사용한다.
 */

const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;
const TREASURY_LEASE_DOC = 'treasury';
const RECEIPT_TIMEOUT_MS = 30_000;
/** 재전송해도 안전한 유일한 거절(우리 tx 가 밀렸다는 뜻이라 다시 보내도 쓰기는 한 번). */
const NONCE_TOO_LOW = /nonce (is )?too low/i;
const NONCE_RETRY_DELAY_MS = 300;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let cached: { key: string; account: PrivateKeyAccount } | undefined;

/**
 * 트레저리 계정. Secret Manager `TREASURY_PK` 하나만 **호출 시점에** 읽는다(모듈 로드 시 읽으면
 * 배포 analyze 단계에서 터진다 — `getRelayerAccount` 와 같은 규약).
 */
export function getTreasuryAccount(privateKey?: string): PrivateKeyAccount {
  const pk = privateKey ?? TREASURY_PK.value();
  if (!PRIVATE_KEY_RE.test(pk)) throw new Error('MISSING_TREASURY_PK');
  if (cached?.key !== pk) cached = { key: pk, account: privateKeyToAccount(pk as Hex) };
  return cached.account;
}

export interface TreasuryRequest {
  to: Hex;
  data: Hex;
  /** eth_estimateGas 원값(리스 밖에서 추정). +3% 마진은 `relayGasLimitFor` 가 얹는다. */
  gasLimit: bigint;
}

export interface SentTreasury {
  hash: Hex;
  nonce: number;
  gasLimit: bigint;
  sentAt: number;
}

/**
 * 트레저리 EOA 로 raw `to`/`data` 트랜잭션 1건을 보낸다(설계 §2 예치/환불). 리스 밖에서 느린
 * 준비(base fee 읽기, +3% 마진)를 끝내고, 리스 안에서는 pending nonce 읽기+서명+브로드캐스트만
 * 한다 — `sendRelayed` 와 같은 모양이되 **자기 리스 문서**(`treasury`)를 쓴다.
 */
export async function sendFromTreasury(req: TreasuryRequest): Promise<SentTreasury> {
  const account = getTreasuryAccount();
  const pc = publicClient();
  const gas = relayGasLimitFor(req.gasLimit);

  const block = await pc.getBlock({ blockTag: 'latest' });
  const { maxFeePerGas, maxPriorityFeePerGas } = relayerFees(block.baseFeePerGas ?? 0n);

  return withLease(TREASURY_LEASE_DOC, async () => {
    const broadcast = async (): Promise<SentTreasury> => {
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
      if (!NONCE_TOO_LOW.test((error as Error)?.message ?? '')) throw error;
      await sleep(NONCE_RETRY_DELAY_MS);
      return broadcast();
    }
  });
}

/** 트레저리 트랜잭션의 영수증을 기다린다(릴레이어와 같은 상한 30s). */
export async function waitTreasury(hash: Hex): Promise<TransactionReceipt> {
  return publicClient().waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
}
