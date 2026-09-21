import { getConfig } from '../config';

/**
 * The chain carries only hashes of an event's title, description and venue, so the readable
 * half lives in one JSON document on IPFS whose CID is `Event.imageCid`. This is the shape the
 * app uses after normalising it; the document itself may name the title `name` (the fixture
 * pinned for the seeded event) or `title` (what the organiser wizard writes).
 */
export interface EventMetadata {
  title: string;
  description: string;
  /** Already an https gateway URL: an `ipfs://<cid>` value is rewritten on the way in. */
  image: string;
  venue: string;
  category: number;
  region: string;
}

const IPFS_SCHEME = 'ipfs://';
/** A gateway that has not answered by now is not going to help this render. */
const FETCH_TIMEOUT_MS = 5_000;

/** One document per CID per session: the list and the detail screen read the same rows. */
const cache = new Map<string, EventMetadata>();

/** Turns a bare CID or an `ipfs://` URI into a URL the browser can load; passes http(s) through. */
export function gatewayUrl(cidOrUri: string): string {
  const gateway = getConfig().ipfsGateway;
  if (cidOrUri.startsWith(IPFS_SCHEME)) return `${gateway}${cidOrUri.slice(IPFS_SCHEME.length)}`;
  if (cidOrUri.startsWith('http')) return cidOrUri;
  return `${gateway}${cidOrUri}`;
}

interface RawMetadata {
  name?: unknown;
  title?: unknown;
  description?: unknown;
  image?: unknown;
  venue?: unknown;
  category?: unknown;
  region?: unknown;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** A pinned document is not trusted to have any particular field, so every one is defaulted. */
export function normalizeMetadata(raw: unknown): EventMetadata {
  const fields = (typeof raw === 'object' && raw !== null ? raw : {}) as RawMetadata;
  const image = text(fields.image);
  return {
    title: text(fields.name) || text(fields.title),
    description: text(fields.description),
    image: image === '' ? '' : gatewayUrl(image),
    venue: text(fields.venue),
    category: typeof fields.category === 'number' ? fields.category : 0,
    region: text(fields.region),
  };
}

/**
 * Reads one event's metadata document. Rejects on a bad answer rather than returning a blank
 * one: the caller decides whether a missing title hides the event (it never does) or falls back
 * to a placeholder.
 */
export async function fetchEventMetadata(cid: string): Promise<EventMetadata> {
  const cached = cache.get(cid);
  if (cached) return cached;
  const response = await fetch(gatewayUrl(cid), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`IPFS_${response.status}`);
  const metadata = normalizeMetadata(await response.json());
  cache.set(cid, metadata);
  return metadata;
}

/** Only for tests: the cache is a session-long memo with no invalidation in the app. */
export function clearMetadataCache(): void {
  cache.clear();
}
