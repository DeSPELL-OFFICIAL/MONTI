import { BPS_TOTAL, DEFAULT_PLATFORM_BPS, type Hex, type PolicyRecipientInput } from '@monti/shared';

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

/** The vault's recipient limit (`_validatePolicy`: 1–10). */
export const MAX_RECIPIENTS = 10;
/** The relayer's cap on each reason (`relayAction` `reasons[]`, ≤80 chars each). */
export const MAX_ROLE_NAME_CHARS = 80;
/** A tag goes on chain as `bytes32` (`tagToBytes32`), so its UTF-8 must fit in 32 bytes. */
const MAX_TAG_BYTES = 32;

export type SplitError =
  | '' | 'EMPTY' | 'TOO_MANY' | 'BAD_ACCOUNT' | 'BAD_BPS' | 'NAME_TOO_LONG' | 'BAD_TAG'
  | 'PLATFORM_LOW' | 'BAD_SUM';

export interface Validation {
  ok: boolean;
  sumBps: number;
  /** The first problem as a code, so the view owns the sentence. `''` when the split is valid. */
  error: SplitError;
}

/**
 * The split is publishable only when every account is valid, every share positive, the names
 * and tags fit what the relayer and the vault take, and the sum is 100%. Within these limits
 * the serialised split always fits the draft rule's 4,000-character cap, so that needs no rule
 * of its own.
 */
export function validateRows(rows: RecipientRow[]): Validation {
  const sumBps = rows.reduce((acc, r) => acc + (Number.isFinite(r.bps) ? r.bps : 0), 0);
  if (rows.length === 0) return { ok: false, sumBps, error: 'EMPTY' };
  if (rows.length > MAX_RECIPIENTS) return { ok: false, sumBps, error: 'TOO_MANY' };
  for (const r of rows) {
    if (!ADDRESS_RE.test(r.account)) return { ok: false, sumBps, error: 'BAD_ACCOUNT' };
    if (!Number.isInteger(r.bps) || r.bps <= 0 || r.bps > BPS_TOTAL) return { ok: false, sumBps, error: 'BAD_BPS' };
    if ([...r.name].length > MAX_ROLE_NAME_CHARS) return { ok: false, sumBps, error: 'NAME_TOO_LONG' };
    if (new TextEncoder().encode(r.tag).length > MAX_TAG_BYTES) return { ok: false, sumBps, error: 'BAD_TAG' };
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

/** The editor rows as policy recipients (role label → `reason`), in row order. */
export function toRecipients(rows: RecipientRow[]): PolicyRecipientInput[] {
  return rows.map((r) => ({ account: r.account as Hex, bps: r.bps, reason: r.name, tag: r.tag }));
}

/** One row as `eventDrafts/{uid}/drafts/{id}.splitJson` stores it — the row minus its React id. */
interface StoredRow {
  name: string;
  account: string;
  bps: number;
  tag: string;
  platform: boolean;
}

/** The rows as the draft's `splitJson` string. */
export function serializeSplit(rows: RecipientRow[]): string {
  const stored: StoredRow[] = rows.map((r) => ({
    name: r.name, account: r.account, bps: r.bps, tag: r.tag, platform: r.platform === true,
  }));
  return JSON.stringify(stored);
}

function toStoredRow(raw: unknown): StoredRow | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { name, account, bps, tag, platform } = raw as Record<string, unknown>;
  return {
    name: typeof name === 'string' ? name : '',
    account: typeof account === 'string' ? account : '',
    bps: typeof bps === 'number' && Number.isFinite(bps) ? bps : 0,
    tag: typeof tag === 'string' ? tag : '',
    platform: platform === true,
  };
}

/**
 * The draft's `splitJson` back as editor rows. Anything unreadable starts over from the one
 * locked platform row. The platform row always points at the configured MONTI account (only its
 * share is the organiser's), and one is added in front when the stored split has none.
 */
export function parseSplit(json: string, platformAccount: string): RecipientRow[] {
  let parsed: unknown = null;
  try {
    parsed = json === '' ? null : JSON.parse(json);
  } catch {
    parsed = null;
  }
  const stored = Array.isArray(parsed)
    ? parsed.map(toStoredRow).filter((row): row is StoredRow => row !== null)
    : [];
  const rows: RecipientRow[] = stored.map((row) => (row.platform
    ? { ...platformRow(platformAccount), bps: row.bps }
    : { id: newRowId(), name: row.name, account: row.account, bps: row.bps, tag: row.tag, platform: false }));
  return rows.some((row) => row.platform) ? rows : [platformRow(platformAccount), ...rows];
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
