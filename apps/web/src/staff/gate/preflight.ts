// What the signed snapshot alone can say about a tap, before any chain call is made.
//
// This exists to spend fewer transactions and to put a refusal on screen in milliseconds rather
// than seconds (spec §7.2-5). It is **not** a verdict. Nothing here turns a tap green: only the
// chain (Task 24) or the offline path (Task 27) admits anybody, and a preflight that passed is
// only a check-in worth sending.
//
// The asymmetry is deliberate and is the whole design. A snapshot that says "denied" is trusted
// — it was signed by the attester and the facts it carries (this ticket is already used, this
// is another event's ticket) do not become false while the gate holds it. A snapshot that says
// "I have never heard of this token" is NOT trusted, because it may simply be stale: the
// attendee could have been issued the ticket after the last sync. So an unknown token is sent
// to the chain anyway and the chain decides. Offline there is no chain to ask and no device key
// to verify against, so there the same answer is a refusal — see `isUnknownToSnapshot`.
import { doc, getDoc } from 'firebase/firestore';

import type { GateCodeWire, GateResponseWire, SnapshotWire } from '@monti/shared';

import { getDb } from '../../shared/api/firebase';
import { snapshotDeny } from '../snapshot/lookup';
import type { DenyCode, PreflightResult, SnapshotTicket } from '../types';

/**
 * The slice of Task 25's snapshot store this module needs, declared here so preflight can be
 * written and tested before that store exists. Task 25 implements it; nothing else about the
 * store — refresh, signature verification, IndexedDB — belongs in this interface, because
 * nothing else about it changes what a preflight answers.
 */
export interface SnapshotStore {
  /** The snapshot this gate is running on, or `undefined` before the first sync lands. */
  current(): SnapshotWire | undefined;
}

/**
 * The test double. The gate is handed the real one — `snapshotStore()` in
 * `staff/snapshot/store.ts` (Task 25) — and a store built here has no snapshot unless a test
 * hands it one, which is exactly the state a gate boots in: the "no snapshot yet" branch below
 * is the branch that runs first in real life, not an edge case.
 */
export function stubSnapshotStore(snapshot?: SnapshotWire): SnapshotStore {
  return { current: () => snapshot };
}

export interface PreflightParams {
  /** `SnapshotStore.current()`. `undefined` is a gate that has not synced yet, not an error. */
  snapshot: SnapshotWire | undefined;
  /** The code this answer names — `matchIssuedCode` (Task 19) resolved it from the nonce. */
  code: GateCodeWire;
  response: GateResponseWire;
}

/**
 * Mirrors the checks `Ticket.checkIn` makes on chain (spec §7.2-6 ①~⑤) against the local
 * snapshot. The clock checks are not repeated here: Task 19's `matchIssuedCode` already applied
 * `isGateCodeFresh`, which is the chain's own window, and a second reading of it in a second
 * place is how the gate and the chain come to disagree about who may walk in.
 */
export function preflight({ snapshot, code, response }: PreflightParams): PreflightResult {
  // No snapshot yet. Refusing everyone would close the door on the gate's first minutes; the
  // chain is reachable or the offline path will refuse, and neither needs help from here.
  if (!snapshot) return { ok: true };

  // The gate's own code and the gate's own snapshot disagree about which event this door is.
  // That is a setup mistake rather than a bad ticket, but it is still a refusal: a check-in
  // sent from here could only revert `WrongEvent`, and staff need to see the same word twice.
  if (snapshot.eventId !== code.eventId) return { ok: false, deny: 'WRONG_EVENT' };

  const ticket = snapshot.tickets.find((entry) => entry.tokenId === response.tokenId);

  // Not in the snapshot. Possibly revoked, possibly another event's, possibly issued since the
  // last sync — the snapshot carries no `revoked` flag, so all three look identical here. The
  // chain can tell them apart (`TicketRevoked`, `WrongEvent`, or an admit) and this cannot.
  if (!ticket) return { ok: true };

  // `ALREADY_USED` and `DEVICE_LOCKED` — the rules the row alone justifies, decided by the
  // snapshot module (Task 25) rather than a second time here. Task 27's offline path reads the
  // same function, so the online and the offline door cannot come to disagree about one row.
  const deny = snapshotDeny(ticket);
  if (deny) return { ok: false, deny, ticket };

  return { ok: true, ticket };
}

