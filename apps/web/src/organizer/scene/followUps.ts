import { api } from '../../shared/api/functions';
import type { EventDraft } from '../../shared/api/firestore';
import type { TicketArtSource } from '../../shared/ui';
import { tierArt } from './draftRules';

/**
 * The two writes that can only happen once the chain has named the event, and the record of
 * which of them have landed.
 *
 * They are kept apart from the publish hook because the done screen has to be able to run them
 * again. Both callables **replace** their document rather than merging into it, so running one
 * a second time is the same as running it once — which is what makes a retry button safe.
 *
 * The plan is everything they need, so it survives a navigation: by the time the done screen
 * is open the scene that held the draft is gone.
 */
export interface FollowUpPlan {
  eventId: string;
  /** In tier-index order; the index is `Tier.idx`. */
  tiers: TicketArtSource[];
  /** The real venue when the organiser hid it, or `null` when there is nothing private. */
  venue: string | null;
}

export interface FollowUpResult {
  artSaved: boolean;
  venueSaved: boolean;
}

export const NOTHING_SAVED: FollowUpResult = { artSaved: false, venueSaved: false };

export function followUpPlan(draft: EventDraft, eventId: string): FollowUpPlan {
  return {
    eventId,
    tiers: draft.tiers.map(tierArt),
    venue: draft.venueHidden ? draft.venue.trim() : null,
  };
}

/** True when there is nothing left to write — the only condition the draft may be deleted on. */
export function followUpsDone(plan: FollowUpPlan, result: FollowUpResult): boolean {
  return result.artSaved && (plan.venue === null || result.venueSaved);
}

/**
 * Runs only what has not landed yet, and reports what has. Each write is tried on its own, so
 * a refused `saveEventArt` does not take `setEventPrivate` down with it — the venue is the one
 * of the two whose words exist nowhere else once the draft is gone.
 *
 * It never throws: a caller that has already created an event on chain cannot be handed an
 * exception, only a record of what is still missing.
 */
export async function runFollowUps(
  plan: FollowUpPlan,
  done: FollowUpResult = NOTHING_SAVED,
): Promise<FollowUpResult> {
  let { artSaved, venueSaved } = done;
  if (!artSaved) {
    try {
      await api.saveEventArt({ eventId: plan.eventId, tiers: plan.tiers });
      artSaved = true;
    } catch {
      artSaved = false;
    }
  }
  if (plan.venue !== null && !venueSaved) {
    try {
      // The call does not merge: leaving `venue` out would erase it, so it always goes.
      await api.setEventPrivate({ eventId: plan.eventId, venue: plan.venue });
      venueSaved = true;
    } catch {
      venueSaved = false;
    }
  }
  return { artSaved, venueSaved };
}
