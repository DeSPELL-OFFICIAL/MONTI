import { BPS_TOTAL, DEFAULT_PLATFORM_BPS, type Hex } from '@monti/shared';
import type { PolicyRecipientForm } from './buildPolicyAuth';

/**
 * One row of the revenue-split editor. `name` is the organiser's human label (역할/이름) and
 * becomes the on-chain `reason`, which is what the attendee receipt reads back as the role; `tag`
 * is the short classification the vault stores beside it. The MONTI platform row is `platform`:
 * its account and tag are locked (the backend recognises the tag `platform`), only its share is
 * editable and never below the 5% floor.
 */
export interface RecipientRow {
  id: string;
  name: string;
  account: string;
  bps: number;
  tag: string;
  platform?: boolean;
}

/** The tag the vault matches to recognise the platform-fee row (`SettlementVault.TAG_PLATFORM`). */
export const PLATFORM_TAG = 'platform';

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

let seq = 0;
/** A stable-enough id for React keys; order, not identity, is what the policy cares about. */
export function newRowId(): string {
  seq += 1;
  return `row-${Date.now().toString(36)}-${seq.toString(36)}`;
}

/** The fixed MONTI platform row, 5% by default, pointing at the configured platform wallet. */
export function platformRow(account: string): RecipientRow {
  return { id: 'platform', name: 'MONTI 플랫폼', account, bps: DEFAULT_PLATFORM_BPS, tag: PLATFORM_TAG, platform: true };
}

export function blankRow(): RecipientRow {
  return { id: newRowId(), name: '', account: '', bps: 0, tag: '' };
}

export interface Validation {
  ok: boolean;
  sumBps: number;
  /** The first problem as a code, so the view owns the sentence. `''` when the split is valid. */
  error: '' | 'EMPTY' | 'BAD_ACCOUNT' | 'BAD_BPS' | 'PLATFORM_LOW' | 'BAD_SUM';
}

/** The split is sendable only when every account is valid, every share positive, and the sum is 100%. */
export function validateRows(rows: RecipientRow[]): Validation {
  const sumBps = rows.reduce((acc, r) => acc + (Number.isFinite(r.bps) ? r.bps : 0), 0);
  if (rows.length === 0) return { ok: false, sumBps, error: 'EMPTY' };
  for (const r of rows) {
    if (!ADDRESS_RE.test(r.account)) return { ok: false, sumBps, error: 'BAD_ACCOUNT' };
    if (!Number.isInteger(r.bps) || r.bps <= 0 || r.bps > BPS_TOTAL) return { ok: false, sumBps, error: 'BAD_BPS' };
  }
  const platform = rows.find((r) => r.platform);
  if (platform !== undefined && platform.bps < DEFAULT_PLATFORM_BPS) {
    return { ok: false, sumBps, error: 'PLATFORM_LOW' };
  }
  if (sumBps !== BPS_TOTAL) return { ok: false, sumBps, error: 'BAD_SUM' };
  return { ok: true, sumBps, error: '' };
}

/** The platform mirror the vault validates: the summed bps of every `platform`-tagged row. */
export function platformBpsOf(rows: RecipientRow[]): number {
  return rows.filter((r) => r.tag === PLATFORM_TAG).reduce((acc, r) => acc + r.bps, 0);
}

/** The editor rows as the `relaySetPolicy` recipient payload (role label → `reason`). */
export function toRecipients(rows: RecipientRow[]): PolicyRecipientForm[] {
  return rows.map((r) => ({ account: r.account as Hex, bps: r.bps, reason: r.name, tag: r.tag }));
}

/**
 * Each recipient's cut of an example ticket priced at `cents`, split by bps the way the vault does
 * — floor each share and give the last row the rounding dust, so the parts always sum to the whole.
 */
export function exampleSplit(rows: RecipientRow[], cents: number): { name: string; cents: number }[] {
  const out: { name: string; cents: number }[] = [];
  let distributed = 0;
  rows.forEach((r, i) => {
    const share = i === rows.length - 1 ? cents - distributed : Math.floor((cents * r.bps) / BPS_TOTAL);
    distributed += share;
    out.push({ name: r.name || r.tag || 'MONTI', cents: share });
  });
  return out;
}

/** `500` → `"5"`, `750` → `"7.5"`. Basis points to a trimmed percent string for display. */
export function bpsToPercent(bps: number): string {
  const pct = bps / 100;
  if (Number.isInteger(pct)) return String(pct);
  return pct.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

/** `"5"` → `500`, `"7.5"` → `750`. A percent the organiser typed to basis points, or `null`. */
export function percentToBps(input: string): number | null {
  const t = input.trim();
  if (t === '' || !/^\d+(\.\d{0,2})?$/.test(t)) return null;
  const pct = Number(t);
  if (!Number.isFinite(pct) || pct <= 0 || pct > 100) return null;
  return Math.round(pct * 100);
}
