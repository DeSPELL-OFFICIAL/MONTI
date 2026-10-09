import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnvioGate } from '../shared/envio/queries';

// Only the chain is mocked: `gateInfo`, the per-id read the fallback probes. The indexer's rows
// are passed straight in — exactly as the gate screen passes the rows its GATES_QUERY already
// returned — so every assertion is about which answer the hook trusts, not how either one travels.
const gateInfo = vi.fn();
vi.mock('../shared/chain/reads', () => ({ readOrganizers: () => ({ gateInfo }) }));

const { useEventGatesWithFallback } = await import('./useEventGatesWithFallback');

/** One client per render, so a cached answer never leaks from one assertion into the next. */
function wrap() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

const ZERO = '0x0000000000000000000000000000000000000000';
/** An unregistered id answers with the zero struct (`account == address(0)`). */
const empty = { eventId: 0n, account: ZERO, kx: '0x0', ky: '0x0', open: false, revoked: false };
const indexerRow: EnvioGate = {
  id: '3', eventId: '5', account: '0xOLD', kx: '0x1', ky: '0x2', isOpen: true, revoked: false,
};

/** Ids 1..3 are real (1 and 3 on event 5, 2 on another event); id 4+ is the end of the dense range. */
function denseChain() {
  const rows: Record<number, typeof empty> = {
    1: { eventId: 5n, account: '0xA1', kx: '0x11', ky: '0x12', open: true, revoked: false },
    2: { eventId: 9n, account: '0xA2', kx: '0x21', ky: '0x22', open: false, revoked: false },
    3: { eventId: 5n, account: '0xA3', kx: '0x31', ky: '0x32', open: false, revoked: true },
  };
  gateInfo.mockImplementation(async (id: bigint) => rows[Number(id)] ?? empty);
}

beforeEach(() => {
  gateInfo.mockReset();
  denseChain();
});

describe('useEventGatesWithFallback', () => {
  it('uses the indexer rows when it has them, and never probes the chain', async () => {
    const { result } = renderHook(() => useEventGatesWithFallback('5', [indexerRow]), { wrapper: wrap() });
    await waitFor(() => expect(result.current.source).toBe('indexer'));
    expect(result.current.gates).toEqual([indexerRow]);
    expect(gateInfo).not.toHaveBeenCalled();
  });

  it('probes dense gateInfo ids and keeps only this event, newest id last', async () => {
    const { result } = renderHook(() => useEventGatesWithFallback('5', []), { wrapper: wrap() });
    await waitFor(() => expect(result.current.source).toBe('direct'));
    expect(result.current.gates).toEqual([
      { id: '1', eventId: '5', account: '0xA1', kx: '0x11', ky: '0x12', isOpen: true, revoked: false },
      { id: '3', eventId: '5', account: '0xA3', kx: '0x31', ky: '0x32', isOpen: false, revoked: true },
    ]);
  });

  it('is "none" when the very first id is empty (no gate was ever registered)', async () => {
    gateInfo.mockResolvedValue(empty);
    const { result } = renderHook(() => useEventGatesWithFallback('5', []), { wrapper: wrap() });
    await waitFor(() => expect(gateInfo).toHaveBeenCalled());
    expect(result.current.source).toBe('none');
    expect(result.current.gates).toEqual([]);
  });

  it('is "none" when the probe read fails', async () => {
    gateInfo.mockReset().mockRejectedValue(new Error('rpc down'));
    const { result } = renderHook(() => useEventGatesWithFallback('5', []), { wrapper: wrap() });
    await waitFor(() => expect(gateInfo).toHaveBeenCalled());
    expect(result.current.source).toBe('none');
    expect(result.current.gates).toEqual([]);
  });

  it('asks nothing while the indexer is still loading', () => {
    const { result } = renderHook(() => useEventGatesWithFallback('5', undefined), { wrapper: wrap() });
    expect(result.current.source).toBe('none');
    expect(result.current.gates).toEqual([]);
    expect(gateInfo).not.toHaveBeenCalled();
  });
});
