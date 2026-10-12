// The open manual-admission requests an approver can act on (P4).
//
// A manager without the approval right files a request through the backend (`requestOverride`),
// not the chain, so nothing on chain announces it. An approver learns of it here: while their
// approval dialog is open, the event's open requests are asked of `listOverrideRequests` every few
// seconds. Approving one is still the ordinary `manualOverride` relay; the backend marks the
// request approved when that lands, so it simply drops off the next poll.
//
// A poll rather than a Firestore listener because the list is the approver's view of other
// people's requests — the rules let a requester read only their own — and the callable is where
// the approval right is checked.
import { useEffect, useState } from 'react';

import type { OverrideReasonCode } from '@monti/shared';

import { api } from '../../shared/api/functions';
import { warn } from '../log';

/** How often the open requests are asked again while the dialog is open. */
export const OVERRIDE_REQUESTS_POLL_MS = 5_000;

/** One open request, in the shape the dialog draws it. */
export interface OpenOverrideRequest {
  id: string;
  tokenId: string;
  /** The gate the requester stands at — the approval is recorded there, not at this terminal. */
  gateId: string;
  reason: OverrideReasonCode;
  note?: string;
  /** The guest-list name for the ticket, or `''` (the dialog then says 게스트). */
  displayName: string;
}

/**
 * The open requests of `eventId`, polled while `active` (the dialog is open and this staff member
 * may approve). Inactive, it asks nothing and answers `[]`. A failed poll keeps the last list — a
 * blip in the venue's network should not make a waiting request vanish from the approver's screen.
 */
export function useOverrideRequests(
  eventId: bigint,
  active: boolean,
  nameOf: (tokenId: string) => string,
): readonly OpenOverrideRequest[] {
  const [requests, setRequests] = useState<readonly OpenOverrideRequest[]>([]);

  useEffect(() => {
    if (!active) {
      setRequests([]);
      return undefined;
    }
    let live = true;
    const poll = async (): Promise<void> => {
      try {
        const { requests: rows } = await api.listOverrideRequests({ eventId: eventId.toString() });
        if (!live) return;
        setRequests(
          rows.map((row) => ({
            id: row.id,
            tokenId: row.tokenId,
            gateId: row.gateId,
            reason: row.reason as OverrideReasonCode,
            ...(row.note ? { note: row.note } : {}),
            displayName: nameOf(row.tokenId),
          })),
        );
      } catch (error) {
        warn('override', 'could not list open requests', error);
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), OVERRIDE_REQUESTS_POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [active, eventId, nameOf]);

  return requests;
}
