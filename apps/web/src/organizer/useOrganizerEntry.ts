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
   * Where the 주최자 section on 프로필 goes. Somebody who belongs anywhere gets the organiser
   * home — it is a "manage" button, not a "make" one — and everybody else gets the same door
   * {@link to} would have given them, which is the creation scene itself.
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
 * | belongs to no organisation       | `/org/new`      | `/org/new`     |
 * | belongs, but may not create      | `/org`          | `/org`         |
 *
 * A visitor who is not signed in is routed to signing up rather than refused the button: a
 * founder testing with a fresh account has to be able to find the way in, which is the whole
 * reason this task exists. It costs them nothing either — {@link useMyOrgs} is enabled only
 * for a signed-in session, so a signed-out tap asks the indexer nothing at all.
 *
 * The last row needs no sentence of its own: `/org` already says `행사를 만들 권한이 없어요…`.
 *
 * The fifth row used to lead to `/org/become`, and that extra screen is exactly the second tap
 * the founder's phone test named (plan section B-4): making an organisation is not a thing
 * anybody sets out to do, it is a field on the way to an event. The creation scene asks for the
 * name inline and creates the organisation inside `만들기`, so `/org/become` is now only the
 * organiser home's way to a second or third organisation.
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
    if (orgs.length === 0) return { to: '/org/new', hasOrg: false, isLoading: false };
    return { to: '/org', hasOrg: true, isLoading: false };
  })();

  return { ...entry, profileTo: entry.hasOrg ? '/org' : entry.to };
}
