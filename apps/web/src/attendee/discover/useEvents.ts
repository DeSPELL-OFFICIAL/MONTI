import { useQuery } from '@tanstack/react-query';
import { keccak256, toBytes } from 'viem';
import { gql } from '../../shared/envio/client';
import { EVENTS_QUERY, type EnvioEvent } from '../../shared/envio/queries';
import { fetchEventMetadata, type EventMetadata } from '../../shared/envio/ipfs';

export type DateRange = 'all' | 'today' | 'week' | 'month';

export interface DiscoverFilters {
  range: DateRange;
  /** An ISO 3166-2 region such as `KR-11`, or '' for every region. */
  region: string;
  category: number | 'all';
  search: string;
}

export interface DiscoverItem {
  event: EnvioEvent;
  /** null when the gateway did not answer: the event is still listed, under a placeholder. */
  metadata: EventMetadata | null;
}

/** One page is fetched and then narrowed in the browser, so it has to be generous. */
const PAGE_SIZE = 100;
/** A public gateway rate-limits a burst of a hundred reads, so the page is read a few at a
 * time: one CID answering 429 or timing out then costs its own event a title, nothing more. */
export const METADATA_CONCURRENCY = 4;
const STORAGE_KEY = 'monti.discover.filters';
const DAY_MS = 86_400_000;

export const REGION_CODES = ['KR-11', 'KR-26', 'KR-28', 'KR-30', 'KR-41', 'KR-48'] as const;
export const CATEGORY_CODES = [0, 1, 2, 3] as const;
export const DEFAULT_FILTERS: DiscoverFilters = { range: 'all', region: '', category: 'all', search: '' };

const RANGES: ReadonlySet<string> = new Set<DateRange>(['all', 'today', 'week', 'month']);
const regionHashes = new Map<string, string>();

/**
 * `EventMeta.regionCode` is `keccak256(<ISO region>)` on chain, so the picker hashes its choice
 * instead of the indexer storing a readable code.
 */
export function regionHash(region: string): string {
  const cached = regionHashes.get(region);
  if (cached !== undefined) return cached;
  const hash = keccak256(toBytes(region));
  regionHashes.set(region, hash);
  return hash;
}

export function rangeBounds(range: DateRange, now = Date.now()): { from: number; to: number } {
  if (range === 'today') return { from: now, to: now + DAY_MS };
  if (range === 'week') return { from: now, to: now + 7 * DAY_MS };
  if (range === 'month') return { from: now, to: now + 30 * DAY_MS };
  return { from: 0, to: Number.MAX_SAFE_INTEGER };
}

/**
 * The chain holds only a hash of the title, so there is nothing for the indexer to search on:
 * the title box narrows the page already in hand. Date, region and theme are chain columns and
 * are matched against the row, not against the metadata, so a missing document never hides an
 * event from a filter that should have kept it.
 */
export function applyFilters(
  items: DiscoverItem[],
  filters: DiscoverFilters,
  now = Date.now(),
): DiscoverItem[] {
  const { from, to } = rangeBounds(filters.range, now);
  const needle = filters.search.trim().toLowerCase();
  const wanted = filters.region === '' ? '' : regionHash(filters.region);
  return items.filter(({ event, metadata }) => {
    const startsAtMs = Number(event.startsAt) * 1000;
    if (!Number.isFinite(startsAtMs) || startsAtMs < from || startsAtMs > to) return false;
    if (filters.category !== 'all' && event.category !== filters.category) return false;
    if (wanted !== '' && (event.regionCode ?? '').toLowerCase() !== wanted) return false;
    if (needle !== '' && !(metadata?.title ?? '').toLowerCase().includes(needle)) return false;
    return true;
  });
}

/** Per-viewer convenience only, so private mode losing it is not an error. */
export function loadFilters(): DiscoverFilters {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_FILTERS;
    const saved = JSON.parse(raw) as Partial<DiscoverFilters>;
    return {
      range: typeof saved.range === 'string' && RANGES.has(saved.range) ? (saved.range as DateRange) : 'all',
      region:
        typeof saved.region === 'string' && (REGION_CODES as readonly string[]).includes(saved.region)
          ? saved.region
          : '',
      category:
        typeof saved.category === 'number' && (CATEGORY_CODES as readonly number[]).includes(saved.category)
          ? saved.category
          : 'all',
      // A box that came back full would make a reopened screen look empty for no reason.
      search: '',
    };
  } catch {
    return DEFAULT_FILTERS;
  }
}

export function saveFilters(filters: DiscoverFilters): void {
  try {
    const { range, region, category } = filters;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ range, region, category }));
  } catch {
    /* private mode */
  }
}

/** The list and the detail screen show the same moment, so they format it the same way. */
export function formatEventDate(startsAt: string, locale: string): string {
  const at = Number(startsAt) * 1000;
  if (!Number.isFinite(at) || at <= 0) return '';
  return new Date(at).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * The same moment with the clock left off, for an event whose organiser chose to tell only
 * ticket holders when it starts. The day itself stays public: an event nobody can date is an
 * event nobody can plan around, and the date is what a discover screen sorts and filters on.
 */
export function formatEventDay(startsAt: string, locale: string): string {
  const at = Number(startsAt) * 1000;
  if (!Number.isFinite(at) || at <= 0) return '';
  return new Date(at).toLocaleDateString(locale, { dateStyle: 'medium' });
}

/**
 * `Promise.all` over a page would open one request per row at once. This runs at most `limit`
 * of them, each worker taking the next index as it frees up, and writes every answer back at
 * its own index — so results keep the page's order however the requests interleave.
 */
export async function mapWithPool<In, Out>(
  items: readonly In[],
  limit: number,
  work: (item: In, index: number) => Promise<Out>,
): Promise<Out[]> {
  const results = new Array<Out>(items.length) as Out[];
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await work(items[index] as In, index);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * One page of published events with each one's metadata document beside it. A document that
 * fails to load becomes null instead of failing the page: an event nobody can name is still an
 * event somebody is looking for.
 */
export function useEvents() {
  return useQuery({
    queryKey: ['events', 'published'],
    queryFn: async (): Promise<DiscoverItem[]> => {
      const { Event } = await gql<{ Event: EnvioEvent[] }>(EVENTS_QUERY, { limit: PAGE_SIZE });
      return mapWithPool(Event, METADATA_CONCURRENCY, async (event) => ({
        event,
        metadata: await fetchEventMetadata(event.imageCid).catch(() => null),
      }));
    },
  });
}
