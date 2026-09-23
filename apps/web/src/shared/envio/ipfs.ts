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
  /**
   * The poster's own CID, exactly as the document stores it and before {@link image} turns it
   * into a URL. It is what re-pinning an edited event has to send back (`pinEventMetadata`
   * takes `meta.imageCid`), and there is no way back to it from a gateway URL — so it is kept
   * rather than reconstructed. `''` for a document whose `image` is an ordinary http address.
   */
  imageCid: string;
  venue: string;
  category: number;
  region: string;
  /** At most five, each at most 12 code points; the server pinned them already normalised. */
  tags: string[];
  /**
   * The venue is for ticket holders only, so the document carries no `venue` key at all and
   * the real one is behind `getEventPrivate`. The chain still holds the hash of the real
   * venue, so what an organiser promised at creation stays provable.
   */
  venueHidden: boolean;
  /**
   * The start time is for ticket holders only. A **rendering** rule and not storage: the chain
   * always carries the real `startsAt` because the entry window is derived from it, so hiding
   * it is what the app shows, not what anyone could prove. A public record is a public record.
   */
  timeHidden: boolean;
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
  tags?: unknown;
  venueHidden?: unknown;
  timeHidden?: unknown;
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
    imageCid: image.startsWith(IPFS_SCHEME) ? image.slice(IPFS_SCHEME.length)
      : image.startsWith('http') ? '' : image,
    venue: text(fields.venue),
    category: typeof fields.category === 'number' ? fields.category : 0,
    region: text(fields.region),
    tags: Array.isArray(fields.tags)
      ? fields.tags.filter((tag): tag is string => typeof tag === 'string' && tag !== '')
      : [],
    // The server only pins these two when they are true, so a missing key is `false` — which
    // is also the right answer for every document pinned before they existed.
    venueHidden: fields.venueHidden === true,
    timeHidden: fields.timeHidden === true,
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
