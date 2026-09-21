// OFFLINE ADMIT: the whole decision a gate with no internet is allowed to make.
//
// It is deliberately a *different* answer from the online green. The chain has not accepted
// this check-in; a queued transaction will ask it to, and it may still refuse (spec §12). A
// screen that could not tell the two apart would let a staff member believe a queued entry is
// settled, so the outcome is `offlineAdmit` — the gate state Task 14 froze for exactly this —
// and never `admit`.
//
// The rules are the ones the snapshot can answer on its own, plus the one signature check the
// terminal can do itself:
//
//  1. the gate's snapshot and the gate's code are the same event   → `WRONG_EVENT`
//  2. the guest list knows this ticket                             → `NO_TICKET`
//  3. it is not already used — in the snapshot, or in this device's own queue → `ALREADY_USED`
//  4. its device key has not been cleared                          → `DEVICE_LOCKED`
//  5. the attendee's phone signed *this* code with *that* key      → `DEVICE_MISMATCH`
//
// Every refusal is a code from `GATE_DENY_CODES`, because the attendee's phone is shown the
// sentence for the code this device picked and a word invented here is a blank screen there.
//
// What this cannot do is tell a revoked ticket from one issued since the last sync: neither is
// in the snapshot, and there is no chain to ask. Both are `NO_TICKET`. Online they are told
// apart by `Ticket.checkIn` and Task 22 maps them to `REVOKED` and an admit respectively — so
// an offline refusal here is a refusal *by this device*, which is what the override path
// (Task 30) exists for.
import { deviceKeyIn, lookupIn } from '../snapshot/lookup';
import { allEntries, enqueueCheckIn } from '../queue/opQueue';
import type { DenyCode, GateCodeWire, GateResponseWire, Hex, QueueEntry, SnapshotTicket } from '../types';
import { verifyDeviceSignatureOffline, type DeviceDigestDomain } from './offlineVerify';

import type { SnapshotWire } from '@monti/shared';

/**
 * The taps this device has already written down, as this module reads them: a token and the
 * code it answered. Task 28's `allEntries()` is the default; the port is structural so the
 * queue's row can grow without this file having an opinion about it.
 */
export type QueuedTaps = () => Promise<readonly { tokenId: string; gateCode: { nonce: Hex } }[]>;

/**
 * Task 28's `enqueueCheckIn`, which resolves only after IndexedDB has *committed* the row. The
 * offline card is drawn from that resolution: a phone that dies between the two cannot exist,
 * so either the attendee was not told they are in, or the record of them being in survived.
 */
export type EnqueueTap = (params: {
  code: GateCodeWire;
  response: GateResponseWire;
  orgId: bigint;
}) => Promise<QueueEntry>;

export type OfflineDecision =
  | { outcome: 'offlineAdmit'; ticket: SnapshotTicket; entry: QueueEntry; deny?: undefined }
  | { outcome: 'deny'; deny: DenyCode; ticket?: SnapshotTicket; entry?: undefined };

export interface OfflineAdmitParams {
  /** `snapshotStore().current()` — `undefined` before the first sync, which offline is a refusal. */
  snapshot: SnapshotWire | undefined;
  code: GateCodeWire;
  response: GateResponseWire;
  /** `Ticket.eventOrg(eventId)`, passed straight to the queue. */
  orgId: bigint;
  domain?: DeviceDigestDomain;
  enqueue?: EnqueueTap;
  queued?: QueuedTaps;
}

const refuse = (deny: DenyCode, ticket?: SnapshotTicket): OfflineDecision => ({ outcome: 'deny', deny, ticket });

/**
 * The offline verdict, and the durable write that has to survive it.
 *
 * Order matters twice. The cheap local facts are read before the signature, so a ticket that is
 * already used costs no cryptography. And the signature is verified before the enqueue, so
 * nothing this device cannot prove ever reaches the queue — the queue is what the chain is
 * eventually told, and an unverified row there is a check-in the gate invented.
 *
 * A failed enqueue is *not* caught: a tap that could not be written down has not been admitted,
 * and the caller must show the refusal rather than a card for a record that does not exist.
 */
export async function offlineAdmit(params: OfflineAdmitParams): Promise<OfflineDecision> {
  const { snapshot, code, response, orgId, domain } = params;
  const enqueue = params.enqueue ?? enqueueCheckIn;
  const queued = params.queued ?? allEntries;

  // No guest list at all. Online the chain decides; here there is nothing to decide with, and
  // an admit would be an admit on the attendee's word alone.
  if (!snapshot) return refuse('NO_TICKET');
  if (snapshot.eventId !== code.eventId) return refuse('WRONG_EVENT');

  const found = lookupIn(snapshot, response.tokenId);
  if (!found.known) return refuse('NO_TICKET');
  // `ALREADY_USED` / `DEVICE_LOCKED`, decided by `snapshotDeny` — the same rules `preflight`
  // reads, so the online and offline paths cannot come to disagree about one snapshot row.
  if (found.deny) return refuse(found.deny, found.ticket);

  // The replay this device can see: the same ticket, admitted here under a different code. The
  // *same* code is not a replay — one NFC presentation read twice is one row (the queue keys on
  // `${tokenId}-${nonce}`), and refusing it would flash a red at someone already walking in.
  const rows = await queued();
  if (rows.some((row) => row.tokenId === response.tokenId && row.gateCode.nonce !== code.nonce)) {
    return refuse('ALREADY_USED', found.ticket);
  }

  const verified = await verifyDeviceSignatureOffline({
    deviceKey: deviceKeyIn(snapshot, response.tokenId),
    code,
    response,
    domain,
  });
  if (!verified) return refuse('DEVICE_MISMATCH', found.ticket);

  const entry = await enqueue({ code, response, orgId });
  return { outcome: 'offlineAdmit', ticket: found.ticket, entry };
}
