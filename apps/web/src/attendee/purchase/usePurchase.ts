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
 * Where a purchase is in its 결제 확인 → 티켓 발급 → 보관 완료 wait.
 *   - `idle`    — the card sheet is up; nothing sent.
 *   - `paying`  — the mock charge is accepted and `purchaseTicket` is building/calling (결제 확인).
 *   - `minting` — the mint is in flight; the relay doc is followed (티켓 발급).
 *   - `done`    — the ticket is minted (escrow deposited or deferred) — a real completion (보관 완료).
 *   - `error`   — a determinate refusal; the sheet shows its sentence and the retry.
 */
export type PurchasePhase = 'idle' | 'paying' | 'minting' | 'done' | 'error';

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
 * the free claim uses (the mint underneath is a relayed claim), the mock card charge rides beside
 * it, and the backend mints the ticket and deposits the USDC into escrow. A `sent` answer means
 * the mint is still in flight, so the relay doc is followed to 완료; a `minted`/`deposited` answer
 * is already done. The order id is remembered on this device so the ticket detail can show the
 * receipt. The single BAD_NONCE retry mirrors the claim flow: the server reports the fresh nonce
 * and the auth is rebuilt once, never a loop.
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
        setPhase('minting');
      } else {
        // 'minted' or 'deposited' — the ticket exists; the escrow may settle in the background.
        setPhase('done');
      }
    } catch (cause) {
      setError(purchaseCopy(relayClaimError(cause).code, copy));
      setPhase('error');
    }
  }, [eventId, tier, amountUsdCents, copy]);

  // Follow the mint's relay doc while it is in flight: `confirmed` lands on 완료 (and records the
  // minted token), `failed` shows the code's sentence. A dropped listener leaves the wait in place.
  useEffect(() => {
    if (relayId === null || phase !== 'minting') return undefined;
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
          setError(purchaseCopy(relay.error?.code ?? '', copy));
          setPhase('error');
        }
      },
      () => undefined,
    );
  }, [relayId, phase, orderId, eventId, copy]);

  return { phase, error, orderId, tokenId, run };
}
