// Display names for accounts (P5). Nicknames live on the server now (`nicknames/{name}`), not on
// chain or in the index, so every screen that names an account asks `resolveNicknames` — at most
// RESOLVE_NICKNAMES_BATCH accounts per call — through this one cache. Accounts are keyed
// lowercase, the way the callable answers.
import { api } from './functions';

/** The callable's own cap on accounts per call. */
export const RESOLVE_NICKNAMES_BATCH = 100;
/** How long an answer (a name, or "no name") is trusted before it is asked again. */
export const NICKNAME_CACHE_MS = 5 * 60_000;

interface Entry {
  name: string | null;
  at: number;
}

const cache = new Map<string, Entry>();

/** Forget every cached answer (tests, and a sign-out that should not carry names over). */
export function clearNicknameCache(): void {
  cache.clear();
}

/** Record a name this device just saved, so its own screens show it without waiting. */
export function rememberNickname(account: string, name: string): void {
  cache.set(account.toLowerCase(), { name, at: Date.now() });
}

/**
 * The nicknames of `accounts`, keyed by lowercase account; an account without one is absent.
 * Fresh cached answers are reused; the rest is asked in batches of at most
 * {@link RESOLVE_NICKNAMES_BATCH}. A failed call rejects — callers treat a name as a courtesy.
 */
export async function resolveNicknames(accounts: readonly string[]): Promise<Record<string, string>> {
  const wanted = [...new Set(accounts.map((account) => account.toLowerCase()))];
  const now = Date.now();
  const missing = wanted.filter((account) => {
    const hit = cache.get(account);
    return hit === undefined || now - hit.at > NICKNAME_CACHE_MS;
  });

  for (let i = 0; i < missing.length; i += RESOLVE_NICKNAMES_BATCH) {
    const batch = missing.slice(i, i + RESOLVE_NICKNAMES_BATCH);
    const { names } = await api.resolveNicknames({ accounts: batch });
    const at = Date.now();
    const byAccount = new Map(Object.entries(names).map(([account, name]) => [account.toLowerCase(), name]));
    for (const account of batch) cache.set(account, { name: byAccount.get(account) ?? null, at });
  }

  const out: Record<string, string> = {};
  for (const account of wanted) {
    const name = cache.get(account)?.name;
    if (name) out[account] = name;
  }
  return out;
}
