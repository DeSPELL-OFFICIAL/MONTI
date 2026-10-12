import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tagToBytes32 } from '@monti/shared';
import { resetConfig } from '../../shared/config';
import { organizerCopy } from '../copy';
import { SettlementSection } from './SettlementSection';

const PLATFORM = `0x${'cc'.repeat(20)}`;
const ARTIST = `0x${'a1'.repeat(20)}`;
const copy = organizerCopy.en.settlement;

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

const NO_POLICY = { recipients: [] as unknown[], platformBps: 0, reserveBps: 0, noShowRefund: false, frozen: false, version: 0 };
const { getSettlement, readChainPolicy } = vi.hoisted(() => ({
  getSettlement: vi.fn(async (): Promise<unknown> => null),
  readChainPolicy: vi.fn(async (): Promise<unknown> => null),
}));
vi.mock('../../shared/api/firestore', () => ({ getSettlement }));
vi.mock('../../shared/chain/settlementReads', () => ({ readChainPolicy }));

function renderSection(tiers = [{ id: '1001-0', name: 'VIP', priceUsdCents: '3000' }]) {
  return render(
    <MemoryRouter>
      <SettlementSection eventId="1001" tiers={tiers} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  resetConfig();
  for (const [key, value] of Object.entries(BASE)) vi.stubEnv(key, value);
  getSettlement.mockResolvedValue(null);
  readChainPolicy.mockResolvedValue(NO_POLICY);
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetConfig();
});

/** v2: the split is frozen in the publish write, so the dashboard only reads it back. */
describe('the settlement summary on the dashboard', () => {
  it('shows the mirrored prices and the readable reasons, read-only, with the public link', async () => {
    getSettlement.mockResolvedValue({
      policy: {
        recipients: [
          { account: ARTIST, bps: 9_500, reason: '밴드', tag: 'band' },
          { account: PLATFORM, bps: 500, reason: 'MONTI platform', tag: 'platform' },
        ],
        platformBps: 500,
      },
      policyHash: `0x${'00'.repeat(32)}`,
      priceUsdCentsByTier: { '0': 3_000 },
    });
    renderSection();
    expect(await screen.findByText('밴드 · 95%')).toBeInTheDocument();
    expect(screen.getByText('MONTI platform · 5%')).toBeInTheDocument();
    expect(screen.getByText('VIP · $30')).toBeInTheDocument();
    expect(screen.getByText(copy.frozenNote)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: copy.publicLink })).toHaveAttribute('href', '/settlement/1001');
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('falls back to the chain policy (tags and prices) while the mirror is not written', async () => {
    readChainPolicy.mockResolvedValue({
      ...NO_POLICY,
      recipients: [
        { account: ARTIST, bps: 9_500, reasonHash: `0x${'01'.repeat(32)}`, tag: tagToBytes32('band') },
        { account: PLATFORM, bps: 500, reasonHash: `0x${'02'.repeat(32)}`, tag: tagToBytes32('platform') },
      ],
      platformBps: 500, frozen: true, version: 1,
    });
    renderSection();
    expect(await screen.findByText('band · 95%')).toBeInTheDocument();
    expect(screen.getByText('platform · 5%')).toBeInTheDocument();
    expect(screen.getByText('VIP · $30')).toBeInTheDocument();
  });

  it('draws nothing for a free event, which carries no policy', async () => {
    const { container } = renderSection([{ id: '1001-0', name: 'General', priceUsdCents: '0' }]);
    await vi.waitFor(() => expect(readChainPolicy).toHaveBeenCalled());
    await vi.waitFor(() => expect(container.textContent).toBe(''));
  });

  it('is hidden entirely when the settlement feature is not wired', () => {
    vi.stubEnv('VITE_ADDR_SETTLEMENT_VAULT', '');
    resetConfig();
    const { container } = renderSection();
    expect(container.textContent).toBe('');
    expect(getSettlement).not.toHaveBeenCalled();
  });
});
