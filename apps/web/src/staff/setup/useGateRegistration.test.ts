import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The counterfactual gate account Task 13 pinned against the live factory, and the two key
 * halves Task 11 hands over. They are spelled out rather than generated because the whole
 * point of this screen is that these exact bytes reach the organizer unchanged.
 */
const ADDRESS = '0xCf83795Af2E30a8Bb373610f45563eB97A5aEDb1' as const;
const KX = `0x${'11'.repeat(32)}` as const;
const KY = `0x${'22'.repeat(32)}` as const;

const submitPendingGate = vi.fn<(payload: unknown) => Promise<{ ok: true }>>();
const gateOf = vi.fn<(account: string) => Promise<bigint>>();
const gateInfo = vi.fn();
const eventOrg = vi.fn<(eventId: bigint) => Promise<bigint>>();
const ensureGateKey = vi.fn();
const getGateAddress = vi.fn<() => Promise<string>>();

vi.mock('../../shared/api/functions', () => ({
  submitPendingGate: (payload: unknown) => submitPendingGate(payload),
  // The real one reads `code`/`message` structurally, which is exactly what a rejected
  // callable carries; restating it here keeps the mock from teaching a different shape.
  callableFailure: (error: unknown) => ({
    code: (error as { code?: string } | null)?.code ?? '',
    reason: (error as { message?: string } | null)?.message ?? '',
  }),
}));
vi.mock('../../shared/chain/reads', () => ({
  readOrganizers: () => ({ gateOf, gateInfo }),
  readTicket: () => ({ eventOrg }),
}));
vi.mock('../../shared/chain/gateAccount', () => ({ getGateAddress: () => getGateAddress() }));
vi.mock('../gate/gateKey', () => ({
  ensureGateKey: () => ensureGateKey(),
  gateKeyCoordinates: (key: { x: string; y: string }) => ({ kx: key.x, ky: key.y }),
}));

const { gatePayloadText, useGateRegistration } = await import('./useGateRegistration');

/** What the hook is handed back by a chain that has already registered this device. */
function registered(): void {
  gateOf.mockResolvedValue(7n);
  gateInfo.mockResolvedValue({ eventId: 42n, account: ADDRESS, kx: KX, ky: KY, open: true, revoked: false });
  eventOrg.mockResolvedValue(5n);
}

beforeEach(() => {
  submitPendingGate.mockReset().mockResolvedValue({ ok: true });
  gateOf.mockReset().mockResolvedValue(0n);
  gateInfo.mockReset();
  eventOrg.mockReset();
  ensureGateKey.mockReset().mockResolvedValue({ x: KX, y: KY, backing: 'strongBox' });
  getGateAddress.mockReset().mockResolvedValue(ADDRESS);
});

