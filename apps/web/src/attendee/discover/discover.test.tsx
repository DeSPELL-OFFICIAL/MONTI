import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { keccak256, toBytes } from 'viem';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The indexer is not deployed yet, so both sides of the data path are mocked: the GraphQL
// transport and the gateway read. Every assertion below is about what the screen does with
// the rows, never about how they arrive.
const gql = vi.fn();
const fetchEventMetadata = vi.fn();
vi.mock('../../shared/envio/client', () => ({ gql }));
vi.mock('../../shared/envio/ipfs', () => ({ fetchEventMetadata }));

const { Discover } = await import('./Discover');
const { EventDetail } = await import('./EventDetail');
const { METADATA_CONCURRENCY, mapWithPool } = await import('./useEvents');

const NOW_SECONDS = Math.floor(Date.now() / 1000);
const IN_TWO_DAYS = String(NOW_SECONDS + 2 * 86_400);
const IN_TWENTY_DAYS = String(NOW_SECONDS + 20 * 86_400);

// EventMeta.regionCode is keccak256(<ISO region>) on chain, so a fixture hashes the same way
// the picker does — computed here with viem directly rather than through the code under test.
const EVENT_ONE = {
  id: '1', orgId: '1', imageCid: 'cid-a', startsAt: IN_TWO_DAYS, endsAt: String(Number(IN_TWO_DAYS) + 3_600),
  saleStart: '1780000000', saleEnd: IN_TWO_DAYS, transferable: true, transferCutoffSeconds: '3600',
  maxTransfers: 3, category: 0, regionCode: keccak256(toBytes('KR-11')), status: 'Published', requireKyc: true,
};
const EVENT_TWO = {
  ...EVENT_ONE, id: '2', imageCid: 'cid-b', startsAt: IN_TWENTY_DAYS,
  endsAt: String(Number(IN_TWENTY_DAYS) + 3_600), category: 1,
  regionCode: keccak256(toBytes('KR-26')), requireKyc: false,
};

const META_A = { title: '재즈 나이트', description: '한남동의 밤', image: '', venue: '한남', category: 0, region: 'KR-11' };
const META_B = { title: '개발자 모임', description: '', image: '', venue: '해운대', category: 1, region: 'KR-26' };

const TIERS = [
  { id: '1-0', eventId: '1', idx: 0, name: '일반', priceUsdCents: '0', supply: '100', minted: '40', maxPerWallet: '2', seated: false },
];

function metadataByCid(cid: string) {
  if (cid === 'cid-a') return Promise.resolve(META_A);
  if (cid === 'cid-b') return Promise.resolve(META_B);
  return Promise.reject(new Error('IPFS_504'));
}

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderDiscover() {
  return render(
    <QueryClientProvider client={client()}>
      <MemoryRouter>
        <Discover />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function renderDetail(eventId = '1') {
  return render(
    <QueryClientProvider client={client()}>
      <MemoryRouter initialEntries={[`/events/${eventId}`]}>
        <Routes>
          <Route path="/events/:eventId" element={<EventDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  gql.mockReset();
  fetchEventMetadata.mockReset();
  gql.mockResolvedValue({ Event: [EVENT_ONE, EVENT_TWO] });
  fetchEventMetadata.mockImplementation(metadataByCid);
});

describe('Discover', () => {
  it('lists the published page and badges only the events that need verification', async () => {
    renderDiscover();
    expect(await screen.findByText('재즈 나이트')).toBeInTheDocument();
    expect(screen.getByText('개발자 모임')).toBeInTheDocument();
    expect(screen.getAllByText('KYC 필요')).toHaveLength(1);
    expect(screen.getByRole('link', { name: /재즈 나이트/ })).toHaveAttribute('href', '/events/1');
  });

  it('filters the loaded page by the title search box', async () => {
    renderDiscover();
    expect(await screen.findByText('재즈 나이트')).toBeInTheDocument();
    await userEvent.type(screen.getByPlaceholderText('행사 이름 검색'), '개발자');
    expect(screen.queryByText('재즈 나이트')).toBeNull();
    expect(screen.getByText('개발자 모임')).toBeInTheDocument();
    expect(screen.queryByText('KYC 필요')).toBeNull();
  });

  it('narrows by date, region and theme', async () => {
    renderDiscover();
    expect(await screen.findByText('재즈 나이트')).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText('날짜'), 'week');
    expect(screen.queryByText('개발자 모임')).toBeNull();
    expect(screen.getByText('재즈 나이트')).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText('날짜'), 'all');
    await userEvent.selectOptions(screen.getByLabelText('지역'), 'KR-26');
    expect(screen.queryByText('재즈 나이트')).toBeNull();
    expect(screen.getByText('개발자 모임')).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText('지역'), '');
    await userEvent.selectOptions(screen.getByLabelText('테마'), '0');
    expect(screen.getByText('재즈 나이트')).toBeInTheDocument();
    expect(screen.queryByText('개발자 모임')).toBeNull();
  });

  it('remembers the last filter across mounts', async () => {
    const first = renderDiscover();
    expect(await screen.findByText('재즈 나이트')).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('지역'), 'KR-26');
    first.unmount();

    renderDiscover();
    expect(await screen.findByText('개발자 모임')).toBeInTheDocument();
    expect(screen.queryByText('재즈 나이트')).toBeNull();
  });

  it('keeps an event whose metadata never arrives, under a neutral placeholder', async () => {
    fetchEventMetadata.mockImplementation((cid: string) =>
      cid === 'cid-a' ? Promise.resolve(META_A) : Promise.reject(new Error('IPFS_504')),
    );
    renderDiscover();
    expect(await screen.findByText('재즈 나이트')).toBeInTheDocument();
    expect(screen.getByText('제목을 불러오지 못했어요')).toBeInTheDocument();
  });

  it('shows an error state when the indexer fails', async () => {
    gql.mockRejectedValue(new Error('HTTP_500'));
    renderDiscover();
    expect(await screen.findByRole('alert')).toHaveTextContent('문제가 생겼어요. 잠시 뒤 다시 시도해 주세요.');
    expect(screen.getByRole('button', { name: '다시 시도' })).toBeInTheDocument();
  });
});

