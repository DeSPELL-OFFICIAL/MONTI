import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearSession, setSession } from '../shared/session';

// Both halves of the data path are mocked: the indexer transport and the one Firestore read.
// Every assertion below is about what the hooks do with the rows, never about how they arrive.
const gql = vi.fn();
vi.mock('../shared/envio/client', () => ({ gql }));
const loadOrgName = vi.fn();
vi.mock('../shared/api/firestore', () => ({ loadOrgName }));

const { useMyOrgs, useOrgEvents } = await import('./useMyOrgs');
const { MY_ORGS_QUERY, ORG_EVENTS_QUERY } = await import('../shared/envio/queries');
const { organizerCopy } = await import('./copy');

/** The session carries a checksummed address; the indexer only ever holds the lowercase one. */
const ME = `0x${'Ab'.repeat(20)}` as `0x${string}`;
const ME_LOWER = ME.toLowerCase();

function organizer(orgId: string) {
  return { id: orgId, owner: ME_LOWER };
}
function admin(orgId: string, bits: string) {
  return { id: `${orgId}-${ME_LOWER}`, orgId, account: ME_LOWER, bits };
}
function manager(orgId: string) {
  return { id: `${orgId}-${ME_LOWER}`, orgId, account: ME_LOWER, exists: true, canApprove: true };
}

const EVENT = {
  id: '11', orgId: '3', imageCid: 'cid-a', startsAt: '1800000000', endsAt: '1800003600',
  saleStart: '1700000000', saleEnd: '1800000000', transferable: true, transferCutoffSeconds: '3600',
  maxTransfers: 3, category: 0, regionCode: '0x00', status: 'Published', requireKyc: false,
};

/** One client per render, so a cached answer never leaks from one assertion into the next. */
function wrap() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

function renderMyOrgs() {
  return renderHook(() => useMyOrgs(), { wrapper: wrap() });
}

function renderOrgEvents(orgIds: string[]) {
  return renderHook(() => useOrgEvents(orgIds), { wrapper: wrap() });
}

beforeEach(() => {
  setSession({ status: 'signedIn', account: ME });
  gql.mockReset();
  loadOrgName.mockReset();
  gql.mockResolvedValue({ Organizer: [], Admin: [], Manager: [] });
  loadOrgName.mockResolvedValue(null);
});

afterEach(() => {
  clearSession();
});

describe('useMyOrgs', () => {
  it('folds the three lists into one row per organisation, the strongest role winning', async () => {
    // Organisation 3 is both owned and administered by this person: it is listed once, as owner.
    gql.mockResolvedValue({
      Organizer: [organizer('3')],
      Admin: [admin('3', '1'), admin('5', '2')],
      Manager: [manager('3'), manager('9')],
    });
    const { result } = renderMyOrgs();

    await waitFor(() => expect(result.current.orgs).toHaveLength(3));
    expect(result.current.orgs.map((org) => [org.orgId, org.role])).toEqual([
      ['3', 'owner'],
      ['5', 'admin'],
      ['9', 'manager'],
    ]);
  });

  it('asks the indexer for the lowercase address the rows are stored under', async () => {
    renderMyOrgs();

    await waitFor(() => expect(gql).toHaveBeenCalledTimes(1));
    expect(gql).toHaveBeenCalledWith(MY_ORGS_QUERY, { me: ME_LOWER });
    // The guard is the point: the session address is not lowercase to begin with.
    expect(ME_LOWER).not.toBe(ME);
  });

  it('names an organisation by its number when orgProfiles holds no document for it', async () => {
    gql.mockResolvedValue({ Organizer: [organizer('3'), organizer('4')], Admin: [], Manager: [] });
    loadOrgName.mockImplementation(async (orgId: string) => (orgId === '3' ? '몬티 라이브' : null));
    const { result } = renderMyOrgs();

    await waitFor(() => expect(result.current.orgs).toHaveLength(2));
    expect(result.current.orgs.map((org) => org.name)).toEqual(['몬티 라이브', 'Team #4']);
    expect(organizerCopy.en.home.orgFallback).toBe('Team #{{id}}');
  });

  it('offers event creation to an owner and to an admin holding the createEvent bit', async () => {
    // bits 1 is createEvent; bits 2 is manageGates, which says nothing about creating events.
    gql.mockResolvedValue({
      Organizer: [organizer('1')],
      Admin: [admin('2', '1'), admin('3', '2')],
      Manager: [manager('4')],
    });
    const { result } = renderMyOrgs();

    await waitFor(() => expect(result.current.orgs).toHaveLength(4));
    expect(result.current.orgs.map((org) => org.canCreateEvent)).toEqual([true, true, false, false]);
    expect(result.current.orgs.map((org) => org.bits)).toEqual([0, 1, 2, 0]);
    expect(result.current.canCreateEvent).toBe(true);
  });

  it('grants approval to an owner, an admin holding the bit, and a manager who may approve', async () => {
    // bits 32 is PERM_APPROVE_CLAIM; bits 2 is manageGates, which says nothing about approving.
    gql.mockResolvedValue({
      Organizer: [organizer('1')],
      Admin: [admin('2', '32'), admin('3', '2')],
      Manager: [manager('4')],
    });
    const { result } = renderMyOrgs();

    await waitFor(() => expect(result.current.orgs).toHaveLength(4));
    // manager() sets canApprove: true, so org 4 passes on the manager row alone.
    expect(result.current.orgs.map((org) => org.canApprove)).toEqual([true, true, false, true]);
  });

  it('offers no event creation to somebody who only manages and only holds other bits', async () => {
    gql.mockResolvedValue({ Organizer: [], Admin: [admin('3', '2')], Manager: [manager('4')] });
    const { result } = renderMyOrgs();

    await waitFor(() => expect(result.current.orgs).toHaveLength(2));
    expect(result.current.canCreateEvent).toBe(false);
  });

  it('asks the indexer nothing on behalf of a signed-out visitor', async () => {
    clearSession();
    const { result } = renderMyOrgs();

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.orgs).toEqual([]);
    expect(result.current.canCreateEvent).toBe(false);
    expect(gql).not.toHaveBeenCalled();
    expect(loadOrgName).not.toHaveBeenCalled();
  });
});

describe('useOrgEvents', () => {
  it('asks for the events of every organisation it is given, ids untouched', async () => {
    gql.mockResolvedValue({ Event: [EVENT] });
    const { result } = renderOrgEvents(['5', '3']);

    await waitFor(() => expect(result.current.events).toHaveLength(1));
    expect(gql).toHaveBeenCalledWith(ORG_EVENTS_QUERY, { orgIds: ['5', '3'] });
    expect(result.current.events[0]?.id).toBe('11');
  });

  it('asks nothing when there is no organisation to ask about', async () => {
    const { result } = renderOrgEvents([]);

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.events).toEqual([]);
    expect(gql).not.toHaveBeenCalled();
  });
});
