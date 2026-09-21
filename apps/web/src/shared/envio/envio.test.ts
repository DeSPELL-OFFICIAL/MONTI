import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EnvioError, gql } from './client';
import { EVENTS_QUERY, EVENT_QUERY, MY_TICKETS_QUERY } from './queries';
import { clearMetadataCache, fetchEventMetadata, gatewayUrl, normalizeMetadata } from './ipfs';
import { getConfig, resetConfig } from '../config';

const fetchMock = vi.fn();
// getConfig() is fail-fast on every VITE_* variable, and a Pinata token is the one a working
// copy is free to leave blank. Supplying it here keeps these tests independent of .env.local.
beforeAll(() => {
  vi.stubEnv('VITE_PINATA_JWT', 'test-jwt');
  resetConfig();
});

afterAll(() => {
  vi.unstubAllEnvs();
  resetConfig();
});


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
    expect(MY_TICKETS_QUERY).not.toMatch(/\$(eventId|tokenId):\s*String!/);
  });

  it('selects only columns that exist in the indexer schema', () => {
    // A column the schema does not have answers with a GraphQL error, not an empty page.
    expect(EVENTS_QUERY).toContain('regionCode');
    expect(EVENTS_QUERY).toContain('requireKyc');
    expect(EVENT_QUERY).toContain('idx name priceUsdCents supply minted');
    expect(EVENT_QUERY).not.toContain('sold');
    expect(EVENTS_QUERY).toContain('status: { _eq: "Published" }');
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

  it('accepts the wizard document, which names the title `title`', () => {
    expect(normalizeMetadata({ title: '재즈 나이트', venue: '한남', category: 2, region: 'KR-11' })).toEqual({
      title: '재즈 나이트',
      description: '',
      image: '',
      venue: '한남',
      category: 2,
      region: 'KR-11',
    });
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

  it('stops waiting for the gateway after five seconds', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ name: 'x' }));
    await fetchEventMetadata('cid-timeout');
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('leaves an http image alone and prefixes a bare CID', () => {
    expect(gatewayUrl('https://example.test/a.png')).toBe('https://example.test/a.png');
    expect(gatewayUrl('bafkreiabc')).toBe(`${getConfig().ipfsGateway}bafkreiabc`);
  });
});