describe('gateway fan-out', () => {
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  it('runs at most the pool width at once and still answers in input order', async () => {
    const waiting: Array<() => void> = [];
    let inFlight = 0;
    let peak = 0;
    let settled = false;

    const doubled = mapWithPool([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 4, async (value: number) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((resolve) => waiting.push(resolve));
      inFlight -= 1;
      return value * 2;
    });
    void doubled.then(() => {
      settled = true;
    });

    await tick();
    expect(waiting).toHaveLength(4);
    expect(peak).toBe(4);

    // Finish the started work newest-first, so completion order never matches input order.
    for (let round = 0; round < 20 && !settled; round += 1) {
      for (const resolve of waiting.splice(0, waiting.length).reverse()) resolve();
      await tick();
    }

    await expect(doubled).resolves.toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18, 20]);
    expect(peak).toBe(4);
  });

  it('never opens the whole page of gateway reads at once', async () => {
    const page = Array.from({ length: 12 }, (_, index) => ({
      ...EVENT_ONE,
      id: String(index + 1),
      imageCid: `cid-${index}`,
    }));
    gql.mockResolvedValue({ Event: page });

    let inFlight = 0;
    let peak = 0;
    fetchEventMetadata.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return META_A;
    });

    renderDiscover();
    expect(await screen.findAllByRole('link')).toHaveLength(12);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(METADATA_CONCURRENCY);
  });
});

describe('EventDetail', () => {
  it('shows the gateway metadata and the tiers', async () => {
    gql.mockResolvedValue({ Event: [EVENT_ONE], Tier: TIERS });
    renderDetail();
    expect(await screen.findByRole('heading', { name: '재즈 나이트' })).toBeInTheDocument();
    expect(screen.getByText('한남동의 밤')).toBeInTheDocument();
    expect(screen.getByText('일반')).toBeInTheDocument();
    expect(screen.getByText('60자리 남음')).toBeInTheDocument();
    expect(screen.getByText('KYC 필요')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '티켓 받기' })).toHaveAttribute('href', '/claim/1');
  });

  it('asks the indexer for the numeric event id', async () => {
    gql.mockResolvedValue({ Event: [EVENT_ONE], Tier: TIERS });
    renderDetail();
    await screen.findByRole('heading', { name: '재즈 나이트' });
    expect(gql).toHaveBeenCalledWith(expect.stringContaining('$eventId: numeric!'), { id: '1', eventId: '1' });
  });

  it('replaces the call to action when the event was called off', async () => {
    gql.mockResolvedValue({ Event: [{ ...EVENT_ONE, status: 'Cancelled' }], Tier: TIERS });
    renderDetail();
    expect(await screen.findByText('취소된 행사예요.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '티켓 받기' })).toBeNull();
  });

  it('hides the share button where the phone has no share sheet', async () => {
    gql.mockResolvedValue({ Event: [EVENT_ONE], Tier: TIERS });
    renderDetail();
    await screen.findByRole('heading', { name: '재즈 나이트' });
    expect(screen.queryByRole('button', { name: '공유' })).toBeNull();
  });

  it('swallows the rejection a dismissed share sheet throws', async () => {
    const share = vi.fn(async () => {
      throw Object.assign(new Error('dismissed'), { name: 'AbortError' });
    });
    Object.defineProperty(navigator, 'share', { value: share, configurable: true, writable: true });
    try {
      gql.mockResolvedValue({ Event: [EVENT_ONE], Tier: TIERS });
      renderDetail();
      await screen.findByRole('heading', { name: '재즈 나이트' });
      await userEvent.click(screen.getByRole('button', { name: '공유' }));
      expect(share).toHaveBeenCalledWith({ url: window.location.href });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    } finally {
      Reflect.deleteProperty(navigator, 'share');
    }
  });

  it('shows an error state when the event cannot be read', async () => {
    gql.mockRejectedValue(new Error('HTTP_500'));
    renderDetail();
    expect(await screen.findByRole('alert')).toHaveTextContent('문제가 생겼어요. 잠시 뒤 다시 시도해 주세요.');
  });
});
