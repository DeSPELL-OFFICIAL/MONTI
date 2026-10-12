import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EnvioError, gql } from './client';
import { EVENTS_QUERY, EVENT_QUERY, MY_ORGS_QUERY, ORG_EVENTS_QUERY } from './queries';
import { clearMetadataCache, fetchEventMetadata, gatewayUrl, normalizeMetadata } from './ipfs';
import { getConfig } from '../config';

const fetchMock = vi.fn();

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  clearMetadataCache();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('gql', () => {
  it('posts the document and its variables to the configured indexer', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: { Event: [] } }));
    await expect(gql('query Q { Event { id } }', { limit: 100 })).resolves.toEqual({ Event: [] });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(getConfig().envioUrl);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      query: 'query Q { Event { id } }',
      variables: { limit: 100 },
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('carries the status on a non-2xx answer', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 502 }));
    const error = await gql('query Q { Event { id } }').catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(EnvioError);
    expect(error).toMatchObject({ kind: 'http', status: 502, message: 'HTTP_502' });
  });

  it('surfaces the first GraphQL error', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ errors: [{ message: 'field "nope" not found' }] }));
    await expect(gql('query Q { nope }')).rejects.toMatchObject({
      kind: 'graphql',
      message: 'field "nope" not found',
    });
  });

  it('rejects a 200 that carries no data', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    await expect(gql('query Q { Event { id } }')).rejects.toMatchObject({ kind: 'empty' });
  });

  it('turns a dropped connection into a typed rejection', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(gql('query Q { Event { id } }')).rejects.toMatchObject({ kind: 'network' });
  });
});

describe('queries', () => {
  it('declares every eventId variable as the Hasura numeric scalar', () => {
    expect(EVENT_QUERY).toContain('$eventId: numeric!');
    expect(EVENT_QUERY).not.toMatch(/\$eventId:\s*String!/);
  });

  it('selects only columns that exist in the indexer schema', () => {
    // A column the schema does not have answers with a GraphQL error, not an empty page.
    expect(EVENTS_QUERY).toContain('regionCode');
    expect(EVENTS_QUERY).toContain('requireKyc');
    expect(EVENT_QUERY).toContain('idx name priceUsdCents supply minted');
    expect(EVENT_QUERY).not.toContain('sold');
    expect(EVENTS_QUERY).toContain('status: { _eq: "Published" }');
  });

  it('declares the organiser documents with the scalar each column actually has', () => {
    // `Organizer.owner` and `Admin`/`Manager.account` are `String!`; `Event.orgId` is `BigInt!`,
    // which Hasura serves as `numeric` — so the list of ids is a list of those, not of strings.
    expect(MY_ORGS_QUERY).toContain('$me: String!');
    expect(MY_ORGS_QUERY).not.toMatch(/\$me:\s*numeric/);
    expect(ORG_EVENTS_QUERY).toContain('$orgIds: [numeric!]!');
    expect(ORG_EVENTS_QUERY).not.toMatch(/\$orgIds:\s*\[String!\]!/);
    // A manager keeps its row after removal, so only the live ones are asked for.
    expect(MY_ORGS_QUERY).toContain('exists: { _eq: true }');
  });
});

describe('fetchEventMetadata', () => {
  it('reads the document from the gateway and normalises the seeded fixture', async () => {
    const cid = 'bafkreiepv7iydmisqmk2qrht7zwfeaxtf7sljdzfbfhtthjgpovrknn754';
    const imageCid = 'bafkreiabm7aeljkckr4ftbvdbt4lkagcrxxkkw5edkghiypewy546tjivq';
    fetchMock.mockResolvedValue(
      jsonResponse({ name: 'MONTI Launch Party', description: 'hello', image: `ipfs://${imageCid}` }),
    );

    const metadata = await fetchEventMetadata(cid);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${getConfig().ipfsGateway}${cid}`);
    expect(metadata.title).toBe('MONTI Launch Party');
    expect(metadata.image).toBe(`${getConfig().ipfsGateway}${imageCid}`);
    expect(metadata.venue).toBe('');
    expect(metadata.category).toBe(0);
  });

  it('shares one gateway read between callers asking at once, and retries after a failure', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 504 }));
    await expect(fetchEventMetadata('cid-x')).rejects.toThrow('IPFS_504');

    fetchMock.mockResolvedValueOnce(jsonResponse({ name: 'Demo Night' }));
    const [list, detail] = await Promise.all([fetchEventMetadata('cid-x'), fetchEventMetadata('cid-x')]);
    expect(list.title).toBe('Demo Night');
    expect(detail).toBe(list);
    // One failed read, then exactly one more for both callers together.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('accepts a document that names the title `title` rather than `name`', () => {
    expect(normalizeMetadata({ title: '재즈 나이트', venue: '한남', category: 2, region: 'KR-11' })).toEqual({
      title: '재즈 나이트',
      description: '',
      image: '',
      imageCid: '',
      venue: '한남',
      category: 2,
      region: 'KR-11',
      // Pinned before the three existed, so each one defaults rather than going undefined.
      tags: [],
      venueHidden: false,
      timeHidden: false,
    });
  });

  /**
   * The server only pins the two flags when they are true and refuses a tag that breaks the
   * rule, so what arrives here is either right or absent. A document somebody hand-pinned is
   * neither, which is why every field is still read back at its own type.
   */
  it('reads the tags and the two visibility flags the creation scene now pins', () => {
    expect(normalizeMetadata({
      name: '재즈 나이트', tags: ['재즈', '라이브'], venueHidden: true, timeHidden: true,
    })).toMatchObject({ tags: ['재즈', '라이브'], venueHidden: true, timeHidden: true });

    // A hidden venue is a document with no `venue` key at all.
    expect(normalizeMetadata({ name: 'n', venueHidden: true }).venue).toBe('');
    // Anything that is not a list of non-empty strings is no tags.
    expect(normalizeMetadata({ name: 'n', tags: '재즈' }).tags).toEqual([]);
    expect(normalizeMetadata({ name: 'n', tags: ['재즈', 7, ''] }).tags).toEqual(['재즈']);
    // Only `true` hides anything: a truthy string is a hand edit, not a flag.
    expect(normalizeMetadata({ name: 'n', venueHidden: 'yes' }).venueHidden).toBe(false);
  });

  it('reads each CID once per session', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ name: 'once' }));
    await fetchEventMetadata('cid-cached');
    await fetchEventMetadata('cid-cached');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gives up on a gateway that answers with a failure', async () => {
    fetchMock.mockResolvedValue(new Response('no', { status: 504 }));
    await expect(fetchEventMetadata('cid-missing')).rejects.toThrow('IPFS_504');
  });

  // The public gateway answers in 5–7 s (measured 2026-10-10), so a five-second cut-off turned
  // every title into the placeholder. Twelve seconds lets a slow answer still land.
  it('stops waiting for the gateway after twelve seconds', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    fetchMock.mockResolvedValue(jsonResponse({ name: 'x' }));
    await fetchEventMetadata('cid-timeout');
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(timeout).toHaveBeenCalledWith(12_000);
    timeout.mockRestore();
  });

  it('leaves an http image alone and prefixes a bare CID', () => {
    expect(gatewayUrl('https://example.test/a.png')).toBe('https://example.test/a.png');
    expect(gatewayUrl('bafkreiabc')).toBe(`${getConfig().ipfsGateway}bafkreiabc`);
  });
});
