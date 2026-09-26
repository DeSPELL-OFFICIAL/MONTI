import { callableFailure } from './api/functions';
import type { Copy } from './copy/index';
import type { EnvioErrorKind } from './envio/client';

/** `EnvioError.name`. Compared as a string, never as a class — see {@link indexerKind}. */
const ENVIO_ERROR = 'EnvioError';

/** The kind that means the request never reached the indexer at all. */
const UNREACHABLE: EnvioErrorKind = 'network';

/** The kinds that mean the indexer answered, badly: a status, an `errors` array, no `data`. */
const INDEXER_DOWN: ReadonlySet<string> = new Set<EnvioErrorKind>(['http', 'graphql', 'empty']);

/**
 * The `kind` of an indexer failure, or `''` for a rejection that is not one.
 *
 * Read structurally — `name` and a string `kind` — and never with `instanceof`: every screen
 * test in this app mocks `shared/envio/client`, so the `EnvioError` a screen would compare
 * against is not the class the rejection under test was built from, and the branch would be
 * false exactly where it matters. `callableFailure` reads `code`/`message` the same way and
 * documents the same reason.
 */
function indexerKind(error: unknown): string {
  if (typeof error !== 'object' || error === null) return '';
  const { name, kind } = error as { name?: unknown; kind?: unknown };
  if (name !== ENVIO_ERROR || typeof kind !== 'string') return '';
  return kind;
}

/**
 * The sentence to put on the screen for a failure, decided in one place so that five screens
 * do not each keep their own copy of the same `switch` (§C-3 of the UX plan). A screen writes
 * `{describeFailure(error, copy)}`, and hands a `table` when the server has reasons worth a
 * sentence of their own.
 *
 * The order is the design, not an accident:
 *
 *  1. **Offline first.** A browser with no connection rejects the fetch, and `gql` turns that
 *     into `kind: 'network'` — so every step below would read the person's own aeroplane mode
 *     as the indexer's fault. It is also the only step that can promise the page comes back on
 *     its own, because React Query refetches when the connection returns.
 *  2. **`network`.** The request never got there. Worth its own sentence because pressing the
 *     retry really can work.
 *  3. **`http` · `graphql` · `empty`.** The indexer answered, badly. Retrying in the same
 *     second will not help, so the sentence says "not right now" rather than "try again".
 *  4. **The callable `reason` the caller named.** After the two indexer steps, because only
 *     one of the two can be true of any one rejection and the indexer kinds are the more
 *     specific fact; after offline, because a dropped call arrives as `internal`/`UNKNOWN`
 *     and that is never the reason the person is actually stuck.
 *  5. **Everything else** — a bug here, a revert, a reason no table names — keeps the general
 *     line this app has always shown.
 */
export function describeFailure(
  error: unknown,
  copy: Copy,
  table?: Readonly<Record<string, string>>,
): string {
  if (navigator.onLine === false) return copy.common.offlineRetry;

  const kind = indexerKind(error);
  if (kind === UNREACHABLE) return copy.common.fetchFailed;
  if (INDEXER_DOWN.has(kind)) return copy.common.serviceDown;

  const { reason } = callableFailure(error);
  // `hasOwn`, not a truthiness test: a reason that happens to name something on `Object`'s
  // prototype is not a sentence this caller wrote.
  const named = table !== undefined && Object.hasOwn(table, reason) ? table[reason] : undefined;
  if (named !== undefined) return named;

  return copy.common.error;
}
