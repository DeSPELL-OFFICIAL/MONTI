import { useSession } from '../shared/session';
import { useMyOrgs } from './useMyOrgs';

/** Where the two attendee entry points into the organiser side lead, and what they say. */
export interface OrganizerEntry {
  /**
   * Where the floating `만들기` on 탐색 goes. It is a "make an event" button, so it skips the
   * organiser home whenever that is possible.
   */
  to: string;
  /**
   * Where the 주최자 section on 프로필 goes. It is a "manage" button, not a "make" one, so it
   * never lands in the creation scene: somebody who belongs anywhere gets the organiser home, and
   * everybody else gets the same door {@link to} would have given them.
   */
  profileTo: string;
  /**
   * Whether to offer the door into the organiser screens rather than `주최자 되기`. False for
   * the two answers that are sure there is nothing to open — somebody who is not signed in,
   * and somebody the indexer listed no organisation for. An indexer that said nothing at all
   * is not one of them: `/org` owns that failure and shows its own retry there.
   */
  hasOrg: boolean;
  /** The indexer has been asked and has not answered yet, so nothing above is known. */
  isLoading: boolean;
}

/**
 * The one decision behind both attendee entry points into the organiser side — the floating
 * `만들기` on 탐색 and the 주최자 section on 프로필. It lives in its own module, apart from
 * {@link useMyOrgs}, so that the two screens cannot drift apart and so a test can drive every
 * row of the table below by mocking that hook alone.
 *
 * The rows, in order:
 *
 * | state                            | 만들기          | 프로필         |
 * |----------------------------------|-----------------|----------------|
 * | not signed in                    | `/signup/phone` | `/signup/phone`|
 * | the indexer is loading           | `/org`          | (a spinner)    |
 * | the indexer would not answer     | `/org`          | `/org`         |
 * | may create an event somewhere    | `/org/new`      | `/org`         |
 * | belongs to no organisation       | `/org/become`   | `/org/become`  |
 * | belongs, but may not create      | `/org`          | `/org`         |
 *
 * A visitor who is not signed in is routed to signing up rather than refused the button: a
 * founder testing with a fresh account has to be able to find the way in, which is the whole
 * reason this task exists. It costs them nothing either — {@link useMyOrgs} is enabled only
 * for a signed-in session, so a signed-out tap asks the indexer nothing at all.
 *
 * The last row needs no sentence of its own: `/org` already says `행사를 만들 권한이 없어요…`.
 */
export function useOrganizerEntry(): OrganizerEntry {
  const signedIn = useSession().status === 'signedIn';
  const { orgs, canCreateEvent, isLoading, isError } = useMyOrgs();

  const entry = ((): Omit<OrganizerEntry, 'profileTo'> => {
    if (!signedIn) return { to: '/signup/phone', hasOrg: false, isLoading: false };
    if (isLoading) return { to: '/org', hasOrg: false, isLoading: true };
    // Not knowing is not the same as knowing there is nothing: the organiser home is the
    // screen that owns a silent indexer, so it is offered rather than `주최사 만들기`.
    if (isError) return { to: '/org', hasOrg: true, isLoading: false };
    if (canCreateEvent) return { to: '/org/new', hasOrg: true, isLoading: false };
    if (orgs.length === 0) return { to: '/org/become', hasOrg: false, isLoading: false };
    return { to: '/org', hasOrg: true, isLoading: false };
  })();

  return { ...entry, profileTo: entry.hasOrg ? '/org' : entry.to };
}
