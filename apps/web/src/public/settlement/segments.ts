import type { SettlementView } from '../../shared/api/firestore';
import { settlementCopy as t } from './copy';
import type { ReadableRecipient } from './format';

/** The segment colours of the share bar; the platform and the reserve get their own muted tones. */
const SEGMENT_COLORS = ['#836EF9', '#5B3FD9', '#0F7A5A', '#A0055D', '#8A5200', '#4C4877'];
const PLATFORM_COLOR = '#B9B3D6';
const RESERVE_COLOR = '#E3DEF7';

/** The tag the organiser editor gives the MONTI row (`organizer/settlement/settlementModel.ts`). */
const PLATFORM_TAG = 'platform';
const BPS_TOTAL = 10000;

export interface Segment {
  label: string;
  bps: number;
  amountCents: number;
  color: string;
}

/**
 * The share bar's rows. The saved policy already lists the platform as one of its recipients
 * (row 0 of the on-chain policy, tagged `platform`), so `platformBps` is only added on top for a
 * legacy policy whose recipients leave it out — otherwise the platform would be counted twice and
 * the bar would run past 100%. Whatever is left unassigned is the reserve.
 */
export function buildSegments(
  policy: SettlementView['policy'],
  recipients: ReadableRecipient[],
  ticketCents: number,
): Segment[] {
  const segments: Segment[] = recipients.map((recipient, index) => ({
    label: recipient.reason || recipient.tag || t.reasonFallback(index + 1),
    bps: recipient.bps,
    amountCents: (ticketCents * recipient.bps) / BPS_TOTAL,
    color:
      recipient.tag === PLATFORM_TAG
        ? PLATFORM_COLOR
        : (SEGMENT_COLORS[index % SEGMENT_COLORS.length] ?? PLATFORM_COLOR),
  }));
  const recipientBps = recipients.reduce((sum, recipient) => sum + recipient.bps, 0);
  const platformListed =
    recipients.some((recipient) => recipient.tag === PLATFORM_TAG) || recipientBps >= BPS_TOTAL;
  const extraPlatform = platformListed ? 0 : Math.max(0, policy.platformBps);
  if (extraPlatform > 0) {
    segments.push({
      label: t.platformLabel,
      bps: extraPlatform,
      amountCents: (ticketCents * extraPlatform) / BPS_TOTAL,
      color: PLATFORM_COLOR,
    });
  }
  const reserve = BPS_TOTAL - recipientBps - extraPlatform;
  if (reserve > 0) {
    segments.push({
      label: t.reserveLabel,
      bps: reserve,
      amountCents: (ticketCents * reserve) / BPS_TOTAL,
      color: RESERVE_COLOR,
    });
  }
  return segments;
}
