import { beforeEach, describe, expect, it, vi } from 'vitest';
import { envioPage, envioQuery } from '../src/lib/envio.js';

const URL = 'http://indexer.test/v1/graphql';

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

beforeEach(() => {
  process.env.ENVIO_GRAPHQL_URL = URL;
  fetchMock.mockReset();
});

function bodyOf(call: number): { query: string; variables: Record<string, unknown> } {
  const init = fetchMock.mock.calls[call]![1] as { body: string };
  return JSON.parse(init.body) as { query: string; variables: Record<string, unknown> };
}

describe('envioQuery', () => {
  it('posts the query and variables to the configured endpoint', async () => {
    fetchMock.mockResolvedValueOnce(reply({ data: { rows: [{ id: '1' }] } }));
    const data = await envioQuery<{ rows: { id: string }[] }>('query Q($a: numeric!) { rows }', {
      a: '11',
    });
    expect(data.rows).toEqual([{ id: '1' }]);
    expect(fetchMock.mock.calls[0]![0]).toBe(URL);
    expect(bodyOf(0)).toEqual({ query: 'query Q($a: numeric!) { rows }', variables: { a: '11' } });
  });

  it('turns an HTTP failure into ENVIO_HTTP_<status>', async () => {
    fetchMock.mockResolvedValueOnce(reply({}, 502));
    await expect(envioQuery('query {}')).rejects.toThrow('ENVIO_HTTP_502');
  });

  it('surfaces the first GraphQL error instead of a silent empty result', async () => {
    fetchMock.mockResolvedValueOnce(reply({ errors: [{ message: 'no such column' }] }));
    await expect(envioQuery('query {}')).rejects.toThrow('ENVIO_GRAPHQL:no such column');
  });

  it('refuses a 200 with no data block', async () => {
    fetchMock.mockResolvedValueOnce(reply({}));
    await expect(envioQuery('query {}')).rejects.toThrow('ENVIO_EMPTY');
  });
});

describe('envioPage', () => {
  it('walks the id cursor until a short page ends it', async () => {
    const first = Array.from({ length: 2 }, (_, i) => ({ id: String(i + 1) }));
    fetchMock
      .mockResolvedValueOnce(reply({ data: { rows: first } }))
      .mockResolvedValueOnce(reply({ data: { rows: [{ id: '3' }] } }));

    const rows = await envioPage<{ id: string }>('Ticket', 'id', 2);
    expect(rows.map((row) => row.id)).toEqual(['1', '2', '3']);
    expect(bodyOf(0).variables).toEqual({ cursor: '', limit: 2 });
    expect(bodyOf(1).variables).toEqual({ cursor: '2', limit: 2 });
  });

  it('stops after one call when the first page is already short', async () => {
    fetchMock.mockResolvedValueOnce(reply({ data: { rows: [{ id: '1' }] } }));
    await envioPage<{ id: string }>('Gate', 'id', 500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
