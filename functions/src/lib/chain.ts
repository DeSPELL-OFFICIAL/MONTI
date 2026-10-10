import { createPublicClient, createWalletClient, defineChain, http, type Abi, type Hex } from 'viem';
import { loadDeployment, withGasMargin, MONAD_MAINNET_CHAIN_ID, type Deployment } from '@monti/shared';
import { getAttesterAccount } from './attester.js';
import { CHAIN_ID, RPC_URL } from '../config.js';
import type { PrivateKeyAccount } from 'viem/accounts';

/** 체인 id 는 로직에 박지 않는다. CHAIN_ID / RPC_URL 두 파라미터로 메인넷으로 넘어간다. */
export function monadChain() {
  const id = Number(CHAIN_ID.value());
  return defineChain({
    id,
    name: id === MONAD_MAINNET_CHAIN_ID ? 'Monad' : 'Monad Testnet',
    nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
    rpcUrls: { default: { http: [RPC_URL.value()] } },
  });
}

export function deployment(): Deployment {
  return loadDeployment(Number(CHAIN_ID.value()));
}

/**
 * 영수증 대기(`waitForTransactionReceipt`)의 폴링 간격. 체인 정의에 blockTime 이 없으면 viem 은
 * 12 s 블록을 가정해 4 s 로 폴링한다 — Monad 블록(≈0.4–1 s)에 tx 가 들어가도 확인이 ~3 s 늦는다.
 * 1 s 로 둔다(500 ms 는 RPC 부하 대비 이득이 작다).
 */
const POLLING_INTERVAL_MS = 1_000;

export function publicClient() {
  return createPublicClient({
    chain: monadChain(),
    transport: http(RPC_URL.value()),
    pollingInterval: POLLING_INTERVAL_MS,
  });
}

export function walletClient() {
  return createWalletClient({
    account: getAttesterAccount(),
    chain: monadChain(),
    transport: http(RPC_URL.value()),
    pollingInterval: POLLING_INTERVAL_MS,
  });
}

/** Monad 는 gas_limit 기준 과금이라 모든 쓰기가 이 함수를 통과해야 한다. 마진은 shared 한 곳에만 있다. */
export function gasLimitFor(estimate: bigint): bigint {
  const limit = withGasMargin(estimate);
  return limit < estimate ? estimate : limit;
}

export interface AttesterTx {
  address: Hex;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
}

/**
 * 어테스터 EOA 로 컨트랙트 함수를 호출한다. 가스 한도를 반드시 명시한다.
 * 해시만 돌려주고 finality 는 기다리지 않는다 — 필요한 호출자가 `awaitFinalized` 를 따로 부른다.
 */
export async function sendAttesterTx(tx: AttesterTx): Promise<Hex> {
  const account = getAttesterAccount();
  const pc = publicClient();
  const estimate = await pc.estimateContractGas({
    address: tx.address,
    abi: tx.abi,
    functionName: tx.functionName,
    args: tx.args,
    account,
  });
  return walletClient().writeContract({
    address: tx.address,
    abi: tx.abi,
    functionName: tx.functionName,
    args: tx.args,
    account,
    chain: monadChain(),
    gas: gasLimitFor(estimate),
  });
}

/** 스펙 §10.4 규칙 3: 체인과 DB 를 함께 건드리는 작업은 finalized 뒤에 완료 처리한다(Monad 는 약 800 ms). */
export async function awaitFinalized(blockNumber: bigint, timeoutMs = 20_000): Promise<void> {
  const pc = publicClient();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const finalized = await pc.getBlock({ blockTag: 'finalized' });
    if (finalized.number !== null && finalized.number >= blockNumber) return;
    if (Date.now() > deadline) throw new Error('FINALITY_TIMEOUT');
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

export interface RelayerTx {
  account: PrivateKeyAccount;
  to: Hex;
  data: Hex;
  gas: bigint;
  nonce: number;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

/**
 * 릴레이어 EOA 로 서명된 승인서를 담은 **일반 트랜잭션**을 보낸다. 어테스터 전송과 달리
 * 컨트랙트 함수가 아니라 raw `to/data` 를 받는다 — C2 의 콜러블이 claimFor/checkInFor 를
 * 인코딩해 넘기고, 릴레이어는 서명된 필드를 못 바꾼다(설계 §5 "릴레이어가 할 수 없는 것").
 *
 * 가스 한도·수수료·nonce 를 **모두 호출자가 명시한다**(설계 §5). 리스 밖에서 estimate·시뮬로
 * 정한 값을 리스 안에서 이 함수로 브로드캐스트만 한다. 해시만 돌려주고 finality 는 기다리지
 * 않는다 — `waitRelayed` 가 따로 본다. Monad 는 gas_limit 기준 과금이라 `gas` 는 반드시 명시한다.
 */
export async function sendRelayerTx(tx: RelayerTx): Promise<Hex> {
  const client = createWalletClient({
    account: tx.account,
    chain: monadChain(),
    transport: http(RPC_URL.value()),
  });
  return client.sendTransaction({
    account: tx.account,
    to: tx.to,
    data: tx.data,
    gas: tx.gas,
    nonce: tx.nonce,
    maxFeePerGas: tx.maxFeePerGas,
    maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
    chain: monadChain(),
  });
}