describe('gate registration', () => {
  it('submits the pending gate once with the device key, then polls gateOf', async () => {
    gateOf.mockResolvedValueOnce(0n);
    registered();
    gateOf.mockResolvedValueOnce(0n).mockResolvedValue(7n);

    const { result } = renderHook(() => useGateRegistration({ eventId: '42', pollMs: 5 }));

    await waitFor(() => expect(submitPendingGate).toHaveBeenCalledTimes(1));
    // Exact equality, not objectContaining: the backend reads these four fields and nothing
    // else, and a fifth one it silently drops is a field this screen only thinks it sent.
    expect(submitPendingGate).toHaveBeenCalledWith({
      eventId: '42', gateAccount: ADDRESS, kx: KX, ky: KY,
    });

    await waitFor(() => expect(result.current.status).toBe('registered'));
    // gateOf is asked about THIS account. Nothing here assumes the seeded gate id.
    expect(gateOf).toHaveBeenCalledWith(ADDRESS);
    expect(gateInfo).toHaveBeenCalledWith(7n);
    expect(eventOrg).toHaveBeenCalledWith(42n);
    expect(result.current.gateId).toBe(7n);
    expect(result.current.eventId).toBe(42n);
    expect(result.current.orgId).toBe(5n);
    expect(result.current.open).toBe(true);
    expect(result.current.revoked).toBe(false);
    expect(result.current.submitted).toBe(true);
    expect(result.current.error).toBeUndefined();
  });

  it('polls without submitting when no event has been chosen yet', async () => {
    const { result } = renderHook(() => useGateRegistration({ pollMs: 5 }));

    await waitFor(() => expect(result.current.status).toBe('waiting'));
    expect(submitPendingGate).not.toHaveBeenCalled();
    expect(result.current.payload).toBeUndefined();
    expect(result.current.address).toBe(ADDRESS);
    await waitFor(() => expect(gateOf.mock.calls.length).toBeGreaterThan(1));
  });

  it('stops polling once the gate is registered', async () => {
    registered();
    const { result } = renderHook(() => useGateRegistration({ eventId: '42', pollMs: 5 }));

    await waitFor(() => expect(result.current.status).toBe('registered'));
    const settled = gateOf.mock.calls.length;
    // Twenty poll intervals' worth of real time. A hook that kept polling would have added
    // calls by now; the registration answer is final, so this number must not move.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    expect(gateOf.mock.calls.length).toBe(settled);
  });

  it('re-submits the identical application and never a second one per press', async () => {
    const { result } = renderHook(() => useGateRegistration({ eventId: '42', pollMs: 5 }));
    await waitFor(() => expect(submitPendingGate).toHaveBeenCalledTimes(1));

    await act(async () => {
      result.current.resubmit();
    });

    await waitFor(() => expect(submitPendingGate).toHaveBeenCalledTimes(2));
    expect(submitPendingGate.mock.calls[1]).toEqual(submitPendingGate.mock.calls[0]);
    // The document id on the server is the lowercased account, so the second application
    // replaces the first rather than queueing a second row for the organizer to approve.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    expect(submitPendingGate).toHaveBeenCalledTimes(2);
  });

  it('shows the organizer exactly what was submitted, byte for byte', async () => {
    const { result } = renderHook(() => useGateRegistration({ eventId: '42', pollMs: 5 }));
    await waitFor(() => expect(submitPendingGate).toHaveBeenCalledTimes(1));

    const sent = submitPendingGate.mock.calls[0]?.[0];
    expect(result.current.payload).toEqual(sent);
    expect(gatePayloadText(result.current.payload!)).toBe(JSON.stringify(sent));
  });

  it('types a rejected application and keeps polling behind the fallback', async () => {
    submitPendingGate.mockRejectedValue(
      Object.assign(new Error('AUTH_REQUIRED'), { code: 'unauthenticated' }),
    );
    const { result } = renderHook(() => useGateRegistration({ eventId: '42', pollMs: 5 }));

    await waitFor(() => expect(result.current.error).toBe('AUTH_REQUIRED'));
    expect(result.current.submitted).toBe(false);
    // The QR fallback exists precisely for this: the values still have to be readable.
    expect(result.current.payload).toEqual({ eventId: '42', gateAccount: ADDRESS, kx: KX, ky: KY });
    await waitFor(() => expect(result.current.status).toBe('waiting'));
    await waitFor(() => expect(gateOf.mock.calls.length).toBeGreaterThan(1));
  });

  it('separates a refused application from a signed-out one', async () => {
    submitPendingGate.mockRejectedValue(
      Object.assign(new Error('BAD_EVENT_ID'), { code: 'invalid-argument' }),
    );
    const { result } = renderHook(() => useGateRegistration({ eventId: '42', pollMs: 5 }));

    await waitFor(() => expect(result.current.error).toBe('SUBMIT_REJECTED'));
  });

  it('types a failed chain read, keeps retrying, and clears it on the next good one', async () => {
    gateOf.mockRejectedValue(new Error('fetch failed'));
    const { result } = renderHook(() => useGateRegistration({ eventId: '42', pollMs: 5 }));

    await waitFor(() => expect(result.current.error).toBe('CHAIN_UNREACHABLE'));
    // A dropped read is not a refusal: the screen says so and the poll carries on.
    await waitFor(() => expect(gateOf.mock.calls.length).toBeGreaterThan(2));

    gateOf.mockResolvedValue(0n);
    await waitFor(() => expect(result.current.error).toBeUndefined());
    expect(result.current.status).toBe('waiting');
  });

  it('stays in creating, and submits nothing, when the device cannot make a key', async () => {
    getGateAddress.mockRejectedValue(new Error('DeviceKeyUnavailable'));
    const { result } = renderHook(() => useGateRegistration({ eventId: '42', pollMs: 5 }));

    await waitFor(() => expect(result.current.error).toBe('KEY_UNAVAILABLE'));
    expect(result.current.status).toBe('creating');
    expect(result.current.address).toBeUndefined();
    expect(submitPendingGate).not.toHaveBeenCalled();
    expect(gateOf).not.toHaveBeenCalled();
  });
});