/**
 * The third answer, spelled out: the snapshot passed the tap on without recognising it.
 *
 * Online that means "send it, the chain decides". Offline it means a refusal, and not because
 * of a policy choice — there is literally nothing to check the `deviceSig` against, so an
 * offline admit here would be an admit on the attendee's word alone.
 */
export function isUnknownToSnapshot(result: PreflightResult): boolean {
  return result.ok && result.ticket === undefined;
}

/** The ticket a passed preflight recognised, for the screen to draw. `undefined` if unknown. */
export function recognisedTicket(result: PreflightResult): SnapshotTicket | undefined {
  return result.ok ? result.ticket : undefined;
}

/**
 * The ~1 s cross-gate window (design §6). Two online gates can both start admitting one ticket
 * before either check-in is mined; the chain's one-time entry closes that window about a second
 * later, and the pending table closes it now. A gate whose `passing` mark is older than this is a
 * check-in that never confirmed, and blocking on it would turn a real attendee away for good.
 */
export const ADMISSION_DUPLICATE_WINDOW_MS = 8_000;

/** A Firestore `Timestamp` (or a millis number) to millis; 0 for a value that has not settled. */
function toMillis(value: unknown): number {
  if (typeof value === 'number') return value;
  const stamp = value as { toMillis?: () => number } | null;
  return typeof stamp?.toMillis === 'function' ? stamp.toMillis() : 0;
}

export interface AdmissionsDuplicateParams {
  /** Decimal, as the code carries it: `code.eventId`. */
  eventId: string;
  /** The token the answer names: `response.tokenId`. */
  tokenId: string;
  now?: number;
}

/**
 * Whether another gate is already admitting this ticket, read from
 * `admissions/{eventId}/tokens/{tokenId}` before PASS. A `confirmed` mark is a check-in the chain
 * has recorded — always a duplicate. A `passing` mark is one in flight, so it only counts inside
 * {@link ADMISSION_DUPLICATE_WINDOW_MS}: past it the check-in never landed and the mark is stale.
 * Either way the refusal reuses `ALREADY_USED` ("이미 입장"), the same word the chain's own
 * `AlreadyCheckedIn` becomes.
 *
 * It is a latency optimisation, never the boundary. A read that fails or a document that is not
 * there is **not** a duplicate — `undefined` — because the chain's one-time entry is the authority
 * and a Firestore blip must not turn a real attendee away. The offline path never calls it: an
 * offline gate cannot read the table, and its own snapshot/queue check stands unchanged.
 */
export async function admissionsDuplicate(
  params: AdmissionsDuplicateParams,
): Promise<{ deny: DenyCode } | undefined> {
  try {
    const snapshot = await getDoc(doc(getDb(), 'admissions', params.eventId, 'tokens', params.tokenId)); // copy-lint-ignore: Firestore path, not copy
    const data = snapshot.data() as { status?: string; passedAt?: unknown } | undefined;
    if (!data) return undefined;
    if (data.status === 'confirmed') return { deny: 'ALREADY_USED' };
    if (data.status !== 'passing') return undefined;
    const now = params.now ?? Date.now();
    const passedAt = toMillis(data.passedAt);
    if (passedAt > 0 && now - passedAt > ADMISSION_DUPLICATE_WINDOW_MS) return undefined;
    return { deny: 'ALREADY_USED' };
  } catch {
    // Unreadable is not a duplicate: send it, the chain decides.
    return undefined;
  }
}
