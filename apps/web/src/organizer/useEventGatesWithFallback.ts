import { useQuery } from '@tanstack/react-query';
import { readOrganizers } from '../shared/chain/reads';
import type { EnvioGate } from '../shared/envio/queries';

/**
 * The organiser's gate screen fills its 등록된 단말기 목록 — the one whose 열기 button opens a gate
 * for staff — from the indexer's `GATES_QUERY`. A gate exists the moment `registerGate` confirms,
 * but the hosted indexer can lag it (or freeze), so a freshly registered gate never gets a `Gate`
 * row, the 열기 button never renders, and staff admission is blocked — exactly the gap
 * `useEventTiersWithFallback` / `useEventStatusWithFallback` close for tiers and status.
 *
 * There is no contract view that enumerates an event's gates, and `eth_getLogs` is not an option:
 * the RPCs the web uses cap the block range hard (Alchemy 1000, the public node 100), so a scan
 * from the deploy block is rejected outright. But the ids are **dense**: `Organizers._nextGateId`
 * starts at 1 and only ever increments (`gateId = _nextGateId++`), and a gate record is never
 * deleted — even `revokeGate` keeps it — so ids run 1..N with no holes. So the fallback *probes*:
 * it reads `gateInfo(1), gateInfo(2), …` in parallel batches and stops at the first id whose
 * account is zero (an unregistered id answers with the zero struct), filters the hits to this
 * event, and shapes them into the same `EnvioGate` rows the list consumes — so 열기 works unchanged.
 *
 * The indexer stays the preferred source whenever it has rows; this probe runs only once the
 * indexer query has settled with *no* rows (`undefined` is still-loading — waited on, not raced).
 */

export type EventGatesSource = 'indexer' | 'direct' | 'none';

export interface EventGatesFallback {
  /** The gates to render, from the indexer when it has rows and from the chain while it lags. */
  gates: EnvioGate[];
  source: EventGatesSource;
}

/** 한 번에 던지는 `gateInfo` 수. 한 창에 담기는 단말기 수를 크게 웃도는 상한(300)까지만 올라간다. */
const PROBE_BATCH = 10;
const PROBE_CAP = 300;
const ZERO_ACCOUNT = '0x0000000000000000000000000000000000000000';

export function useEventGatesWithFallback(
  eventId: string,
  indexerGates: EnvioGate[] | undefined,
): EventGatesFallback {
  // 정착한 뒤 빈 답만 체인 조회 대상이다: `undefined` 는 아직 로딩(기다린다), 행이 있으면 인덱서가
  // 이미 따라잡은 것이다.
  const indexerEmpty = indexerGates !== undefined && indexerGates.length === 0;

  const chain = useQuery({
    queryKey: ['eventGates', 'probe', eventId],
    queryFn: async (): Promise<EnvioGate[]> => {
      const organizers = readOrganizers();
      const wanted = BigInt(eventId);
      const gates: EnvioGate[] = [];

      for (let start = 1; start <= PROBE_CAP; start += PROBE_BATCH) {
        const ids: bigint[] = [];
        for (let i = 0; i < PROBE_BATCH && start + i <= PROBE_CAP; i += 1) ids.push(BigInt(start + i));
        // id 를 답과 함께 묶어 둔다 — 순서대로 돌려받지만 인덱스로 둘을 다시 맞추지 않아도 되게.
        const probed = await Promise.all(
          ids.map(async (id) => ({ id, info: await organizers.gateInfo(id) })),
        );

        let reachedEnd = false;
        for (const { id, info } of probed) {
          // 첫 빈 id 가 밀집 구간의 끝이다 — 그 뒤 id 는 모두 0 계정이라 더 읽을 게 없다.
          if (info.account.toLowerCase() === ZERO_ACCOUNT) {
            reachedEnd = true;
            break;
          }
          if (info.eventId !== wanted) continue;
          gates.push({
            id: id.toString(),
            eventId: info.eventId.toString(),
            account: info.account,
            kx: info.kx,
            ky: info.ky,
            // 인덱서 열(`isOpen`)과 같은 이름으로 — 목록 컴포넌트가 그대로 읽는다. 폐기된 것도
            // 인덱서처럼 담는다(기록이 남아 gateInfo 가 계속 답한다).
            isOpen: info.open,
            revoked: info.revoked,
          });
        }
        if (reachedEnd) break;
      }

      // id 오름차순으로 쌓였으니 `GATES_QUERY` 의 정렬과 같다.
      return gates;
    },
    enabled: eventId !== '' && indexerEmpty,
  });

  if (indexerGates !== undefined && indexerGates.length > 0) {
    return { gates: indexerGates, source: 'indexer' };
  }
  // 비지 않은 체인 답은 인덱서가 아직 못 따라온 진짜 게이트다. 빈 답(또는 실패해 data 가 undefined)이면
  // 보여 줄 게 없다.
  if (chain.data != null && chain.data.length > 0) {
    return { gates: chain.data, source: 'direct' };
  }
  return { gates: [], source: 'none' };
}
