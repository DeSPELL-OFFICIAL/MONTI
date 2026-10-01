import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { Card, EmptyState, Screen, Spinner } from '../../shared/ui';
import { getConfig } from '../../shared/config';
import { useLocale } from '../../shared/i18n';
import type { SettlementView } from '../../shared/api/firestore';
import { settlementCopy as t } from './copy';
import {
  buildReasonLookup,
  percentFromBps,
  reasonForPayout,
  shortHex,
  usdFromBaseUnits,
  usdFromCents,
  type ReadableRecipient,
} from './format';
import { useSettlementDoc, useSettlementEvent, useSettlementLive, type EscrowRow } from './useSettlement';
import './settlement.css';

/** The segment colours of the share bar; the platform and the reserve get their own muted tones. */
const SEGMENT_COLORS = ['#836EF9', '#5B3FD9', '#0F7A5A', '#A0055D', '#8A5200', '#4C4877'];
const PLATFORM_COLOR = '#B9B3D6';
const RESERVE_COLOR = '#E3DEF7';

function localeTag(locale: string): string {
  return locale === 'en' ? 'en-US' : 'ko-KR';
}

function eventDate(startsAt: string | undefined, locale: string): string {
  const ms = Number(startsAt) * 1000;
  if (!startsAt || !Number.isFinite(ms) || ms <= 0) return '';
  return new Date(ms).toLocaleString(localeTag(locale), { dateStyle: 'long', timeStyle: 'short' });
}

