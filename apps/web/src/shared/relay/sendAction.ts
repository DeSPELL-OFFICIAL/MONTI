import type { Hex } from '@monti/shared';
import { api, CallableError, type RelayActionResponse, type RelayActionResult } from '../api/functions';
import { watchRelay } from '../api/firestore';
import { buildForwardRequest, type RelayTarget } from './buildForwardRequest';

/**
 * The current on-chain forwarder nonce a `BAD_NONCE` refusal carries, or `undefined` for any other
 * failure. Read structurally off `CallableError.details` (the frozen `{ code, nonce }` contract),
 * exactly as `relayClaimError` reads the claim path's.
 */
function badNonce(cause: unknown): bigint | undefined {
  const details = (cause as { details?: unknown } | null)?.details;
  if (typeof details !== 'object' || details === null) return undefined;
  const { code, nonce } = details as { code?: unknown; nonce?: unknown };
  if (code !== 'BAD_NONCE') return undefined;
  if (typeof nonce === 'string' && /^\d+$/.test(nonce)) return BigInt(nonce);
  if (typeof nonce === 'number' && Number.isInteger(nonce)) return BigInt(nonce);
  return undefined;
}

/**
 * Follows a `sent` relay's `relays/{relayId}` document until it settles: `confirmed` resolves with
 * the action's result (written to the doc when the tx mined), `failed` rejects with a
 * `CallableError` carrying the doc's `error.code` so the caller maps it like any other refusal. A
 * dropped listener rejects too — the caller's own retry is the way out. `pending`/`sent` keep
 * waiting. `null` (the doc is not there yet) is not a verdict, so it is ignored.
 *
 * Exported so a caller that persisted a `relayId` (the createEvent draft, whose page can close and
 * reopen mid-flight) can resume watching the same submission without re-sending it — a second
 * `createEvent` would be a second event.
 */
export function followRelay(relayId: string): Promise<RelayActionResult | undefined> {
  return new Promise((resolve, reject) => {
    const sub: { stop?: () => void } = {};
    sub.stop = watchRelay(
      relayId,
      (relay) => {
        if (relay === null) return;
        if (relay.status === 'confirmed') {
          sub.stop?.();
          resolve(relay.result);
        } else if (relay.status === 'failed') {
          sub.stop?.();
          reject(new CallableError('failed-precondition', relay.error?.code ?? 'TX_REVERT', relay.error));
        }
      },
      (error) => {
        sub.stop?.();
        reject(error);
      },
    );
  });
}

/**
 * The one path every relayed organizer/transfer/override write takes (design §1, Phase 2). It
 * builds and signs a `ForwardRequest` for `kind`/`to`/`data`, hands it to the `relayAction`
 * callable, and — when the relayer answers `sent` rather than `confirmed` — follows the relay
 * document to a settled answer. A `BAD_NONCE` refusal (the forwarder nonce moved under a concurrent
 * action) is rebuilt against the fresh nonce the server reported and retried exactly once; a second
 * one is a real conflict and surfaces. Returns the action's result, or `undefined` for a write that
 * settles with none.
 *
 * `onSent` fires once, with the `relayId`, the moment the relayer answers `sent` rather than
 * `confirmed` — before the wait begins. It is the durable-resume hook the createEvent path needs:
 * the id is persisted on the draft so a page that closes here reopens onto {@link followRelay}
 * rather than a second send.
 */
export async function sendAction(
  kind: string,
  to: RelayTarget,
  data: Hex,
  onSent?: (relayId: string) => void,
): Promise<RelayActionResult | undefined> {
  const send = async (nonce?: bigint): Promise<RelayActionResponse> => {
    const built = await buildForwardRequest({ to, data, kind, nonce });
    return api.relayAction({ req: built.req, deviceSig: built.deviceSig, kind: built.kind });
  };
  let response: RelayActionResponse;
  try {
    response = await send();
  } catch (cause) {
    const nonce = badNonce(cause);
    if (nonce === undefined) throw cause;
    response = await send(nonce);
  }
  if (response.status === 'confirmed') return response.result;
  onSent?.(response.relayId);
  return followRelay(response.relayId);
}
