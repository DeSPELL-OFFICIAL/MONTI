import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetConfig } from '../../shared/config';
import { SettlementSection } from './SettlementSection';
import { buildPolicyAuth } from './buildPolicyAuth';

const PLATFORM = `0x${'cc'.repeat(20)}`;
const ARTIST = `0x${'a1'.repeat(20)}`;

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
  VITE_ADDR_SETTLEMENT_VAULT: `0x${'44'.repeat(20)}`,
  VITE_ADDR_USDC: `0x${'66'.repeat(20)}`,
  VITE_ADDR_PLATFORM: PLATFORM,
};

vi.mock('./buildPolicyAuth', () => ({
  SET_POLICY_DEADLINE_SECONDS: 600,
  buildPolicyAuth: vi.fn(async (params: { policy?: unknown; recipients: unknown[]; platformBps: number }) => ({
    policy: { recipients: params.recipients, platformBps: params.platformBps },
    auth: { nonce: '0', deadline: '9999999999' },
    deviceSig: `0x${'ab'.repeat(64)}`,
  })),
}));

// Hoisted so the vi.mock factories (which vitest lifts above the imports) can reference them
// without hitting the temporal dead zone — the module under test imports these on first render.
const { getSettlement, watchSettlement, watchRelayStatus, readChainPolicy, readPolicyNonce, relaySetPolicy } =
  vi.hoisted(() => ({
    getSettlement: vi.fn(async (): Promise<unknown> => null),
    watchSettlement: vi.fn(() => () => undefined),
    watchRelayStatus: vi.fn(() => () => undefined),
    readChainPolicy: vi.fn(async () => ({
      recipients: [] as unknown[], platformBps: 0, reserveBps: 0, noShowRefund: false, frozen: false, version: 0,
    })),
    readPolicyNonce: vi.fn(async () => 0n),
    relaySetPolicy: vi.fn(async (_payload: unknown) => ({ relayId: 'r1', status: 'confirmed', txHash: '0xabc' })),
  }));
vi.mock('../../shared/api/firestore', () => ({ getSettlement, watchSettlement, watchRelayStatus }));
vi.mock('../../shared/chain/settlementReads', () => ({ readChainPolicy, readPolicyNonce }));
vi.mock('../../shared/api/functions', () => ({ api: { relaySetPolicy } }));

function renderSection() {
  return render(
    <MemoryRouter>
      <SettlementSection eventId="5" tiers={[{ id: '5-0', name: '일반' }]} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  for (const [k, v] of Object.entries(BASE)) vi.stubEnv(k, v);
  resetConfig();
  getSettlement.mockResolvedValue(null);
  readChainPolicy.mockResolvedValue({
    recipients: [], platformBps: 0, reserveBps: 0, noShowRefund: false, frozen: false, version: 0,
  });
  relaySetPolicy.mockResolvedValue({ relayId: 'r1', status: 'confirmed', txHash: '0xabc' });
  vi.clearAllMocks();
});

afterEach(() => {
  resetConfig();
  vi.unstubAllEnvs();
});

describe('SettlementSection', () => {
  it('shows the title and the test-environment badge', async () => {
    renderSection();
    expect(await screen.findByText('정산 설정')).toBeTruthy();
    expect(screen.getByText('테스트 환경')).toBeTruthy();
  });

  it('keeps 확정 disabled until the price is set and the split sums to 100%', async () => {
    renderSection();
    const confirm = await screen.findByRole('button', { name: '정산 규칙 확정' });
    // Default: one locked 5% platform row, no prices. Not sendable.
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
  });

  it('signs and relays the policy when the split is valid, then shows the public link', async () => {
    const user = userEvent.setup();
    renderSection();
    await screen.findByRole('button', { name: '정산 규칙 확정' });

    // Price the one tier.
    await user.type(screen.getByLabelText('일반 ($)'), '30');
    // Add an artist recipient and give them 95% (platform keeps its 5%).
    await user.click(screen.getByRole('button', { name: '수령인 추가' }));
    const percentInput = screen.getAllByLabelText('비율 %')[1] as HTMLInputElement;
    await user.clear(percentInput);
    await user.type(percentInput, '95');
    await user.type(screen.getByLabelText('수령 계정'), ARTIST);

    const confirm = screen.getByRole('button', { name: '정산 규칙 확정' });
    await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(false));
    await user.click(confirm);

    await waitFor(() => expect(relaySetPolicy).toHaveBeenCalledTimes(1));
    expect(vi.mocked(buildPolicyAuth)).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: '5', platformBps: 500 }),
    );
    const payload = (relaySetPolicy.mock.calls[0] ?? [])[0] as { eventId: string; priceUsdCentsByTier: Record<string, number> };
    expect(payload.eventId).toBe('5');
    expect(payload.priceUsdCentsByTier).toEqual({ '0': 3000 });
    expect(await screen.findByText('정산 내역 보기')).toBeTruthy();
  });

  it('is read-only after the first sale freezes the policy', async () => {
    getSettlement.mockResolvedValue({
      policy: { recipients: [{ account: ARTIST, bps: 9500, reason: '아티스트', tag: 'artist' }, { account: PLATFORM, bps: 500, reason: 'MONTI 플랫폼', tag: 'platform' }], platformBps: 500 },
      policyHash: `0x${'00'.repeat(32)}`,
      priceUsdCentsByTier: { '0': 3000 },
    });
    readChainPolicy.mockResolvedValue({
      recipients: [], platformBps: 500, reserveBps: 0, noShowRefund: false, frozen: true, version: 1,
    });
    renderSection();

    expect(await screen.findByText('첫 판매 뒤로는 바꿀 수 없어요')).toBeTruthy();
    expect(screen.getByText('정산 내역 보기')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '정산 규칙 확정' })).toBeNull();
  });
});
