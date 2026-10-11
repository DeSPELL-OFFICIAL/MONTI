import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Alert, Button, Field, OpProgress, Sheet } from '../../shared/ui';
import { OP_TIMEOUT_SECONDS } from '../../shared/ui/OpProgress';
import { fmt, useCopy } from '../../shared/i18n';
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
 * shows the 결제 확인 → 티켓 발급 → 결제 금액 보관 steps over {@link OpProgress}. On success it points at
 * the new ticket's receipt; a refusal or a failed step (one atomic step — no ticket, no charge)
 * shows its sentence and the retry.
 * The card number is never read — it is a demo field — so nothing here collects a real credential.
 *
 * Past {@link OP_TIMEOUT_SECONDS} the wait stops holding the person: 닫기 opens up and the way out is
 * 내 티켓, where the ticket lands on its own. It is deliberately not a second purchase — a re-run is
 * a second charge, not an idempotent retry — so the "retry" is to go and look.
 */
export function PurchaseSheet({ eventId, tier, amountUsdCents, onClose }: PurchaseSheetProps) {
  const copy = useCopy();
  const navigate = useNavigate();
  const purchase = usePurchase({ eventId, tier, amountUsdCents });
  const [card, setCard] = useState('');
  const [slow, setSlow] = useState(false);
  const busy = purchase.phase === 'paying' || purchase.phase === 'sent';
  const labels: [string, string, string] = [copy.purchase.steps.pay, copy.purchase.steps.mint, copy.purchase.steps.store];
  const amount = formatUsdCents(amountUsdCents);

  useEffect(() => {
    if (!busy) {
      setSlow(false);
      return undefined;
    }
    const timer = setTimeout(() => setSlow(true), OP_TIMEOUT_SECONDS * 1000);
    return () => clearTimeout(timer);
  }, [busy]);

  const checkTickets = (): void => {
    onClose();
    navigate('/tickets');
  };

  return (
    <Sheet label={copy.purchase.sheetTitle} onDismiss={onClose}>
      <div className="purchase-head">
        <h2>{copy.purchase.sheetTitle}</h2>
        <span className="chip chip--test">{copy.purchase.testBadge}</span>
      </div>

      {purchase.phase === 'done' ? (
        <>
          <Alert tone="info">{copy.purchase.done}</Alert>
          {/* The receipt lives on the ticket itself; without a token id yet, 내 티켓 is where it is. */}
          <Link
            to={purchase.tokenId !== undefined ? `/tickets/${purchase.tokenId}` : '/tickets'}
            className="btn btn--primary btn--link"
            onClick={onClose}
          >
            {purchase.tokenId !== undefined ? copy.purchase.toReceipt : copy.purchase.toTickets}
          </Link>
        </>
      ) : (
        <>
          <p className="purchase-amount">{copy.purchase.amountLabel}: {amount}</p>
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
          {busy ? (
            <OpProgress
              phase={purchase.phase === 'sent' ? 'confirming' : 'saving'}
              labels={labels}
              timeoutMessage={copy.purchase.slow}
              onLater={checkTickets}
              laterLabel={copy.purchase.slowCheck}
            />
          ) : null}

          <Button disabled={busy} onClick={() => void purchase.run()}>
            {busy ? copy.purchase.paying : fmt(copy.purchase.pay, { amount })}
          </Button>
          <Button variant="ghost" disabled={busy && !slow} onClick={onClose}>{copy.common.close}</Button>
        </>
      )}
    </Sheet>
  );
}
