import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RelayStatusView } from '../../shared/api/firestore';
import { PurchaseSheet } from './PurchaseSheet';

const ACCOUNT = `0x${'ab'.repeat(20)}`;

// Hoisted so the vi.mock factories (lifted above imports) can reference them without a TDZ error.
const mocks = vi.hoisted(() => ({
  buildClaimAuth: vi.fn(async () => ({ auth: { eventId: '5', tier: 0, account: '0x', nonce: '0', deadline: '1' }, deviceSig: `0x${'cd'.repeat(64)}` })),
  purchaseTicket: vi.fn(
    async (_p: unknown): Promise<{ orderId: string; relayId: string; status: string; tokenId?: string; depositTxHash?: string }> => ({
      orderId: 'o1', relayId: 'o1', status: 'minted', tokenId: '42',
    }),
  ),
  watchRelayStatus: vi.fn((_id: string, onChange: (r: RelayStatusView | null) => void) => {
    relayListener = onChange;
    return () => undefined;
  }),
  getAttendeeAccount: vi.fn(async () => ({ address: ACCOUNT })),
  rememberOrder: vi.fn(),
}));
let relayListener: ((r: RelayStatusView | null) => void) | null = null;

vi.mock('../claim/buildClaimAuth', () => ({ buildClaimAuth: mocks.buildClaimAuth, CLAIM_DEADLINE_SECONDS: 600 }));
vi.mock('../../shared/api/functions', () => ({ api: { purchaseTicket: mocks.purchaseTicket } }));
vi.mock('../../shared/api/firestore', () => ({ watchRelayStatus: mocks.watchRelayStatus }));
vi.mock('../../shared/chain/accounts', () => ({ getAttendeeAccount: mocks.getAttendeeAccount }));
vi.mock('./orderStore', () => ({ rememberOrder: mocks.rememberOrder }));

function renderSheet() {
  return render(
    <MemoryRouter>
      <PurchaseSheet eventId="5" tier={0} amountUsdCents={3000} onClose={() => undefined} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  relayListener = null;
  mocks.purchaseTicket.mockResolvedValue({ orderId: 'o1', relayId: 'o1', status: 'minted', tokenId: '42' });
  vi.clearAllMocks();
});

afterEach(() => vi.restoreAllMocks());

describe('PurchaseSheet', () => {
  it('shows the mock card sheet with the test badge, test notice and the $ amount', () => {
    renderSheet();
    expect(screen.getByText('테스트 환경')).toBeTruthy();
    expect(screen.getByText('테스트 결제예요 · 실제로 돈이 빠져나가지 않아요')).toBeTruthy();
    expect(screen.getByRole('button', { name: '결제하고 받기 $30.00' })).toBeTruthy();
  });

  it('calls purchaseTicket with the mock card payment and lands on 완료', async () => {
    const user = userEvent.setup();
    renderSheet();
    await user.click(screen.getByRole('button', { name: '결제하고 받기 $30.00' }));

    await waitFor(() => expect(mocks.purchaseTicket).toHaveBeenCalledTimes(1));
    expect(mocks.purchaseTicket).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: '5', tier: 0, payment: { method: 'card-mock', amountUsdCents: 3000 } }),
    );
    // A minted order remembers the token so the receipt can surface on the ticket detail.
    expect(mocks.rememberOrder).toHaveBeenCalledWith('o1', { eventId: '5', tokenId: '42' });
    expect(await screen.findByText('결제 완료 · 티켓을 받았어요')).toBeTruthy();
    expect(screen.getByRole('link', { name: '내 티켓 보기' })).toBeTruthy();
  });

  it('follows the relay doc to 완료 when the mint is still in flight', async () => {
    const user = userEvent.setup();
    mocks.purchaseTicket.mockResolvedValue({ orderId: 'o1', relayId: 'o1', status: 'sent' });
    renderSheet();
    await user.click(screen.getByRole('button', { name: '결제하고 받기 $30.00' }));

    // 'sent' keeps the wait open until the relay doc confirms the mint.
    await waitFor(() => expect(relayListener).not.toBeNull());
    expect(screen.queryByText('결제 완료 · 티켓을 받았어요')).toBeNull();
    act(() => relayListener?.({ status: 'confirmed', tokenId: '42' }));
    expect(await screen.findByText('결제 완료 · 티켓을 받았어요')).toBeTruthy();
  });

  it('names a price mismatch rather than the generic failure', async () => {
    const user = userEvent.setup();
    mocks.purchaseTicket.mockRejectedValue({ code: 'failed-precondition', details: { code: 'PRICE_MISMATCH' } });
    renderSheet();
    await user.click(screen.getByRole('button', { name: '결제하고 받기 $30.00' }));

    expect(await screen.findByText('티켓 값이 바뀌었어요. 새로고침 후 다시 시도해 주세요')).toBeTruthy();
  });
});
