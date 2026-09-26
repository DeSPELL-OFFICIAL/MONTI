import { useCallback, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { loadOrgName } from '../shared/api/firestore';
import { PERM_APPROVE_CLAIM, PERM_CREATE_EVENT } from '../shared/chain/permissions';
import { gql } from '../shared/envio/client';
import {
  MY_ORGS_QUERY,
  ORG_EVENTS_QUERY,
  type EnvioAdmin,
  type EnvioEvent,
  type EnvioManager,
  type EnvioOrganizer,
} from '../shared/envio/queries';
import { fmt } from '../shared/i18n';
import { useSession } from '../shared/session';
import { useOrganizerCopy } from './copy';

/**
 * What the indexer knows about the signed-in person as an organiser. Ownership, admin bits and
 * manager rows are all chain state, so the indexer is the source for every field here but the
 * name — the chain has no room for one, and {@link loadOrgName} reads it from Firestore.
 */
export interface MyOrg {
  orgId: string;
  /** From `orgProfiles/{orgId}`, or `주최사 #<id>` when that document does not exist. */
  name: string;
  role: 'owner' | 'admin' | 'manager';
  /** `Admin.bits`; 0 for an owner (the contract gives an owner everything) and for a manager. */
  bits: number;
  canCreateEvent: boolean;
  /** The 신청 관리 gate: an owner, an admin holding PERM_APPROVE_CLAIM, or a manager with
   *  `canApprove`. OR-ed across every row this person holds for the organisation, so an admin
   *  without the bit who also manages with `canApprove` still passes. */
  canApprove: boolean;
}

/** One organisation as the chain has it — every field of {@link MyOrg} except its name. */
type MyOrgBase = Omit<MyOrg, 'name'>;

/**
 * One cached row. The name is still `null` here when `orgProfiles` holds no document for the
 * organisation: the fallback is copy, copy follows the locale, and a cache holding `주최사 #3`
 * would go on saying that after a switch to English. The sentence is put on outside the
 * queryFn, where a locale change re-renders it.
 */
type MyOrgRow = MyOrgBase & { name: string | null };

export interface MyOrgsResult {
  orgs: MyOrg[];
  canCreateEvent: boolean;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  /**
   * Asks the indexer again **and answers with what it said**. The answer matters because the
   * publish path has one question the cached list cannot settle — "did the organisation a
   * previous attempt started actually get made?" — and `createOrganizerForMe` is not
   * idempotent, so guessing wrong is a second organisation (plan section B-5).
   */
  refetch: () => Promise<MyOrg[]>;
}

export interface OrgEventsResult {
  events: EnvioEvent[];
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => void;
}

/**
 * `Admin.bits` is a `BigInt!` column, so it arrives as a decimal string. Anything that is not
 * a finite number is read as no permissions at all rather than carried on as NaN, whose every
 * bit test answers false anyway — but silently, and one screen later.
 */
function toBits(value: string): number {
  const bits = Number(value);
  return Number.isFinite(bits) ? bits : 0;
}

/** The contract gives an owner every permission there is; an admin holds exactly its bits. */
function canCreate(role: MyOrg['role'], bits: number): boolean {
  return role === 'owner' || (bits & PERM_CREATE_EVENT) !== 0;
}

/**
 * The three lists fold into one row per organisation. Somebody who owns an organisation is
 * commonly also listed as one of its admins, so the strongest role wins — owner, then admin,
 * then manager — and the organisation is listed once. Ordered by orgId ascending, which is
 * the order the chain created them in.
 */
function foldOrgs(
  organizers: EnvioOrganizer[],
  admins: EnvioAdmin[],
  managers: EnvioManager[],
): MyOrgBase[] {
  const byOrgId = new Map<string, MyOrgBase>();
  const put = (orgId: string, role: MyOrg['role'], bits: number, canApprove: boolean): void => {
    const existing = byOrgId.get(orgId);
    if (existing) {
      // The strongest role and its bits win, but approval is any-of: an admin without the bit who
      // also manages the same organisation with canApprove still passes the 신청 관리 gate.
      existing.canApprove ||= canApprove;
      return;
    }
    byOrgId.set(orgId, { orgId, role, bits, canCreateEvent: canCreate(role, bits), canApprove });
  };
  // `Organizer.id` is the orgId itself; the other two rows carry it in their own column.
  for (const organizer of organizers) put(organizer.id, 'owner', 0, true);
  for (const admin of admins) put(admin.orgId, 'admin', toBits(admin.bits), (toBits(admin.bits) & PERM_APPROVE_CLAIM) !== 0);
  for (const manager of managers) put(manager.orgId, 'manager', 0, manager.canApprove);
  return [...byOrgId.values()].sort((left, right) => Number(left.orgId) - Number(right.orgId));
}

/**
 * The organisations this person may act for, and whether any of them lets them create an event
 * — which is what the organiser home asks before it offers 만들기 at all.
 *
 * One round trip to the indexer, then one Firestore read per organisation for the display
 * name. A name that will not load is not an error: the organisation is still listed, by number.
 */
export function useMyOrgs(): MyOrgsResult {
  const copy = useOrganizerCopy();
  const session = useSession();
  // The indexer stores every address lowercase (indexer/schema.graphql:6) and `_eq` is
  // case-sensitive, so a checksummed address would match no row at all.
  const me = session.account?.toLowerCase();

  const query = useQuery({
    queryKey: ['myOrgs', me],
    queryFn: async (): Promise<MyOrgRow[]> => {
      const data = await gql<{
        Organizer: EnvioOrganizer[];
        Admin: EnvioAdmin[];
        Manager: EnvioManager[];
      }>(MY_ORGS_QUERY, { me });
      const orgs = foldOrgs(data.Organizer, data.Admin, data.Manager);
      return Promise.all(orgs.map(async (org) => ({ ...org, name: await loadOrgName(org.orgId) })));
    },
    staleTime: 60_000,
    // Nothing is asked of a signed-out visitor: the organiser screens sit behind the guard,
    // and an empty `$me` would only ask the indexer about nobody's organisations.
    enabled: session.status === 'signedIn' && me !== undefined,
  });

  // The fallback is copy, so it is put on outside the queryFn — a cache holding `주최사 #3`
  // would go on saying that after a switch to English.
  const named = useCallback(
    (rows: readonly MyOrgRow[]): MyOrg[] =>
      rows.map((org) => ({ ...org, name: org.name ?? fmt(copy.home.orgFallback, { id: org.orgId }) })),
    [copy],
  );
  const orgs = useMemo(() => named(query.data ?? []), [named, query.data]);
  const refetch = useCallback(
    async (): Promise<MyOrg[]> => named((await query.refetch()).data ?? []),
    [named, query],
  );

  return {
    orgs,
    canCreateEvent: orgs.some((org) => org.canCreateEvent),
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    refetch,
  };
}

/**
 * Every event of a set of organisations, newest first, exactly as the chain has them. No
 * metadata document is read here: what a row is shown as is the list screen's decision, and a
 * gateway that will not answer has no business holding up rows that are already in hand.
 */
export function useOrgEvents(orgIds: string[]): OrgEventsResult {
  const query = useQuery({
    // The ids are the query. Sorted and joined so the same set in another order is the same
    // cache entry; passed through as they are, since `numeric` takes a decimal string.
    queryKey: ['orgEvents', [...orgIds].sort().join(',')],
    queryFn: async (): Promise<EnvioEvent[]> => {
      const { Event } = await gql<{ Event: EnvioEvent[] }>(ORG_EVENTS_QUERY, { orgIds });
      return Event;
    },
    enabled: orgIds.length > 0,
  });

  return {
    events: query.data ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    refetch: () => void query.refetch(),
  };
}
