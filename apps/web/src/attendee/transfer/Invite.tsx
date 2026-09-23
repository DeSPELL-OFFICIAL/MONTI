import { useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { Alert, Button, Screen } from '../../shared/ui';
import { useCopy } from '../../shared/i18n';
import { useInvite } from './useInvite';

/**
 * Invite somebody who has not signed up yet. **We do not send the text.** The server writes
 * the sentence and builds an `sms:` link for the number the sender just typed; tapping it
 * opens the sender's own messaging app, already filled in. No delivery cost, no sender-id
 * registration, and no country a provider will not carry — and the link is opened by the
 * person, never by this screen, so nothing leaves until they decide it does.
 */
export function TransferInvite() {
  const copy = useCopy();
  const navigate = useNavigate();
  const { tokenId = '' } = useParams();
  const { phoneE164 } = (useLocation().state ?? {}) as { phoneE164?: string };
  const { phase, error, invite, cancelled, requireKyc, send, resend, cancel, refresh } =
    useInvite(tokenId);
  const [copied, setCopied] = useState(false);

  async function copyMessage(text: string): Promise<void> {
    setCopied(false);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // No clipboard on this device: the sentence is on screen to select by hand.
    }
  }

  // Reached without a number — a reload, or a link pasted straight into the bar.
  if (!phoneE164) {
    return (
      <Screen title={copy.transfer.inviteTitle}>
        <Alert tone="error">{copy.transfer.invitePhoneMissing}</Alert>
        <Button variant="ghost" onClick={() => navigate(`/tickets/${tokenId}/transfer`)}>
          {copy.common.back}
        </Button>
      </Screen>
    );
  }

  return (
    <Screen title={copy.transfer.inviteTitle}>
      <p>{copy.transfer.inviteBody}</p>
      {/* Only events that ask for it: most do not, and the sentence is a hurdle on the rest. */}
      {requireKyc ? <p className="muted">{copy.kyc.inviteKycNote}</p> : null}
      {error ? <Alert tone="error">{error}</Alert> : null}
      {cancelled ? <Alert tone="info">{copy.transfer.inviteCancelled}</Alert> : null}
      {phase === 'confirming' ? (
        <>
          {/* Neither sent nor refused: the offer may still land. The send stays visible but
              disabled — a second one would open a second offer — and the way forward is to
              ask the chain again rather than to stare at an alert with no control under it. */}
          <Alert tone="info">{copy.transfer.confirming}</Alert>
          <Button disabled>{copy.transfer.inviteCta}</Button>
          <Button variant="ghost" onClick={refresh}>
            {copy.common.retry}
          </Button>
        </>
      ) : null}
      {phase === 'open' ? (
        <>
          <Alert tone="info">{copy.transfer.inviteSent}</Alert>
          {invite ? (
            <>
              {/* Opened by the person, exactly as the server wrote it: iOS and Android
                  disagree about `?body=` versus `&body=`, and guessing here would break one
                  of them. A plain link also lets the device offer every app that can send. */}
              <a className="btn btn--primary" href={invite.smsUri}>
                {copy.transfer.inviteSmsCta}
              </a>
              {/* A tablet or a desktop browser has no messaging app to open, so the text
                  itself is the way out. */}
              <p className="muted">{copy.transfer.inviteFallback}</p>
              <p>{invite.smsText}</p>
              <Button variant="ghost" onClick={() => void copyMessage(invite.smsText)}>
                {copy.transfer.inviteCopy}
              </Button>
              {copied ? <Alert tone="info">{copy.transfer.inviteCopied}</Alert> : null}
            </>
          ) : (
            <>
              {/* A reload, or a send whose receipt timed out: the offer is on chain but the
                  message went with the page. The server hands it back for the same number, so
                  nothing new is written — without this the only way out is to cancel. */}
              <p className="muted">{copy.transfer.inviteOpenHint}</p>
              <Button onClick={() => void resend(phoneE164)}>{copy.transfer.inviteResend}</Button>
            </>
          )}
          <Button variant="ghost" onClick={() => void cancel()}>
            {copy.transfer.inviteCancel}
          </Button>
        </>
      ) : null}
      {phase === 'idle' || phase === 'working' ? (
        <Button onClick={() => void send(phoneE164)} disabled={phase === 'working'}>
          {copy.transfer.inviteCta}
        </Button>
      ) : null}
    </Screen>
  );
}
