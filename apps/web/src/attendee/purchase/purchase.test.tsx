import { fireEvent, render, screen, waitFor, act } from '@testing-library/react';
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
    async (_p: unknown): Promise<{ orderId: string; relayId: string; status: string; tokenId?: string; txHash?: string }> => ({
      orderId: 'o1', relayId: 'o1', status: 'deposited', tokenId: '42',
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
  mocks.purchaseTicket.mockResolvedValue({ orderId: 'o1', relayId: 'o1', status: 'deposited', tokenId: '42' });
  vi.clearAllMocks();
});

afterEach(() => vi.restoreAllMocks());

describe('PurchaseSheet', () => {
  it('shows the mock card sheet with the test badge, test notice and the $ amount', () => {
    renderSheet();
    expect(screen.getByText('Test environment')).toBeTruthy();
    expect(screen.getByText('This is a test payment · no real money moves')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Pay $30' })).toBeTruthy();
  });

  it('calls purchaseTicket with the mock card payment and lands on 완료', async () => {
    const user = userEvent.setup();
    renderSheet();
    await user.click(screen.getByRole('button', { name: 'Pay $30' }));

    await waitFor(() => expect(mocks.purchaseTicket).toHaveBeenCalledTimes(1));
    expect(mocks.purchaseTicket).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: '5', tier: 0, payment: { method: 'card-mock', amountUsdCents: 3000 } }),
    );
    // A deposited order (ticket and payment in one step) remembers the token so the receipt can
    // surface on the ticket detail.
    expect(mocks.rememberOrder).toHaveBeenCalledWith('o1', { eventId: '5', tokenId: '42' });
    expect(await screen.findByText('Paid · your ticket is ready')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'See receipt' })).toHaveAttribute('href', '/tickets/42');
  });

  it('titles the sheet as a card payment', () => {
    renderSheet();
    expect(screen.getByRole('dialog', { name: 'Card payment' })).toBeTruthy();
  });

  it('lets the person leave a long wait, pointing at 내 티켓 rather than paying twice', async () => {
    vi.useFakeTimers();
    try {
      mocks.purchaseTicket.mockResolvedValue({ orderId: 'o1', relayId: 'o1', status: 'sent' });
      renderSheet();
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Pay $30' }));
      });
      expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled();
      await act(async () => {
        vi.advanceTimersByTime(46_000);
      });
      expect(screen.getByText('This is taking a while. Your payment is going through and the ticket will appear in My tickets shortly.')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Close' })).toBeEnabled();
      expect(screen.getByRole('button', { name: 'Check My tickets' })).toBeTruthy();
      expect(mocks.purchaseTicket).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('follows the purchase relay doc to 완료 when the payment is still in flight', async () => {
    const user = userEvent.setup();
    mocks.purchaseTicket.mockResolvedValue({ orderId: 'o1', relayId: 'r-o1', status: 'sent' });
    renderSheet();
    await user.click(screen.getByRole('button', { name: 'Pay $30' }));

    // 'sent' keeps the wait open until the purchase relay doc confirms ticket + payment together.
    await waitFor(() => expect(relayListener).not.toBeNull());
    expect(mocks.watchRelayStatus).toHaveBeenCalledWith('r-o1', expect.any(Function), expect.any(Function));
    expect(screen.queryByText('Paid · your ticket is ready')).toBeNull();
    act(() => relayListener?.({ status: 'confirmed', tokenId: '42' }));
    expect(await screen.findByText('Paid · your ticket is ready')).toBeTruthy();
    expect(mocks.rememberOrder).toHaveBeenLastCalledWith('o1', { eventId: '5', tokenId: '42' });
    expect(screen.getByRole('link', { name: 'See receipt' })).toHaveAttribute('href', '/tickets/42');
  });

  it('says nothing was charged when the in-flight payment fails, and offers the retry', async () => {
    const user = userEvent.setup();
    mocks.purchaseTicket.mockResolvedValue({ orderId: 'o1', relayId: 'o1', status: 'sent' });
    renderSheet();
    await user.click(screen.getByRole('button', { name: 'Pay $30' }));

    await waitFor(() => expect(relayListener).not.toBeNull());
    act(() => relayListener?.({ status: 'failed', error: { code: 'REVERTED' } }));
    expect(await screen.findByText("The payment didn't go through · nothing was charged. Please try again")).toBeTruthy();
    // No ticket, no half state: the pay button is back for a fresh attempt.
    expect(screen.getByRole('button', { name: 'Pay $30' })).toBeEnabled();
    expect(screen.queryByText('Paid · your ticket is ready')).toBeNull();
  });

  it('names a price mismatch rather than the generic failure', async () => {
    const user = userEvent.setup();
    mocks.purchaseTicket.mockRejectedValue({ code: 'failed-precondition', details: { code: 'PRICE_MISMATCH', expected: 2500 } });
    renderSheet();
    await user.click(screen.getByRole('button', { name: 'Pay $30' }));

    expect(await screen.findByText('The price changed. Please refresh and try again')).toBeTruthy();
  });

  it.each([
    ['TREASURY_FUNDS', "Payments aren't available right now. Please try again in a moment"],
    ['PAUSED', "Payments aren't available right now. Please try again in a moment"],
    ['CONFIG', "Payments aren't available right now. Please try again in a moment"],
    ['NOT_PAID_TIER', 'The price changed. Please refresh and try again'],
    ['UNKNOWN_TIER', 'The price changed. Please refresh and try again'],
    ['SOLD_OUT', 'This ticket type is sold out'],
    ['NOT_ON_SALE', 'Not available right now. Please check the sale period.'],
    ['NOT_PUBLISHED', 'Not available right now. Please check the sale period.'],
    ['EVENT_ENDED', 'This event has already ended'],
    ['KYC_REQUIRED', 'Please verify your identity before paying'],
    ['LIMIT', 'You already have every ticket this event allows.'],
    ['APPROVAL_REQUIRED', 'You can get a ticket after the organizer approves.'],
    ['DEVICE_LOCKED', "This phone can't get it right now. Please sign in again."],
    ['TOO_MANY_PENDING', 'Your previous payment is still going through. Check My tickets in a moment'],
    ['SEND_FAILED', "The payment didn't go through · nothing was charged. Please try again"],
    ['REVERTED', "The payment didn't go through · nothing was charged. Please try again"],
    ['AUTH_EXPIRED', "The payment didn't go through · nothing was charged. Please try again"],
  ])('turns the %s refusal into its sentence', async (code, sentence) => {
    const user = userEvent.setup();
    mocks.purchaseTicket.mockRejectedValue({ code: 'failed-precondition', details: { code } });
    renderSheet();
    await user.click(screen.getByRole('button', { name: 'Pay $30' }));

    expect(await screen.findByText(sentence)).toBeTruthy();
  });

  it('falls back to the plain retry sentence when the call never answered with a code', async () => {
    const user = userEvent.setup();
    mocks.purchaseTicket.mockRejectedValue(new Error('network'));
    renderSheet();
    await user.click(screen.getByRole('button', { name: 'Pay $30' }));

    expect(await screen.findByText("Couldn't pay. Please try again in a moment")).toBeTruthy();
  });
});
