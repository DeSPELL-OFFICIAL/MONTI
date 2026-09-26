import { useSession } from '../shared/session';
import { useMyOrgs } from './useMyOrgs';

/** Where the 주최자 section on 프로필 leads, and what it says. */
export interface OrganizerEntry {
  /**
   * Where the 주최자 section on 프로필 goes. Somebody who organises for an organisation is taken
   * to the organiser home to manage what they already run; everybody else is offered the
   * creation scene, which asks for the organiser name inline (plan section B-4) rather than a
   * separate screen about organisations. The floating 만들기 on 탐색 is not decided here — it
   * always starts a new event (`attendee/discover/Discover.tsx`).
   */
  to: string;
  /**
   * Whether this person organises for at least one organisation. It chooses the section's label
   * — 내 행사 (manage) vs 주최자 되기 (make) — and, with it, {@link to}. False for the two
   * answers sure there is nothing to open — not signed in, and no organisation listed — and
   * while the indexer is still loading; true once the indexer lists one, and also when it will
   * not answer at all, because `/org` owns that failure and shows its own retry there.
   */
  hasOrg: boolean;
  /** The session or the indexer has been asked and has not answered yet. */
  isLoading: boolean;
}

/**
 * The way from 프로필 into the organiser side. It lives in its own module, apart from
 * {@link useMyOrgs}, so a test can drive every row of the table below by mocking that hook alone.
 *
 * The rows, in order:
 *
 * | state                            | 프로필         |
 * |----------------------------------|----------------|
 * | the session is re-hydrating      | (a spinner)    |
 * | not signed in                    | `/signup/phone`|
 * | the indexer is loading           | (a spinner)    |
 * | the indexer would not answer     | `/org`         |
 * | belongs to an organisation       | `/org`         |
 * | belongs to no organisation       | `/org/new`     |
 *
 * There used to be a second destination here, `to`≠`profileTo`, so that the same state could send
 * 탐색's 만들기 and 프로필 to different doors. It is gone: 만들기 always means "make an event"
 * and always opens the creation scene, so `Discover.tsx` no longer asks this hook anything, and
 * the one decision left is 프로필's own — manage what exists, or make the first thing.
 *
 * The re-hydration row is the one that must not regress: a reload re-hydrates the session as
 * 'loading' before it is known, and treating that as loading is what stops a signed-in organiser
 * being sent to `/signup/phone` in the seconds before the session resolves (S5). `useMyOrgs` is
 * asleep until the session is signed in, so a signed-out read asks the indexer nothing at all.
 */
export function useOrganizerEntry(): OrganizerEntry {
  const status = useSession().status;
  const { orgs, canCreateEvent, isLoading, isError } = useMyOrgs();

  if (status === 'loading') return { to: '/org', hasOrg: false, isLoading: true };
  if (status !== 'signedIn') return { to: '/signup/phone', hasOrg: false, isLoading: false };
  if (isLoading) return { to: '/org', hasOrg: false, isLoading: true };
  // Not knowing is not the same as knowing there is nothing: the organiser home owns a silent
  // indexer, so it is offered rather than `주최자 되기`.
  const hasOrg = isError || canCreateEvent || orgs.length > 0;
  return { to: hasOrg ? '/org' : '/org/new', hasOrg, isLoading: false };
}
