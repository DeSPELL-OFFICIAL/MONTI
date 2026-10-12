import type { PolicyRecipientInput } from '@monti/shared';
import type { EventDraft } from '../../shared/api/firestore';
import { getConfig, settlementEnabled } from '../../shared/config';
import {
  parseSplit, platformBpsOf, toRecipients, validateRows, type RecipientRow, type Validation,
} from '../settlement/settlementModel';
import { eventProblems, isPaidDraft, priceUsdCentsOf, tierProblems } from './draftRules';

/**
 * Why 공개하기 is held, first one wins:
 *  - `draft`         a creation rule is broken (the fix is on 만들기, one link back);
 *  - `settlementOff` a paid kind, but this build has no settlement wiring (vault/token/platform);
 *  - `split`         a paid kind, and the split rules are not valid yet.
 */
export type PublishBlocker = '' | 'draft' | 'settlementOff' | 'split';

export interface PublishView {
  paid: boolean;
  /** Each kind as the confirm sheet lists it. */
  tiers: Array<{ name: string; priceUsdCents: number }>;
  /** The split rows the draft holds (the locked platform row first when none were set); `[]` when free. */
  rows: RecipientRow[];
  /** The split's validation; `null` for a free draft, which carries no policy. */
  split: Validation | null;
  /** A publish already sent (`submittedRelayId`) or landed (`createdEventId`): the button follows it. */
  resuming: boolean;
  blocker: PublishBlocker;
  publishable: boolean;
}

export interface PublishEnv {
  /** `VITE_ADDR_PLATFORM`, the MONTI row's account. */
  platformAccount: string | undefined;
  /** `settlementEnabled()`: the vault and the escrow token are both configured. */
  settlementOn: boolean;
  now: number;
}

/** This build's {@link PublishEnv}, read where the screen and the publish path need it. */
export function currentPublishEnv(now: number = Math.floor(Date.now() / 1_000)): PublishEnv {
  return { platformAccount: getConfig().addresses.platform, settlementOn: settlementEnabled(), now };
}

/**
 * The publish screen as one value: what the summary and the confirm sheet show, and whether
 * 공개하기 may be pressed. The split comes from the draft's `splitJson` — the same string the
 * editor writes — so what is validated here is exactly what the publish write will carry.
 */
export function publishView(draft: EventDraft, env: PublishEnv): PublishView {
  const paid = isPaidDraft(draft);
  const tiers = draft.tiers.map((tier) => ({ name: tier.name.trim(), priceUsdCents: priceUsdCentsOf(tier) }));
  const rows = paid ? parseSplit(draft.splitJson, env.platformAccount ?? '') : [];
  const split = paid ? validateRows(rows) : null;
  const resuming = draft.submittedRelayId !== '' || draft.createdEventId !== '';

  let blocker: PublishBlocker = '';
  if (eventProblems(draft, env.now).length > 0 || tierProblems(draft).length > 0) blocker = 'draft';
  else if (paid && (!env.settlementOn || env.platformAccount === undefined)) blocker = 'settlementOff';
  else if (split !== null && !split.ok) blocker = 'split';

  return { paid, tiers, rows, split, resuming, blocker, publishable: resuming || blocker === '' };
}

/** The policy half of the publish write: nothing for a free draft, the split rows for a paid one. */
export function publishSplit(
  draft: EventDraft,
  platformAccount: string,
): { recipients: PolicyRecipientInput[]; platformBps: number } {
  if (!isPaidDraft(draft)) return { recipients: [], platformBps: 0 };
  const rows = parseSplit(draft.splitJson, platformAccount);
  return { recipients: toRecipients(rows), platformBps: platformBpsOf(rows) };
}
