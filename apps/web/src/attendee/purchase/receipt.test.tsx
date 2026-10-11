import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrderView } from '../../shared/api/firestore';
import { resetConfig } from '../../shared/config';
import { Receipt } from './Receipt';

const ARTIST = `0x${'a1'.repeat(20)}`;
const PLATFORM = `0x${'cc'.repeat(20)}`;

const BASE = {
  VITE_CHAIN_ID: '10143',
  VITE_RPC_URLS: 'https://a.example/rpc',
  VITE_WS_URL: 'wss://testnet-rpc.monad.xyz',
  VITE_ADDR_IDENTITY: `0x${'11'.repeat(20)}`,
  VITE_ADDR_ORGANIZERS: `0x${'22'.repeat(20)}`,
  VITE_ADDR_TICKET: `0x${'33'.repeat(20)}`,
  VITE_ADDR_FORWARDER: `0x${'55'.repeat(20)}`,
  VITE_ENVIO_URL: 'https://indexer.example/v1/graphql',
  VITE_RP_ID: 'monti.despell.io',
  VITE_IPFS_GATEWAY: 'https://gateway.pinata.cloud/ipfs/',
};

const SETTLEMENT = {
  policy: {
    recipients: [
      { account: ARTIST, bps: 9000, reason: '아티스트', tag: 'artist' },
      { account: PLATFORM, bps: 1000, reason: 'MONTI 플랫폼', tag: 'platform' },
    ],
    platformBps: 1000,
  },
  policyHash: `0x${'00'.repeat(32)}`,
  priceUsdCentsByTier: { '0': 3000 },
};

const mocks = vi.hoisted(() => ({
  orderIdForToken: vi.fn((): string | null => 'o1'),
  orderIdForEvent: vi.fn((): string | null => null),
  getSettlement: vi.fn(async (): Promise<unknown> => null),
  watchOrder: vi.fn((_id: string, onChange: (o: OrderView | null) => void) => {
    onChange(currentOrder);
    return () => undefined;
  }),
  refundOrder: vi.fn(async (_p: unknown) => ({ orderId: 'o1', status: 'refunded' })),
}));
let currentOrder: OrderView | null = null;

vi.mock('./orderStore', () => ({ orderIdForToken: mocks.orderIdForToken, orderIdForEvent: mocks.orderIdForEvent }));
vi.mock('../../shared/api/firestore', () => ({ getSettlement: mocks.getSettlement, watchOrder: mocks.watchOrder }));
vi.mock('../../shared/api/functions', () => ({ api: { refundOrder: mocks.refundOrder } }));

function renderReceipt(canRefund = true) {
  return render(<Receipt tokenId="42" eventId="5" canRefund={canRefund} />);
}

beforeEach(() => {
  for (const [k, v] of Object.entries(BASE)) vi.stubEnv(k, v);
  resetConfig();
  currentOrder = {
    orderId: 'o1', eventId: '5', tier: 0, tokenId: '42', amountUsdCents: 3000,
    status: 'deposited', createdAt: Date.UTC(2026, 9, 1), depositTxHash: `0x${'de'.repeat(32)}`,
  };
  mocks.orderIdForToken.mockReturnValue('o1');
  mocks.orderIdForEvent.mockReturnValue(null);
  mocks.getSettlement.mockResolvedValue(SETTLEMENT);
  vi.clearAllMocks();
  mocks.orderIdForToken.mockReturnValue('o1');
  mocks.getSettlement.mockResolvedValue(SETTLEMENT);
});

afterEach(() => {
  resetConfig();
  vi.unstubAllEnvs();
});

describe('Receipt', () => {
  it('shows the amount, the held status and the by-role split from the policy × amount', async () => {
    renderReceipt();
    expect(await screen.findByText('$30.00')).toBeTruthy();
    expect(screen.getByText('결제 금액 보관 중 · 입장하면 자동으로 나눠 보내요')).toBeTruthy();
    // 90% / 10% of $30 → $27 / $3, floor with dust to the last row.
    expect(await screen.findByText('아티스트 · $27.00')).toBeTruthy();
    expect(screen.getByText('MONTI 플랫폼 · $3.00')).toBeTruthy();
  });

  it('asks first, then refunds a held order before the event and says so', async () => {
    const user = userEvent.setup();
    renderReceipt(true);
    const button = await screen.findByRole('button', { name: '환불받기' });
    await user.click(button);
    // One tap only opens the question — nothing irreversible has happened yet.
    const sheet = await screen.findByRole('dialog', { name: '환불할까요?' });
    expect(sheet).toHaveTextContent('환불하면 이 티켓으로 입장할 수 없어요. 결제한 $30.00은 결제 수단으로 돌아가요.');
    expect(mocks.refundOrder).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '환불하기' }));
    await waitFor(() => expect(mocks.refundOrder).toHaveBeenCalledWith({ orderId: 'o1' }));
    expect(await screen.findByText('환불했어요')).toBeTruthy();
  });

  it('does nothing when the refund question is answered 아니요', async () => {
    const user = userEvent.setup();
    renderReceipt(true);
    await user.click(await screen.findByRole('button', { name: '환불받기' }));
    await user.click(await screen.findByRole('button', { name: '아니요' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mocks.refundOrder).not.toHaveBeenCalled();
  });

  it('tells the detail screen the order status', async () => {
    currentOrder = { ...currentOrder!, status: 'refunded' };
    const onStatus = vi.fn();
    render(<Receipt tokenId="42" eventId="5" canRefund onStatus={onStatus} />);
    await waitFor(() => expect(onStatus).toHaveBeenCalledWith('refunded'));
  });

  it('shows the settled status and offers no refund once released', async () => {
    currentOrder = { ...currentOrder!, status: 'released' };
    renderReceipt(true);
    expect(await screen.findByText('정산 완료 · 정해진 비율대로 나눠 보냈어요')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '환불받기' })).toBeNull();
  });

  it('shows the refunded status', async () => {
    currentOrder = { ...currentOrder!, status: 'refunded' };
    renderReceipt(true);
    expect(await screen.findByText('환불됨')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '환불받기' })).toBeNull();
  });

  it.each(['pending', 'sent', 'failed'] as const)('shows no receipt for a %s order — only a paid one has one', (status) => {
    currentOrder = { ...currentOrder!, status };
    const { container } = renderReceipt();
    expect(container.firstChild).toBeNull();
    expect(screen.queryByText('처리 중이에요')).toBeNull();
  });

  it('renders nothing for a free ticket with no recorded order', () => {
    mocks.orderIdForToken.mockReturnValue(null);
    mocks.orderIdForEvent.mockReturnValue(null);
    const { container } = renderReceipt();
    expect(container.firstChild).toBeNull();
  });
});
