// Whether a snapshot the backend handed us is one we are allowed to open a door on.
//
// Two questions, in this order, and both answered **before** a single byte reaches IndexedDB:
//
//  1. Is it within the caps sub-plan 02 issues within? A snapshot over them did not come from
//     our backend, and answering question 2 first would mean hashing megabytes of a stranger's
//     JSON to find that out.
//  2. Did the attester sign exactly these bytes?
//
// The bytes in question are produced by `@monti/shared`'s `canonicalJson`, which is the **only**
// implementation of that rule anywhere in this repo — the issuer (`functions/src/functions/
// snapshot.ts`) hashes the same function's output. Re-implementing the canonicaliser here would
// not fail loudly; it would fail on one snapshot, months from now, at a door.
import { recoverAddress } from 'viem';

import { attesterAddress, snapshotDigest, type SnapshotWire, type UnsignedSnapshot } from '@monti/shared';

import { getConfig } from '../../shared/config';

/**
 * Sub-plan 02's three caps, mirrored (`SNAPSHOT_MAX_TICKETS`, `SNAPSHOT_MAX_PHOTO_BYTES` —
 * itself `PORTRAIT_MAX_BASE64_BYTES` — and `SNAPSHOT_MAX_BYTES` in
 * `functions/src/functions/snapshot.ts`). The backend *refuses to issue* anything past them, so
 * on this side they are not a policy: they are the shape of the only snapshot that can be ours.
 */
export const SNAPSHOT_MAX_TICKETS = 500;
/** base64 length of one face photo. A snapshot's photos are its whole weight. */
export const SNAPSHOT_MAX_PHOTO_BASE64_BYTES = 32 * 1024;
/** The serialised body, in UTF-8 bytes. Comfortably under the callable's own 10 MB answer. */
export const SNAPSHOT_MAX_BYTES = 8 * 1024 * 1024;

/** Why a snapshot was refused. Both are refusals of the *document*, never of an attendee. */
export type SnapshotRejection = 'SNAPSHOT_BAD_SIG' | 'SNAPSHOT_TOO_LARGE';

/**
 * A typed refusal so the caller can tell "this is not our snapshot" from "the network is down".
 * The second keeps the gate running on the snapshot it already has; the first is a deployment
 * fault (a rotated attester, a wrong chain id) that a staff member has to be told about.
 */
export class SnapshotError extends Error {
  readonly code: SnapshotRejection;

  constructor(code: SnapshotRejection) {
    super(code);
    this.name = 'SnapshotError';
    this.code = code;
  }
}

/**
 * `snapshotDigest` hashes the object **without** `attesterSig` — and refuses one that still
 * carries it — so the signature is stripped here rather than at each call site.
 */
export function snapshotBody(snapshot: SnapshotWire): UnsignedSnapshot {
  const { attesterSig: _signature, ...body } = snapshot;
  return body;
}

const utf8Bytes = (value: string): number => new TextEncoder().encode(value).length;

/**
 * Measured on the same value the issuer measured: the unsigned body, in UTF-8 bytes. String
 * length would read a Korean event title at a third of its real weight.
 */
export function snapshotFitsCaps(snapshot: UnsignedSnapshot): boolean {
  if (snapshot.tickets.length > SNAPSHOT_MAX_TICKETS) return false;
  for (const ticket of snapshot.tickets) {
    if (ticket.photoJpegB64.length > SNAPSHOT_MAX_PHOTO_BASE64_BYTES) return false;
  }
  return utf8Bytes(JSON.stringify(snapshot)) <= SNAPSHOT_MAX_BYTES;
}

/**
 * Recovers the secp256k1 signer of `keccak256(canonicalJson(body))` and compares it with the
 * attester address in the deployments file for the chain this build is pointed at
 * (`packages/shared/src/deployments/<chainId>.json`, the same bytes the contracts deployed
 * with). It is read from the file rather than from `Identity.attester()` on purpose: a gate
 * verifies snapshots with no network, so the answer cannot be an `eth_call`.
 *
 * Every failure — a wrong signer, unreadable signature bytes, a body that will not canonicalise
 * — is `false`. A door must not be held open by an exception escaping this function.
 */
export async function verifySnapshot(snapshot: SnapshotWire): Promise<boolean> {
  try {
    const recovered = await recoverAddress({
      hash: snapshotDigest(snapshotBody(snapshot)),
      signature: snapshot.attesterSig,
    });
    return recovered.toLowerCase() === attesterAddress(getConfig().chainId).toLowerCase();
  } catch {
    return false;
  }
}
