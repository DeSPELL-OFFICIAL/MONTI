import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Button, Card, Field, OpProgress, Spinner } from '../../shared/ui';
import { getConfig, settlementEnabled } from '../../shared/config';
import { api } from '../../shared/api/functions';
import { getSettlement, watchRelayStatus, watchSettlement, type SettlementView } from '../../shared/api/firestore';
import { readChainPolicy } from '../../shared/chain/settlementReads';
import { centsToDollars, dollarsToCents, formatUsdCents } from '../../shared/money';
import { useOrganizerCopy } from '../copy';
import { buildPolicyAuth } from './buildPolicyAuth';
import {
  bpsToPercent,
  blankRow,
  exampleSplit,
  percentToBps,
  platformBpsOf,
  platformRow,
  toRecipients,
  validateRows,
  type RecipientRow,
} from './settlementModel';

/** The ticket used for the worked example beside the editor (plan D: "example split of a $30 ticket"). */
const EXAMPLE_CENTS = 3000;

type Phase = 'idle' | 'signing' | 'sent' | 'done';

/** The event tiers the price inputs are keyed to; only the id and name are read here. */
export interface SettlementTier {
  id: string;
  name: string;
}

export interface SettlementSectionProps {
  eventId: string;
  tiers: SettlementTier[];
}

/** Reads `{ code, nonce }` off a callable rejection's `details` (BAD_NONCE carries the fresh nonce). */
function failureOf(cause: unknown): { code: string; nonce?: string } {
  const details = (cause as { details?: unknown } | null)?.details;
  if (typeof details === 'object' && details !== null) {
    const { code, nonce } = details as { code?: unknown; nonce?: unknown };
    return { code: typeof code === 'string' ? code : '', nonce: typeof nonce === 'string' ? nonce : undefined };
  }
  return { code: '' };
}

/**
 * The organiser's 정산 설정 section (Batch D): per-tier price in test USDC, a revenue-split editor
 * with a fixed MONTI platform row, live sum-to-100% validation, a worked $30 example, and the one
 * 확정 action that signs the split and relays it to the vault. It reads back `settlements/{eventId}`
 * and the chain policy's frozen flag, so once the first ticket sells it shows the settled rule
 * read-only with a link to the public page. Hidden entirely unless the settlement feature is wired.
 */