function payoutTime(at: string, locale: string): string {
  const ms = Number(at) * 1000;
  if (!Number.isFinite(ms) || ms <= 0) return '';
  return new Date(ms).toLocaleTimeString(localeTag(locale), {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** `getConfig()` throws on a build with no chain env; the public page tolerates that and simply
 *  shows text instead of a link, so a reader never sees it fall over. */
function safeExplorer(): string {
  try {
    return getConfig().explorerUrl;
  } catch {
    return '';
  }
}
function safeVault(): string {
  try {
    return getConfig().addresses.settlementVault ?? '';
  } catch {
    return '';
  }
}

function explorerLink(base: string, kind: 'address' | 'tx', value: string): ReactNode {
  const text = shortHex(value);
  if (!base || !value) return <span className="mono">{text}</span>;
  return (
    <a className="mono" href={`${base}/${kind}/${value}`} target="_blank" rel="noreferrer">
      {text}
    </a>
  );
}

interface Segment {
  label: string;
  bps: number;
  amountCents: number;
  color: string;
}

/** The most expensive tier is the clearest example to divide — "a $30 ticket splits like this". */
function representativeCents(byTier: Record<string, number> | undefined): number {
  const values = Object.values(byTier ?? {}).filter((n) => Number.isFinite(n) && n > 0);
  return values.length ? Math.max(...values) : 3000;
}

function buildSegments(
  policy: SettlementView['policy'],
  recipients: ReadableRecipient[],
  ticketCents: number,
): Segment[] {
  const segments: Segment[] = recipients.map((recipient, index) => ({
    label: recipient.reason || recipient.tag || t.reasonFallback(index + 1),
    bps: recipient.bps,
    amountCents: (ticketCents * recipient.bps) / 10000,
    color: SEGMENT_COLORS[index % SEGMENT_COLORS.length] ?? PLATFORM_COLOR,
  }));
  if (policy.platformBps > 0) {
    segments.push({
      label: t.platformLabel,
      bps: policy.platformBps,
      amountCents: (ticketCents * policy.platformBps) / 10000,
      color: PLATFORM_COLOR,
    });
  }
  const used = recipients.reduce((sum, recipient) => sum + recipient.bps, 0) + policy.platformBps;
  const reserve = 10000 - used;
  if (reserve > 0) {
    segments.push({
      label: t.reserveLabel,
      bps: reserve,
      amountCents: (ticketCents * reserve) / 10000,
      color: RESERVE_COLOR,
    });
  }
  return segments;
}

interface StatCell {
  count: number;
  amount: string;
}

function aggregate(escrows: EscrowRow[]): {
  total: StatCell;
  released: StatCell;
  refunded: StatCell;
  noShow: StatCell;
} {
  const sum = (rows: EscrowRow[]): bigint =>
    rows.reduce((acc, row) => acc + BigInt(row.amount && row.amount !== '' ? row.amount : '0'), 0n);
  const cell = (rows: EscrowRow[]): StatCell => ({ count: rows.length, amount: usdFromBaseUnits(sum(rows)) });
  const withStatus = (status: string): EscrowRow[] => escrows.filter((row) => row.status === status);
  return {
    total: cell(escrows),
    released: cell(withStatus('Released')),
    refunded: cell(withStatus('Refunded')),
    noShow: cell(withStatus('NoShowSettled')),
  };
}

function Header({ title, startsAt, locale }: { title: string; startsAt?: string; locale: string }): ReactNode {
  const date = eventDate(startsAt, locale);
  return (
    <header className="settle-header">
      <div className="settle-header__top">
        <h1 className="settle-title">{title || t.fallbackTitle}</h1>
        <span className="test-badge">{t.badge}</span>
      </div>
      {date ? <p className="muted settle-date">{date}</p> : null}
      <p className="settle-note">{t.headerNote}</p>
    </header>
  );
}

function StatTile({
  label,
  sub,
  cell,
  tone,
}: {
  label: string;
  sub?: string;
  cell: StatCell;
  tone?: 'success';
}): ReactNode {
  return (
    <div className={`stat-tile${tone ? ` stat-tile--${tone}` : ''}`}>
      <span className="stat-tile__label">{label}</span>
      <span className="stat-tile__amt">{cell.amount}</span>
      <span className="stat-tile__count muted">{t.countUnit(cell.count)}</span>
      {sub ? <span className="stat-tile__sub muted">{sub}</span> : null}
    </div>
  );
}

/**
 * The public, no-login settlement page: how one event's revenue is split, and the same split
 * happening live as people are admitted. Rules come from the server's readable policy document;
 * the running totals and the payout stream come from the indexer, re-asked every few seconds.
 */
export function Settlement(): ReactNode {
  const { eventId = '' } = useParams();
  const locale = useLocale();
  const docQuery = useSettlementDoc(eventId);
  const headerQuery = useSettlementEvent(eventId);
  const liveQuery = useSettlementLive(eventId);

  const live = liveQuery.data;
  const payouts = live?.Payout ?? [];

  // Highlight only the rows that arrive after the first batch — the live "입장 순간 분배" moment,
  // never the history already on screen when the page opens.
  const seen = useRef<Set<string>>(new Set());
  const seeded = useRef(false);
  const freshIds = useMemo(() => {
    const fresh = new Set<string>();
    if (!seeded.current) return fresh;
    for (const payout of payouts) if (!seen.current.has(payout.id)) fresh.add(payout.id);
    return fresh;
  }, [payouts]);
  useEffect(() => {
    if (!live) return;
    for (const payout of payouts) seen.current.add(payout.id);
    seeded.current = true;
  }, [live, payouts]);

  if (docQuery.isLoading || headerQuery.isLoading) {
    return (
      <Screen>
        <div className="settle-center">
          <Spinner />
          <p className="muted">{t.loading}</p>
        </div>
      </Screen>
    );
  }

  if (headerQuery.isError || docQuery.isError) {
    return (
      <Screen>
        <Card title={t.errorTitle}>
          <p className="muted">{t.errorBody}</p>
          <button
            type="button"
            className="settle-retry"
            onClick={() => {
              void headerQuery.refetch();
              void docQuery.refetch();
              void liveQuery.refetch();
            }}
          >
            {t.retry}
          </button>
        </Card>
      </Screen>
    );
  }

  const settlement = docQuery.data;
  const title = headerQuery.data?.title ?? '';
  const startsAt = headerQuery.data?.event.startsAt;

  if (!settlement) {
    return (
      <Screen>
        <Header title={title} startsAt={startsAt} locale={locale} />
        <EmptyState>{t.emptyTitle}</EmptyState>
        <p className="muted settle-empty-body">{t.emptyBody}</p>
      </Screen>
    );
  }

  const recipients: ReadableRecipient[] = settlement.policy.recipients;
  const ticketCents = representativeCents(settlement.priceUsdCentsByTier);
  const segments = buildSegments(settlement.policy, recipients, ticketCents);
  const lookup = buildReasonLookup(recipients);
  const stats = aggregate(live?.Escrow ?? []);
  const explorer = safeExplorer();
  const vault = safeVault();

  return (
    <Screen>
      <Header title={title} startsAt={startsAt} locale={locale} />

      <Card title={t.rulesTitle}>
        <div className="split-bar" role="img" aria-label={t.rulesTitle}>
          {segments.map((segment) => (
            <span
              key={segment.label}
              className="split-bar__seg"
              style={{ width: `${segment.bps / 100}%`, background: segment.color }}
            />
          ))}
        </div>
        <p className="muted split-example">{t.perTicket(usdFromCents(ticketCents))}</p>
        <ul className="split-rows">
          {segments.map((segment) => (
            <li key={segment.label} className="split-row">
              <span className="split-row__dot" style={{ background: segment.color }} aria-hidden="true" />
              <span className="split-row__name">{segment.label}</span>
              <span className="split-row__pct">{percentFromBps(segment.bps)}</span>
              <span className="split-row__amt">{usdFromCents(segment.amountCents)}</span>
            </li>
          ))}
        </ul>
      </Card>

      <Card title={t.liveTitle}>
        <div className="stat-grid">
          <StatTile label={t.statDeposited} sub={t.statDepositedSub} cell={stats.total} />
          <StatTile label={t.statReleased} cell={stats.released} tone="success" />
          <StatTile label={t.statRefunded} cell={stats.refunded} />
          <StatTile label={t.statNoShow} cell={stats.noShow} />
        </div>
        <h3 className="payouts-head">{t.payoutsTitle}</h3>
        {payouts.length === 0 ? (
          <p className="muted">{t.payoutsEmpty}</p>
        ) : (
          <ul className="payout-list">
            {payouts.map((payout, index) => (
              <li key={payout.id} className={`payout-row${freshIds.has(payout.id) ? ' is-new' : ''}`}>
                <span className="payout-row__time">{payoutTime(payout.at, locale)}</span>
                <span className="payout-row__role">{reasonForPayout(payout, lookup, index)}</span>
                <span className="payout-row__amt">{usdFromBaseUnits(payout.amount)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <details className="more settle-details">
        <summary>{t.detailsSummary}</summary>
        <dl className="detail-list">
          <div>
            <dt>{t.detailPolicyHash}</dt>
            <dd className="mono">{shortHex(settlement.policyHash)}</dd>
          </div>
          {vault ? (
            <div>
              <dt>{t.detailVault}</dt>
              <dd>{explorerLink(explorer, 'address', vault)}</dd>
            </div>
          ) : null}
          <div>
            <dt>{t.detailRecipients}</dt>
            <dd>
              <ul className="detail-addrs">
                {recipients.map((recipient) => (
                  <li key={recipient.account}>{explorerLink(explorer, 'address', recipient.account)}</li>
                ))}
              </ul>
            </dd>
          </div>
          {settlement.txHash ? (
            <div>
              <dt>{t.detailTx}</dt>
              <dd>{explorerLink(explorer, 'tx', settlement.txHash)}</dd>
            </div>
          ) : null}
          {payouts.length ? (
            <div>
              <dt>{t.detailTx}</dt>
              <dd>
                <ul className="detail-addrs">
                  {payouts.slice(0, 5).map((payout) => (
                    <li key={payout.id}>{explorerLink(explorer, 'tx', payout.txHash)}</li>
                  ))}
                </ul>
              </dd>
            </div>
          ) : null}
        </dl>
      </details>
    </Screen>
  );
}
