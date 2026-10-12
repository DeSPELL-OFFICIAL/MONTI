import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { hexToString, type Hex } from 'viem';
import { Card, Spinner } from '../../shared/ui';
import { settlementEnabled } from '../../shared/config';
import { getSettlement, type SettlementView } from '../../shared/api/firestore';
import { readChainPolicy, type ChainPolicy } from '../../shared/chain/settlementReads';
import { formatUsdCents } from '../../shared/money';
import { useOrganizerCopy } from '../copy';
import { bpsToPercent } from './settlementModel';

/** The event tiers the price lines are keyed to; `priceUsdCents` is the chain's, when known. */
export interface SettlementTier {
  id: string;
  name: string;
  priceUsdCents?: string;
}

export interface SettlementSectionProps {
  eventId: string;
  tiers: SettlementTier[];
}

interface Line {
  label: string;
  bps: number;
}

/** A `bytes32` tag back to its text (`tagToBytes32` right-pads with zeros). */
function tagText(tag: Hex): string {
  try {
    return hexToString(tag, { size: 32 }).replace(/\0+$/, '');
  } catch {
    return '';
  }
}

/**
 * The split, as the reader of a published event can see it. v2 freezes the policy in the same
 * write that publishes the event (design D2), so there is nothing to edit here — this is the
 * read-only summary: the per-tier prices and each recipient's share, from the server mirror
 * (`settlements/{eventId}`, which keeps the readable reasons) and from the chain while the mirror
 * has not been written. A free event has no policy and draws nothing.
 */
export function SettlementSection({ eventId, tiers }: SettlementSectionProps) {
  const copy = useOrganizerCopy().settlement;
  const enabled = settlementEnabled();
  const [loading, setLoading] = useState(true);
  const [mirror, setMirror] = useState<SettlementView | null>(null);
  const [chain, setChain] = useState<ChainPolicy | null>(null);

  useEffect(() => {
    if (!enabled || eventId === '') {
      setLoading(false);
      return undefined;
    }
    let live = true;
    void (async () => {
      const [settle, policy] = await Promise.all([
        getSettlement(eventId),
        readChainPolicy(BigInt(eventId)).catch(() => null),
      ]);
      if (!live) return;
      setMirror(settle);
      setChain(policy);
      setLoading(false);
    })();
    return () => {
      live = false;
    };
  }, [enabled, eventId]);

  if (!enabled) return null;
  if (loading) return <Card title={copy.title}><Spinner /></Card>;

  const lines: Line[] = mirror !== null
    ? mirror.policy.recipients.map((r) => ({ label: r.reason || r.tag, bps: r.bps }))
    : (chain?.recipients ?? []).map((r) => ({ label: tagText(r.tag), bps: r.bps }));
  // No recipients anywhere: a free event, which carries no policy.
  if (lines.length === 0) return null;

  const prices = tiers.flatMap((tier, index) => {
    const mirrored = mirror?.priceUsdCentsByTier?.[String(index)];
    const cents = mirrored ?? (tier.priceUsdCents === undefined ? undefined : Number(tier.priceUsdCents));
    return cents === undefined || cents === 0 ? [] : [{ id: tier.id, name: tier.name, cents }];
  });

  return (
    <Card title={copy.title}>
      <div className="settlement-head">
        <span className="chip chip--test">{copy.testBadge}</span>
      </div>
      <p className="muted">{copy.intro}</p>
      {prices.length > 0 ? (
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {prices.map((price) => <li key={price.id}>{price.name} · {formatUsdCents(price.cents)}</li>)}
        </ul>
      ) : null}
      <h3>{copy.splitHeading}</h3>
      <ul style={{ listStyle: 'none', padding: 0 }}>
        {lines.map((line, i) => <li key={i}>{line.label} · {bpsToPercent(line.bps)}%</li>)}
      </ul>
      <p className="muted">{copy.frozenNote}</p>
      <Link to={`/settlement/${eventId}`} className="btn btn--primary btn--link">{copy.publicLink}</Link>
    </Card>
  );
}