export function SettlementSection({ eventId, tiers }: SettlementSectionProps) {
  const copy = useOrganizerCopy().settlement;
  const config = getConfig();
  const enabled = settlementEnabled();
  const platformAddress = config.addresses.platform;

  const [loading, setLoading] = useState(true);
  const [frozen, setFrozen] = useState(false);
  const [settlement, setSettlement] = useState<SettlementView | null>(null);
  const [editing, setEditing] = useState(false);
  const [rows, setRows] = useState<RecipientRow[]>([]);
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState('');
  const [relayId, setRelayId] = useState<string | null>(null);

  // Seed the editor: an existing policy prefills it, otherwise one locked MONTI platform row.
  const seedEditor = useCallback(
    (from: SettlementView | null) => {
      if (from) {
        setRows(
          from.policy.recipients.map((r, i) => ({
            id: `seed-${i}`,
            name: r.reason,
            account: r.account,
            bps: r.bps,
            tag: r.tag,
            platform: r.tag === 'platform',
          })),
        );
        setPrices(Object.fromEntries(Object.entries(from.priceUsdCentsByTier ?? {}).map(([t, c]) => [t, centsToDollars(c)])));
      } else {
        setRows([platformRow(platformAddress ?? '')]);
        setPrices({});
      }
    },
    [platformAddress],
  );

  useEffect(() => {
    if (!enabled || eventId === '') {
      setLoading(false);
      return;
    }
    let live = true;
    void (async () => {
      const [settle, chain] = await Promise.all([
        getSettlement(eventId),
        readChainPolicy(BigInt(eventId)).catch(() => null),
      ]);
      if (!live) return;
      setSettlement(settle);
      setFrozen(chain?.frozen === true);
      seedEditor(settle);
      setLoading(false);
    })();
    return () => {
      live = false;
    };
  }, [enabled, eventId, seedEditor]);

  // Follow the relay doc while a confirmed answer has not come back yet, so a 'sent' lands on 완료.
  useEffect(() => {
    if (relayId === null || phase !== 'sent') return undefined;
    return watchRelayStatus(
      relayId,
      (relay) => {
        if (relay === null) return;
        if (relay.status === 'confirmed') {
          setRelayId(null);
          setPhase('done');
        } else if (relay.status === 'failed') {
          setRelayId(null);
          setError(copy.errors.failed);
          setPhase('idle');
        }
      },
      () => undefined,
    );
  }, [relayId, phase, copy.errors.failed]);

  // Keep the shown settlement fresh while the editor is open (the write lands here first).
  useEffect(() => {
    if (!enabled || eventId === '') return undefined;
    return watchSettlement(eventId, (next) => next && setSettlement(next), () => undefined);
  }, [enabled, eventId]);

  const validation = useMemo(() => validateRows(rows), [rows]);
  const platformBps = useMemo(() => platformBpsOf(rows), [rows]);
  const example = useMemo(() => exampleSplit(rows, EXAMPLE_CENTS), [rows]);
  const pricesReady = useMemo(
    () => tiers.length > 0 && tiers.every((_, i) => dollarsToCents(prices[String(i)] ?? '') !== null),
    [tiers, prices],
  );

  if (!enabled) return null;

  const setRow = (id: string, patch: Partial<RecipientRow>): void =>
    setRows((current) => current.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const addRow = (): void => setRows((current) => [...current, blankRow()]);
  const removeRow = (id: string): void => setRows((current) => current.filter((r) => r.id !== id));

  const priceMap = (): Record<string, number> => {
    const out: Record<string, number> = {};
    tiers.forEach((_, i) => {
      const cents = dollarsToCents(prices[String(i)] ?? '');
      if (cents !== null) out[String(i)] = cents;
    });
    return out;
  };

  const errorText = (): string => {
    if (error) return error;
    switch (validation.error) {
      case 'BAD_ACCOUNT':
        return copy.errors.badAccount;
      case 'BAD_BPS':
        return copy.errors.badBps;
      case 'PLATFORM_LOW':
        return copy.errors.platformLow;
      case 'BAD_SUM':
        return copy.errors.badSum;
      case 'EMPTY':
        return copy.errors.empty;
      default:
        return !pricesReady ? copy.errors.needPrices : '';
    }
  };

  const confirm = useCallback(async () => {
    if (platformAddress === undefined) {
      setError(copy.errors.noPlatform);
      return;
    }
    setPhase('signing');
    setError('');
    setRelayId(null);
    const recipients = toRecipients(rows);
    const send = async (nonce?: bigint) => {
      const built = await buildPolicyAuth({ eventId, recipients, platformBps, nonce });
      return api.relaySetPolicy({
        eventId,
        policy: built.policy,
        priceUsdCentsByTier: priceMap(),
        auth: built.auth,
        deviceSig: built.deviceSig,
      });
    };
    try {
      let result;
      try {
        result = await send();
      } catch (cause) {
        const { code, nonce } = failureOf(cause);
        if (code === 'BAD_NONCE' && nonce !== undefined) result = await send(BigInt(nonce));
        else throw cause;
      }
      if (result.status === 'confirmed') {
        setPhase('done');
      } else {
        setRelayId(result.relayId);
        setPhase('sent');
      }
    } catch (cause) {
      const { code } = failureOf(cause);
      setError(code === 'BAD_SPLIT_SUM' ? copy.errors.badSum : code === 'PLATFORM_TOO_LOW' ? copy.errors.platformLow : copy.errors.failed);
      setPhase('idle');
    }
  }, [platformAddress, rows, platformBps, eventId, copy.errors]);

  const confirmed = settlement !== null;
  const busy = phase === 'signing' || phase === 'sent';
  // Read-only once the first sale has frozen the split on chain, or a confirmed policy that the
  // organiser has not chosen to re-open. The 바꾸기 button is offered only while it is not frozen.
  const readOnly = frozen || (confirmed && !editing && phase !== 'done');

  return (
    <Card title={copy.title}>
      <div className="settlement-head">
        <span className="chip chip--test">{copy.testBadge}</span>
        {confirmed ? <span className="chip chip--on">{copy.confirmed}</span> : null}
      </div>
      <p className="muted">{copy.intro}</p>

      {loading ? (
        <Spinner />
      ) : readOnly ? (
        <ReadOnlyPolicy
          eventId={eventId}
          settlement={settlement}
          tiers={tiers}
          frozen={frozen}
          copy={copy}
          onEdit={frozen ? undefined : () => { setEditing(true); seedEditor(settlement); setPhase('idle'); }}
        />
      ) : phase === 'done' ? (
        <>
          <Alert tone="info">{copy.confirmed}</Alert>
          <Link to={`/settlement/${eventId}`} className="btn btn--primary btn--link">{copy.publicLink}</Link>
        </>
      ) : (
        <>
          <h3>{copy.priceHeading}</h3>
          {tiers.map((tier, index) => (
            <Field key={tier.id} label={`${tier.name} ($)`}>
              <input
                inputMode="decimal"
                value={prices[String(index)] ?? ''}
                placeholder="30"
                onChange={(e) => setPrices((p) => ({ ...p, [String(index)]: e.target.value }))}
              />
            </Field>
          ))}
          <p className="muted">{copy.priceHint}</p>

          <h3>{copy.splitHeading}</h3>
          <ul className="split-rows" style={{ listStyle: 'none', padding: 0 }}>
            {rows.map((row) => (
              <li key={row.id} className="split-row">
                <Field label={copy.nameLabel}>
                  <input
                    value={row.name}
                    readOnly={row.platform}
                    onChange={(e) => setRow(row.id, { name: e.target.value })}
                  />
                </Field>
                <Field label={copy.percentLabel}>
                  <input
                    inputMode="decimal"
                    value={bpsToPercent(row.bps)}
                    onChange={(e) => {
                      const bps = percentToBps(e.target.value);
                      if (bps !== null) setRow(row.id, { bps });
                      else if (e.target.value.trim() === '') setRow(row.id, { bps: 0 });
                    }}
                  />
                </Field>
                {row.platform ? (
                  <p className="muted">{copy.platformNote}</p>
                ) : (
                  <>
                    <Field label={copy.tagLabel}>
                      <input value={row.tag} onChange={(e) => setRow(row.id, { tag: e.target.value })} />
                    </Field>
                    <details className="more">
                      <summary>{copy.accountSummary}</summary>
                      <Field label={copy.accountLabel}>
                        <input
                          value={row.account}
                          placeholder="0x…"
                          onChange={(e) => setRow(row.id, { account: e.target.value.trim() })}
                        />
                      </Field>
                    </details>
                    <Button variant="ghost" onClick={() => removeRow(row.id)}>{copy.removeRow}</Button>
                  </>
                )}
              </li>
            ))}
          </ul>
          <Button variant="ghost" onClick={addRow}>{copy.addRow}</Button>

          <p className={validation.ok ? 'settlement-sum' : 'settlement-sum settlement-sum--off'}>
            {copy.sumLabel}: {bpsToPercent(validation.sumBps)}%
          </p>

          <div className="settlement-example">
            <h3>{copy.exampleHeading}</h3>
            <ul style={{ listStyle: 'none', padding: 0 }}>
              {example.map((line, i) => (
                <li key={i}>{line.name} · {formatUsdCents(line.cents)}</li>
              ))}
            </ul>
          </div>

          {errorText() ? <Alert tone={error ? 'error' : 'warn'}>{errorText()}</Alert> : null}
          {busy ? <OpProgress phase={phase === 'sent' ? 'confirming' : 'saving'} /> : null}

          <Button disabled={!validation.ok || !pricesReady || busy} onClick={() => void confirm()}>
            {busy ? copy.confirming : copy.confirm}
          </Button>
        </>
      )}
    </Card>
  );
}

/** The settled split, shown read-only with the public-page link once a policy exists (or is frozen). */
function ReadOnlyPolicy({
  eventId,
  settlement,
  tiers,
  frozen,
  copy,
  onEdit,
}: {
  eventId: string;
  settlement: SettlementView | null;
  tiers: SettlementTier[];
  frozen: boolean;
  copy: ReturnType<typeof useOrganizerCopy>['settlement'];
  onEdit?: () => void;
}) {
  if (settlement === null) {
    return (
      <>
        <Alert tone="info">{copy.confirmed}</Alert>
        <Link to={`/settlement/${eventId}`} className="btn btn--primary btn--link">{copy.publicLink}</Link>
      </>
    );
  }
  return (
    <>
      <ul style={{ listStyle: 'none', padding: 0 }}>
        {tiers.map((tier, index) => {
          const cents = settlement.priceUsdCentsByTier?.[String(index)];
          return cents === undefined ? null : (
            <li key={tier.id}>{tier.name} · {formatUsdCents(cents)}</li>
          );
        })}
      </ul>
      <ul style={{ listStyle: 'none', padding: 0 }}>
        {settlement.policy.recipients.map((r, i) => (
          <li key={i}>{r.reason || r.tag} · {bpsToPercent(r.bps)}%</li>
        ))}
      </ul>
      {frozen ? <p className="muted">{copy.frozenNote}</p> : null}
      <Link to={`/settlement/${eventId}`} className="btn btn--primary btn--link">{copy.publicLink}</Link>
      {onEdit ? <Button variant="ghost" onClick={onEdit}>{copy.edit}</Button> : null}
    </>
  );
}
