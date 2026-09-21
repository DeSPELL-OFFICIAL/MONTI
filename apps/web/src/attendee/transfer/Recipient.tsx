import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { Hex } from '@monti/shared';
import { Alert, Button, Field, Screen } from '../../shared/ui';
import { useCopy } from '../../shared/i18n';
import type { Copy } from '../../shared/copy/index';
import { api, callableFailure } from '../../shared/api/functions';
import { toE164 } from '../../shared/api/auth';

/** Spec §5.4: three ways to name the person who gets the ticket. */
export type RecipientRoute = 'nickname' | 'address' | 'phone';

const ROUTES: readonly RecipientRoute[] = ['nickname', 'address', 'phone'];
const COUNTRY_CODES = ['+82', '+1', '+81', '+44', '+49', '+65'];

/**
 * The server answers with a short uppercase reason, never a sentence. Everything it can say
 * about a recipient it could not use maps to one line here; anything else is a failure the
 * person cannot act on, so it gets the generic one.
 */
function findError(copy: Copy, error: unknown): string {
  switch (callableFailure(error).reason) {
    case 'NICKNAME_UNKNOWN':
      return copy.transfer.notFound;
    case 'NOT_A_MEMBER':
      return copy.transfer.alertNotMember;
    case 'SELF_TRANSFER':
      return copy.transfer.alertSelf;
    case 'BAD_PHONE':
    case 'BAD_ADDRESS':
    case 'BAD_VALUE':
    case 'BAD_TYPE':
    case 'EMPTY_NICKNAME':
      return copy.transfer.badInput;
    default:
      return copy.common.error;
  }
}

export function TransferRecipient() {
  const copy = useCopy();
  const navigate = useNavigate();
  const { tokenId = '' } = useParams();
  const [route, setRoute] = useState<RecipientRoute>('nickname');
  const [country, setCountry] = useState(COUNTRY_CODES[0]!);
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // Set when the number belongs to nobody yet. Task 23 turns this panel into the invite itself.
  const [invite, setInvite] = useState<{ phoneE164: string; commitment?: Hex } | null>(null);

  const labels: Record<RecipientRoute, string> = {
    nickname: copy.transfer.byNickname,
    address: copy.transfer.byAddress,
    phone: copy.transfer.byPhone,
  };

  function pick(next: RecipientRoute): void {
    setRoute(next);
    setError('');
    setInvite(null);
  }

  async function find(): Promise<void> {
    setError('');
    setInvite(null);
    setBusy(true);
    try {
      const payloadValue = route === 'phone' ? toE164(value, country) : value.trim();
      const result = await api.resolveRecipient({ type: route, value: payloadValue });
      if (result.member && result.account) {
        navigate(`/tickets/${tokenId}/transfer/confirm`, {
          state: { account: result.account, nickname: result.nickname },
        });
        return;
      }
      // Only the phone route can answer "not a member": a nickname nobody owns and an address
      // outside the membership are refusals, not an invitation to sign up.
      if (route === 'phone') {
        setInvite({ phoneE164: payloadValue, commitment: result.commitment });
        return;
      }
      setError(copy.transfer.notFound);
    } catch (cause) {
      setError(findError(copy, cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen title={copy.transfer.title}>
      <div role="tablist" style={{ display: 'flex', gap: 8 }}>
        {ROUTES.map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={route === key}
            className={`btn ${route === key ? 'btn--primary' : 'btn--ghost'}`}
            onClick={() => pick(key)}
          >
            {labels[key]}
          </button>
        ))}
      </div>
      {route === 'phone' ? (
        <Field label={copy.signup.phoneCountry}>
          <select value={country} onChange={(event) => setCountry(event.target.value)}>
            {COUNTRY_CODES.map((code) => (
              <option key={code} value={code}>{code}</option>
            ))}
          </select>
        </Field>
      ) : null}
      <Field label={labels[route]}>
        <input value={value} onChange={(event) => setValue(event.target.value)} />
      </Field>
      {error ? <Alert tone="error">{error}</Alert> : null}
      {invite ? (
        <section>
          <h2>{copy.transfer.inviteTitle}</h2>
          <p>{copy.transfer.inviteBody}</p>
          <p className="muted">{copy.kyc.inviteKycNote}</p>
        </section>
      ) : null}
      <Button onClick={() => void find()} disabled={busy || value.trim().length === 0}>
        {copy.transfer.findCta}
      </Button>
    </Screen>
  );
}
