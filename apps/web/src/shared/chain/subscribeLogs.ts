import { createPublicClient, webSocket, type Log, type PublicClient } from 'viem';
import type { Hex } from '@monti/shared';
import { getConfig } from '../config';
import { monadChain } from './chain';
import { getPublicClient } from './client';

/**
 * Named LogStage, not ChainStage: src/staff/types.ts exports a three-member `ChainStage`
 * ('speculative' | 'finalized' | 'offline') for the gate header, and two same-named
 * exported unions in one codebase widen silently when the wrong one is imported.
 */
export type LogStage = 'speculative' | 'finalized';
export type ChainLog = Log & { stage: LogStage };

let wsClient: PublicClient | null = null;

export function getWebSocketClient(): PublicClient {
  if (wsClient) return wsClient;
  const config = getConfig();
  wsClient = createPublicClient({
    chain: monadChain(config.chainId, config.rpcUrls, config.wsUrl),
    transport: webSocket(config.wsUrl, {
      reconnect: { attempts: 10, delay: 1_000 },
      keepAlive: { interval: 20_000 },
    }),
  });
  return wsClient;
}

export function resetWebSocketClient(): void {
  wsClient = null;
}

const STAGE_BY_COMMIT_STATE: Record<string, LogStage> = {
  Proposed: 'speculative',
  Voted: 'speculative',
  Finalized: 'finalized',
  // Verified is Monad's deepest commit state (after Finalized) — also finalized.
  Verified: 'finalized',
};

export interface SubscribeLogsArgs {
  address: Hex;
  topics: (Hex | Hex[] | null)[];
  onLog: (log: ChainLog) => void;
}

/**
 * Monad's `monadLogs` reports the same log at each commit stage. The gate screen turns
 * green on `speculative` (~0.7 s) and hardens on `finalized` (~1.3 s), spec 7.2 step 8.
 */
export function subscribeLogs({ address, topics, onLog }: SubscribeLogsArgs): () => void {
  let stopped = false;
  let unsubscribe: (() => void) | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const seen = new Set<string>();

  const emit = (raw: Record<string, unknown>, stage: LogStage) => {
    const key = `${stage}:${String(raw.transactionHash)}:${String(raw.logIndex)}`;
    if (seen.has(key)) return;
    seen.add(key);
    onLog({ ...(raw as unknown as Log), stage });
  };

  const pollOnce = async (stage: LogStage) => {
    const blockTag = stage === 'speculative' ? 'latest' : 'finalized';
    const logs = await getPublicClient()
      .request({
        method: 'eth_getLogs',
        params: [{ address, topics, fromBlock: blockTag, toBlock: blockTag }],
      } as never)
      .catch(() => [] as unknown[]);
    for (const log of logs as Array<Record<string, unknown>>) emit(log, stage);
  };

  const startPolling = () => {
    if (timer || stopped) return;
    timer = setInterval(() => {
      void pollOnce('speculative');
      void pollOnce('finalized');
    }, 400);
  };

  void (async () => {
    try {
      const transport = getWebSocketClient().transport as unknown as {
        subscribe: (args: {
          params: unknown[];
          onData: (message: { result?: Record<string, unknown> }) => void;
          onError: (error: unknown) => void;
        }) => Promise<{ unsubscribe: () => Promise<void> }>;
      };
      const subscription = await transport.subscribe({
        params: ['monadLogs', { address, topics }],
        onData: (message) => {
          const result = message.result;
          if (!result) return;
          emit(
            result,
            STAGE_BY_COMMIT_STATE[String(result.commitState ?? 'Proposed')] ?? 'speculative',
          );
        },
        onError: () => startPolling(),
      });
      if (stopped) {
        void subscription.unsubscribe();
        return;
      }
      unsubscribe = () => void subscription.unsubscribe();
    } catch {
      startPolling();
    }
  })();

  return () => {
    stopped = true;
    unsubscribe?.();
    if (timer) clearInterval(timer);
  };
}
