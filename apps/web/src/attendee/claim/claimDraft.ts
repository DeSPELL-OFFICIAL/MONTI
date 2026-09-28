import type { Hex } from 'viem';
import type { SubmittedOp } from '../../shared/chain/ops';

/**
 * The one claim this device has an operation in flight for, kept in sessionStorage so a refresh or
 * a deep-link return to `/claim/:id` picks up the op already sent instead of sending a second one
 * (plan T-SIMP-1 ①). It is the attendee mirror of the organiser's `submittedOpHash`/`submittedAt`
 * on the event draft — the same idea for one tab's lifetime, holding only the two facts a re-check
 * and a resend need. Nothing the chain or a callable owns lives here.
 */
export interface ClaimDraft {
  /** Which write is on its way, so a resend repeats the same one. */
  fn: 'claim' | 'requestClaim';
  /** The ticket type chosen, so a resend claims the same one. */
  tier: number;
  /** The operation this app already sent for it — what `resolveSubmittedOp` is asked about. */
  opHash: Hex;
  /** Epoch ms it was recorded, for `resolveSubmittedOp`'s stale-age test. */
  submittedAt: number;
}

/** One entry per event id: this screen has at most one claim in flight per event. */
const KEY = 'monti.claimDraft';

type Store = Record<string, ClaimDraft>;

function readStore(): Store {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Store) : {};
  } catch {
    // Private mode, a full quota, or a hand-edited value: behave as if nothing was stored.
    return {};
  }
}

function writeStore(store: Store): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    // The claim still runs this session; only the refresh-safe resume is lost.
  }
}

/** The claim in flight for this event, or `null` — an entry with no usable hash reads as none. */
export function readClaimDraft(eventId: string): ClaimDraft | null {
  const entry = readStore()[eventId];
  return entry !== undefined && typeof entry.opHash === 'string' && entry.opHash.length > 0 ? entry : null;
}

export function writeClaimDraft(eventId: string, draft: ClaimDraft): void {
  const store = readStore();
  store[eventId] = draft;
  writeStore(store);
}

export function clearClaimDraft(eventId: string): void {
  const store = readStore();
  if (eventId in store) {
    delete store[eventId];
    writeStore(store);
  }
}

/** Where a claim goes next once whatever the draft remembers has been accounted for. */
export type ClaimStep = 'send' | 'wait' | 'complete';

type Resolver = (userOpHash: Hex, submittedAt: number) => Promise<SubmittedOp>;

/**
 * The duplicate-safe gate, mirrored from the create/publish path (plan T-SIMP-1 ②). A claim that
 * already left an op behind is **never** blind-resent: the first thing this does when a hash exists
 * is ask the bundler what became of it.
 *
 *   - no draft → `send` (there is nothing in flight to duplicate);
 *   - landed   → `complete` (the ticket the person came for exists);
 *   - pending  → `wait` (it is still on its way — send nothing);
 *   - failed / stale → `send` (it will never land, so the same claim may go again at current fees).
 *
 * A bundler that cannot be reached is treated as `pending` here — the safe answer to "did my ticket
 * arrive?" is never "claim another one".
 */
export async function guardClaim(draft: ClaimDraft | null, resolve: Resolver): Promise<ClaimStep> {
  if (draft === null) return 'send';
  const submitted = await resolve(draft.opHash, draft.submittedAt).catch(
    () => ({ state: 'pending', logs: [] }) as SubmittedOp,
  );
  if (submitted.state === 'landed') return 'complete';
  if (submitted.state === 'pending') return 'wait';
  return 'send';
}
