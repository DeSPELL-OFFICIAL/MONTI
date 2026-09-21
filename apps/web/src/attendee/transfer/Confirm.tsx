import { useEffect } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import type { Hex } from '@monti/shared';
import { Alert, Button, Screen } from '../../shared/ui';
import { useCopy } from '../../shared/i18n';
import { useTransfer } from './useTransfer';

export function TransferConfirm() {
  const copy = useCopy();
  const navigate = useNavigate();
  const { tokenId = '' } = useParams();
  const { account, nickname } = (useLocation().state ?? {}) as { account?: Hex; nickname?: string };
  const { phase, error, run } = useTransfer(tokenId);

  // Back to the list, where Task 21's derived state already reads the ticket as handed over.
  useEffect(() => {
    if (phase === 'sent') navigate('/tickets');
  }, [phase, navigate]);

  // Reached without a recipient — a reload, or a link pasted straight into the bar.
  if (!account) {
    return (
      <Screen title={copy.transfer.confirmTitle}>
        <Alert tone="error">{copy.transfer.notFound}</Alert>
        <Button variant="ghost" onClick={() => navigate(`/tickets/${tokenId}/transfer`)}>
          {copy.common.back}
        </Button>
      </Screen>
    );
  }

  return (
    <Screen title={copy.transfer.confirmTitle}>
      <p>{nickname ?? account}</p>
      {phase === 'confirming' ? (
        <>
          <Alert tone="info">{copy.transfer.confirming}</Alert>
          <Button variant="ghost" onClick={() => navigate('/tickets')}>{copy.tabs.tickets}</Button>
        </>
      ) : null}
      {error ? <Alert tone="error">{error}</Alert> : null}
      {/* Still confirming counts as busy: the operation is already on its way and a second
          tap would hand the same ticket over twice. */}
      <Button onClick={() => void run(account)} disabled={phase !== 'idle'}>
        {copy.transfer.confirmCta}
      </Button>
    </Screen>
  );
}
