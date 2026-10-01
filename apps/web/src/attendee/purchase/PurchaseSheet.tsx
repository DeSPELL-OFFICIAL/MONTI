import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Button, Field, OpProgress, Sheet } from '../../shared/ui';
import { useCopy } from '../../shared/i18n';
import { formatUsdCents } from '../../shared/money';
import { usePurchase } from './usePurchase';

export interface PurchaseSheetProps {
  eventId: string;
  tier: number;
  amountUsdCents: number;
  onClose: () => void;
}

/**
 * The mock card sheet and the determinate purchase wait (Batch F). It opens on a card form that
 * says in plain words this is a test charge — no real money moves — then runs `purchaseTicket` and
 * shows the 결제 확인 → 티켓 발급 → 보관 완료 steps over {@link OpProgress}. On success it points at 내
 * 티켓, where the receipt and refund live; a determinate refusal shows its sentence and the retry.
 * The card number is never read — it is a demo field — so nothing here collects a real credential.
 */
export function PurchaseSheet({ eventId, tier, amountUsdCents, onClose }: PurchaseSheetProps) {
  const copy = useCopy();
  const purchase = usePurchase({ eventId, tier, amountUsdCents });
  const [card, setCard] = useState('');
  const busy = purchase.phase === 'paying' || purchase.phase === 'minting';
  const labels: [string, string, string] = [copy.purchase.steps.pay, copy.purchase.steps.mint, copy.purchase.steps.store];

  return (
    <Sheet label={copy.purchase.sheetTitle} onDismiss={onClose}>
      <div className="purchase-head">
        <h2>{copy.purchase.sheetTitle}</h2>
        <span className="chip chip--test">{copy.purchase.testBadge}</span>
      </div>

      {purchase.phase === 'done' ? (
        <>
          <Alert tone="info">{copy.purchase.done}</Alert>
          <Link to="/tickets" className="btn btn--primary btn--link" onClick={onClose}>
            {copy.purchase.toTickets}
          </Link>
        </>
      ) : (
        <>
          <p className="purchase-amount">{copy.purchase.amountLabel}: {formatUsdCents(amountUsdCents)}</p>
          <p className="muted">{copy.purchase.testNotice}</p>

          {/* A demo card field: never read, never sent. It is here so the step reads as a payment. */}
          <Field label={copy.purchase.cardLabel}>
            <input
              inputMode="numeric"
              value={card}
              placeholder={copy.purchase.cardPlaceholder}
              disabled={busy}
              onChange={(e) => setCard(e.target.value)}
            />
          </Field>

          {purchase.phase === 'error' && purchase.error ? <Alert tone="error">{purchase.error}</Alert> : null}
          {busy ? <OpProgress phase={purchase.phase === 'minting' ? 'confirming' : 'saving'} labels={labels} /> : null}

          <Button disabled={busy} onClick={() => void purchase.run()}>
            {busy ? copy.purchase.paying : `${copy.purchase.pay} ${formatUsdCents(amountUsdCents)}`}
          </Button>
          <Button variant="ghost" disabled={busy} onClick={onClose}>{copy.common.close}</Button>
        </>
      )}
    </Sheet>
  );
}
