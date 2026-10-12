import { useCallback, useEffect, useState } from 'react';
import type { Hex } from '@monti/shared';
import { useCopy } from '../../shared/i18n';
import { api } from '../../shared/api/functions';
import { watchRelayStatus } from '../../shared/api/firestore';
import { getAttendeeAccount } from '../../shared/chain/accounts';
import { buildClaimAuth } from '../claim/buildClaimAuth';
import { relayClaimError } from '../claim/claimErrors';
import { purchaseCopy } from './purchaseErrors';
import { rememberOrder } from './orderStore';

/**
 * Where a purchase is in its one-tap wait. The backend runs ticket + payment as one atomic step
 * (order `pending → sent → deposited`, or `failed` with nothing charged), so the sheet mirrors it:
 *   - `idle`    — the card sheet is up; nothing sent.
 *   - `paying`  — `purchaseTicket` is building/calling (order `pending`).
 *   - `sent`    — the step is in flight; the `purchase` relay doc is followed (order `sent`).
 *   - `done`    — the ticket is issued and the payment held (order `deposited`).
 *   - `error`   — a refusal or a failed step: no ticket, no charge; the sheet shows its sentence
 *                 and the retry.
 */
export type PurchasePhase = 'idle' | 'paying' | 'sent' | 'done' | 'error';

export interface PurchaseParams {
  eventId: string;
  tier: number;
  amountUsdCents: number;
}

export interface PurchaseState {
  phase: PurchasePhase;
  error: string;
  orderId?: string;
  tokenId?: string;
  run: () => Promise<void>;
}

/**
 * Buys one ticket through `purchaseTicket`: the device key signs the same {@link buildClaimAuth}
 * the free claim uses, the mock card charge rides beside it, and the backend issues the ticket and
 * holds the payment in one step. A `deposited` answer is done; a `sent` answer means the step is
 * still in flight, so the `purchase` relay doc is followed until it confirms (or fails — then
 * nothing was charged). The order id is remembered on this device so the ticket detail can show
 * the receipt. The single BAD_NONCE retry mirrors the claim flow: the server reports the fresh
 * nonce and the auth is rebuilt once, never a loop.
 */
export function usePurchase({ eventId, tier, amountUsdCents }: PurchaseParams): PurchaseState {
  const copy = useCopy();
  const [phase, setPhase] = useState<PurchasePhase>('idle');
  const [error, setError] = useState('');
  const [orderId, setOrderId] = useState<string | undefined>();
  const [tokenId, setTokenId] = useState<string | undefined>();
  const [relayId, setRelayId] = useState<string | null>(null);

  const run = useCallback(async () => {
    setPhase('paying');
    setError('');
    setRelayId(null);
    try {
      const account = (await getAttendeeAccount()).address as Hex;
      const send = async (nonce?: bigint) => {
        const { auth, deviceSig } = await buildClaimAuth({ eventId, tier, account, nonce });
        return api.purchaseTicket({
          eventId,
          tier,
          auth,
          deviceSig,
          payment: { method: 'card-mock', amountUsdCents },
        });
      };
      let result;
      try {
        result = await send();
      } catch (cause) {
        const { code, nonce } = relayClaimError(cause);
        if (code === 'BAD_NONCE' && nonce !== undefined) result = await send(BigInt(nonce));
        else throw cause;
      }
      setOrderId(result.orderId);
      rememberOrder(result.orderId, { eventId, tokenId: result.tokenId });
      if (result.tokenId !== undefined) setTokenId(result.tokenId);
      if (result.status === 'sent') {
        setRelayId(result.relayId);
        setPhase('sent');
      } else {
        setPhase('done');
      }
    } catch (cause) {
      setError(purchaseCopy(relayClaimError(cause).code, copy));
      setPhase('error');
    }
  }, [eventId, tier, amountUsdCents, copy]);

  // Follow the purchase relay doc while the step is in flight: `confirmed` lands on 완료 (and
  // records the issued token), `failed` is a reverted step — nothing charged — so it says so.
  // A dropped listener leaves the wait in place; past the timeout the sheet offers 내 티켓.
  useEffect(() => {
    if (relayId === null || phase !== 'sent') return undefined;
    return watchRelayStatus(
      relayId,
      (relay) => {
        if (relay === null) return;
        if (relay.status === 'confirmed') {
          setRelayId(null);
          if (relay.tokenId !== undefined) {
            setTokenId(relay.tokenId);
            if (orderId !== undefined) rememberOrder(orderId, { eventId, tokenId: relay.tokenId });
          }
          setPhase('done');
        } else if (relay.status === 'failed') {
          setRelayId(null);
          const code = relay.error?.code;
          setError(code ? purchaseCopy(code, copy) : copy.purchase.notCharged);
          setPhase('error');
        }
      },
      () => undefined,
    );
  }, [relayId, phase, orderId, eventId, copy]);

  return { phase, error, orderId, tokenId, run };
}
