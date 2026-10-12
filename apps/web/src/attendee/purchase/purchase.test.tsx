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
    expect(screen.getByText('테스트 환경')).toBeTruthy();
    expect(screen.getByText('테스트 결제예요 · 실제로 돈이 빠져나가지 않아요')).toBeTruthy();
    expect(screen.getByRole('button', { name: '$30.00 결제하기' })).toBeTruthy();
  });

  it('calls purchaseTicket with the mock card payment and lands on 완료', async () => {
    const user = userEvent.setup();
    renderSheet();
    await user.click(screen.getByRole('button', { name: '$30.00 결제하기' }));

    await waitFor(() => expect(mocks.purchaseTicket).toHaveBeenCalledTimes(1));
    expect(mocks.purchaseTicket).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: '5', tier: 0, payment: { method: 'card-mock', amountUsdCents: 3000 } }),
    );
    // A deposited order (ticket and payment in one step) remembers the token so the receipt can
    // surface on the ticket detail.
    expect(mocks.rememberOrder).toHaveBeenCalledWith('o1', { eventId: '5', tokenId: '42' });
    expect(await screen.findByText('결제 완료 · 티켓을 받았어요')).toBeTruthy();
    expect(screen.getByRole('link', { name: '영수증 보기' })).toHaveAttribute('href', '/tickets/42');
  });

  it('titles the sheet as a card payment', () => {
    renderSheet();
    expect(screen.getByRole('dialog', { name: '카드 결제' })).toBeTruthy();
  });

  it('lets the person leave a long wait, pointing at 내 티켓 rather than paying twice', async () => {
    vi.useFakeTimers();
    try {
      mocks.purchaseTicket.mockResolvedValue({ orderId: 'o1', relayId: 'o1', status: 'sent' });
      renderSheet();
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: '$30.00 결제하기' }));
      });
      expect(screen.getByRole('button', { name: '닫기' })).toBeDisabled();
      await act(async () => {
        vi.advanceTimersByTime(46_000);
      });
      expect(screen.getByText('시간이 걸리고 있어요. 결제는 진행 중이고 티켓은 곧 내 티켓에 나타나요.')).toBeTruthy();
      expect(screen.getByRole('button', { name: '닫기' })).toBeEnabled();
      expect(screen.getByRole('button', { name: '내 티켓에서 확인하기' })).toBeTruthy();
      expect(mocks.purchaseTicket).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('follows the purchase relay doc to 완료 when the payment is still in flight', async () => {
    const user = userEvent.setup();
    mocks.purchaseTicket.mockResolvedValue({ orderId: 'o1', relayId: 'r-o1', status: 'sent' });
    renderSheet();
    await user.click(screen.getByRole('button', { name: '$30.00 결제하기' }));

    // 'sent' keeps the wait open until the purchase relay doc confirms ticket + payment together.
    await waitFor(() => expect(relayListener).not.toBeNull());
    expect(mocks.watchRelayStatus).toHaveBeenCalledWith('r-o1', expect.any(Function), expect.any(Function));
    expect(screen.queryByText('결제 완료 · 티켓을 받았어요')).toBeNull();
    act(() => relayListener?.({ status: 'confirmed', tokenId: '42' }));
    expect(await screen.findByText('결제 완료 · 티켓을 받았어요')).toBeTruthy();
    expect(mocks.rememberOrder).toHaveBeenLastCalledWith('o1', { eventId: '5', tokenId: '42' });
    expect(screen.getByRole('link', { name: '영수증 보기' })).toHaveAttribute('href', '/tickets/42');
  });

  it('says nothing was charged when the in-flight payment fails, and offers the retry', async () => {
    const user = userEvent.setup();
    mocks.purchaseTicket.mockResolvedValue({ orderId: 'o1', relayId: 'o1', status: 'sent' });
    renderSheet();
    await user.click(screen.getByRole('button', { name: '$30.00 결제하기' }));

    await waitFor(() => expect(relayListener).not.toBeNull());
    act(() => relayListener?.({ status: 'failed', error: { code: 'REVERTED' } }));
    expect(await screen.findByText('결제가 완료되지 않았어요 · 청구된 금액은 없어요. 다시 시도해 주세요')).toBeTruthy();
    // No ticket, no half state: the pay button is back for a fresh attempt.
    expect(screen.getByRole('button', { name: '$30.00 결제하기' })).toBeEnabled();
    expect(screen.queryByText('결제 완료 · 티켓을 받았어요')).toBeNull();
  });

  it('names a price mismatch rather than the generic failure', async () => {
    const user = userEvent.setup();
    mocks.purchaseTicket.mockRejectedValue({ code: 'failed-precondition', details: { code: 'PRICE_MISMATCH', expected: 2500 } });
    renderSheet();
    await user.click(screen.getByRole('button', { name: '$30.00 결제하기' }));

    expect(await screen.findByText('티켓 값이 바뀌었어요. 새로고침 후 다시 시도해 주세요')).toBeTruthy();
  });

  it.each([
    ['TREASURY_FUNDS', '지금은 결제를 받을 수 없어요. 잠시 후 다시 시도해 주세요'],
    ['PAUSED', '지금은 결제를 받을 수 없어요. 잠시 후 다시 시도해 주세요'],
    ['CONFIG', '지금은 결제를 받을 수 없어요. 잠시 후 다시 시도해 주세요'],
    ['NOT_PAID_TIER', '티켓 값이 바뀌었어요. 새로고침 후 다시 시도해 주세요'],
    ['UNKNOWN_TIER', '티켓 값이 바뀌었어요. 새로고침 후 다시 시도해 주세요'],
    ['SOLD_OUT', '이 종류는 마감됐어요'],
    ['NOT_ON_SALE', '지금은 받을 수 없어요. 판매 기간을 확인해 주세요.'],
    ['NOT_PUBLISHED', '지금은 받을 수 없어요. 판매 기간을 확인해 주세요.'],
    ['EVENT_ENDED', '이미 끝난 행사예요'],
    ['KYC_REQUIRED', '본인 확인을 마친 뒤에 결제할 수 있어요'],
    ['LIMIT', '이 행사에서 받을 수 있는 티켓을 이미 다 받았어요.'],
    ['APPROVAL_REQUIRED', '이 행사는 주최자 승인 후 받을 수 있어요.'],
    ['DEVICE_LOCKED', '이 휴대폰으로는 지금 받을 수 없어요. 다시 로그인해 주세요.'],
    ['TOO_MANY_PENDING', '앞선 결제를 처리하고 있어요. 잠시 뒤 내 티켓에서 확인해 주세요'],
    ['SEND_FAILED', '결제가 완료되지 않았어요 · 청구된 금액은 없어요. 다시 시도해 주세요'],
    ['REVERTED', '결제가 완료되지 않았어요 · 청구된 금액은 없어요. 다시 시도해 주세요'],
    ['AUTH_EXPIRED', '결제가 완료되지 않았어요 · 청구된 금액은 없어요. 다시 시도해 주세요'],
  ])('turns the %s refusal into its sentence', async (code, sentence) => {
    const user = userEvent.setup();
    mocks.purchaseTicket.mockRejectedValue({ code: 'failed-precondition', details: { code } });
    renderSheet();
    await user.click(screen.getByRole('button', { name: '$30.00 결제하기' }));

    expect(await screen.findByText(sentence)).toBeTruthy();
  });

  it('falls back to the plain retry sentence when the call never answered with a code', async () => {
    const user = userEvent.setup();
    mocks.purchaseTicket.mockRejectedValue(new Error('network'));
    renderSheet();
    await user.click(screen.getByRole('button', { name: '$30.00 결제하기' }));

    expect(await screen.findByText('결제하지 못했어요. 잠시 뒤 다시 시도해 주세요')).toBeTruthy();
  });
});
