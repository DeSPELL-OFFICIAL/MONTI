import { createPublicClient, createWalletClient, defineChain, http, type Abi, type Hex } from 'viem';
import { loadDeployment, withGasMargin, MONAD_MAINNET_CHAIN_ID, type Deployment } from '@monti/shared';
import { getAttesterAccount } from './attester.js';
import { CHAIN_ID, RPC_URL } from '../config.js';

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

export function publicClient() {
  return createPublicClient({ chain: monadChain(), transport: http(RPC_URL.value()) });
}

export function walletClient() {
  return createWalletClient({
    account: getAttesterAccount(),
    chain: monadChain(),
    transport: http(RPC_URL.value()),
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
