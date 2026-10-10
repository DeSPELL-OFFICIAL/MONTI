import { useCallback, useEffect, useState } from 'react';
import { BPS_TOTAL } from '@monti/shared';
import { Alert, Button, Sheet } from '../../shared/ui';
import { fmt, useCopy, useLocale } from '../../shared/i18n';
import { getConfig } from '../../shared/config';
import { api } from '../../shared/api/functions';
import { getSettlement, watchOrder, type OrderView, type SettlementView } from '../../shared/api/firestore';
import { formatUsdCents } from '../../shared/money';
import { orderIdForEvent, orderIdForToken } from './orderStore';

export interface ReceiptProps {
  tokenId: string;
  eventId: string;
  /** The ticket may still be refunded while it has not been used (before the event / entry). */
  canRefund: boolean;
  /** Told the order's status as it changes (`null` while there is no order), so the detail screen
   *  can take 입장하기 and 친구에게 주기 away from a refunded ticket. */
  onStatus?: (status: OrderView['status'] | null) => void;
}

/** Split an order's paid cents across the policy recipients by bps, last row taking the dust. */
function splitByRole(recipients: SettlementView['policy']['recipients'], cents: number): { label: string; cents: number }[] {
  let distributed = 0;
  return recipients.map((r, i) => {
    const share = i === recipients.length - 1 ? cents - distributed : Math.floor((cents * r.bps) / BPS_TOTAL);
    distributed += share;
    return { label: r.reason || r.tag || 'MONTI', cents: share };
  });
}

/**
 * The paid ticket's receipt on the ticket detail (Batch F): amount, time, status (held → settled on
 * admission), the by-role breakdown from the event's split policy times the amount, and — before the
 * event — a refund. The on-chain record link sits under 상세, the one place a web3-flavoured link is
 * allowed. It renders nothing for a free ticket (no order recorded on this device), so the detail
 * screen is unchanged for events without settlement.
 */
export function Receipt({ tokenId, eventId, canRefund, onStatus }: ReceiptProps) {
  const copy = useCopy();
  const locale = useLocale();
  const [order, setOrder] = useState<OrderView | null>(null);
  const [settlement, setSettlement] = useState<SettlementView | null>(null);
  const [refunding, setRefunding] = useState(false);
  const [refundError, setRefundError] = useState('');
  // A refund cannot be taken back, so the button asks first (the same sheet 공개하기 uses).
  const [confirming, setConfirming] = useState(false);
  const [refundDone, setRefundDone] = useState(false);

  const orderId = orderIdForToken(tokenId) ?? orderIdForEvent(eventId);

  useEffect(() => {
    if (orderId === null) return undefined;
    void getSettlement(eventId).then(setSettlement);
    return watchOrder(orderId, setOrder, () => setOrder(null));
  }, [orderId, eventId]);

  const status = order?.status ?? null;
  useEffect(() => {
    onStatus?.(status);
  }, [onStatus, status]);

  const refund = useCallback(async () => {
    if (orderId === null) return;
    setConfirming(false);
    setRefunding(true);
    setRefundError('');
    try {
      await api.refundOrder({ orderId });
      // watchOrder reflects the refunded status; this only says the tap worked.
      setRefundDone(true);
    } catch {
      setRefundError(copy.purchase.refundFailed);
    } finally {
      setRefunding(false);
    }
  }, [orderId, copy.purchase.refundFailed]);

  if (orderId === null || order === null) return null;

  const statusLine =
    order.status === 'released'
      ? copy.purchase.statusReleased
      : order.status === 'refunded'
        ? copy.purchase.statusRefunded
        : order.status === 'deposited'
          ? copy.purchase.statusHeld
          : copy.purchase.statusPending;

  const paidAt = order.createdAt !== undefined ? new Date(order.createdAt).toLocaleString(locale) : '';
  const split = settlement ? splitByRole(settlement.policy.recipients, order.amountUsdCents) : [];
  const receiptTx = order.receiptTxHash ?? order.depositTxHash;
  const explorer = getConfig().explorerUrl;

  return (
    <section className="receipt">
      <h2>{copy.purchase.receiptTitle}</h2>
      <p className="receipt-amount">{formatUsdCents(order.amountUsdCents)}</p>
      {paidAt ? <p className="muted">{copy.purchase.paidAt}: {paidAt}</p> : null}
      <p>{statusLine}</p>

      {split.length > 0 ? (
        <>
          <h3>{copy.purchase.splitHeading}</h3>
          <ul style={{ listStyle: 'none', padding: 0 }}>
            {split.map((line, i) => (
              <li key={i}>{line.label} · {formatUsdCents(line.cents)}</li>
            ))}
          </ul>
        </>
      ) : null}

      {refundError ? <Alert tone="error">{refundError}</Alert> : null}
      {refundDone ? <Alert tone="info">{copy.purchase.refundDone}</Alert> : null}
      {canRefund && order.status === 'deposited' ? (
        <Button variant="ghost" disabled={refunding} onClick={() => setConfirming(true)}>
          {refunding ? copy.purchase.refunding : copy.purchase.refund}
        </Button>
      ) : null}
      {confirming ? (
        <Sheet label={copy.purchase.refundConfirmTitle} onDismiss={() => setConfirming(false)}>
          <h2>{copy.purchase.refundConfirmTitle}</h2>
          <p>{fmt(copy.purchase.refundConfirmBody, { amount: formatUsdCents(order.amountUsdCents) })}</p>
          <Button variant="danger" onClick={() => void refund()}>{copy.purchase.refundConfirm}</Button>
          <Button variant="ghost" onClick={() => setConfirming(false)}>{copy.purchase.refundCancel}</Button>
        </Sheet>
      ) : null}

      {receiptTx ? (
        <details className="more">
          <summary>{copy.purchase.receiptDetails}</summary>
          <p>
            <a href={`${explorer}/tx/${receiptTx}`} target="_blank" rel="noreferrer">
              {copy.purchase.receiptLink}
            </a>
          </p>
        </details>
      ) : null}
    </section>
  );
}
