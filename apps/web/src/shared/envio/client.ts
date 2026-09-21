import { getConfig } from '../config';

/**
 * Why a call to the indexer failed. `network` covers a dropped connection and the timeout;
 * `http` a non-2xx answer; `graphql` an `errors` array; `empty` a 200 with no `data`.
 */
export type EnvioErrorKind = 'network' | 'http' | 'graphql' | 'empty';

/**
 * Every rejection out of {@link gql} is one of these, so a caller branches on `kind` (and
 * `status` for an HTTP failure) instead of inspecting `unknown`. Neither field is copy — the
 * screen picks its own sentence from them.
 */
export class EnvioError extends Error {
  readonly kind: EnvioErrorKind;
  readonly status?: number;

  constructor(kind: EnvioErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'EnvioError';
    this.kind = kind;
    this.status = status;
  }
}

/** The indexer answers in milliseconds; past this a screen is better off showing its retry. */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * The only way this app talks to the indexer: one POST of `{ query, variables }` to
 * `getConfig().envioUrl`. It knows nothing about the documents it carries, so every query and
 * every row type lives in ./queries.ts and every test drives it by mocking `fetch`.
 */
export async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(getConfig().envioUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new EnvioError('network', cause instanceof Error ? cause.message : 'REQUEST_FAILED');
  }
  if (!response.ok) throw new EnvioError('http', `HTTP_${response.status}`, response.status);

  let body: { data?: T; errors?: Array<{ message?: string }> };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    throw new EnvioError('empty', 'BAD_JSON');
  }
  const first = body.errors?.[0];
  if (first) throw new EnvioError('graphql', first.message ?? 'QUERY_FAILED');
  if (!body.data) throw new EnvioError('empty', 'NO_DATA');
  return body.data;
}
