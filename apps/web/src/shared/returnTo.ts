/**
 * Where a screen sends someone once it is done with them — the attendee identity check, and the
 * staff phone sign-in borrowed by the gate app — travels as `?returnTo=`.
 *
 * It is one function because it is one rule: a return target is attacker-supplied, and an
 * absolute or protocol-relative URL would turn any of those screens into an open redirect off
 * the app. A second spelling of that check is a second chance to get it wrong.
 */
export function safeReturnTo(raw: string | null, fallback: string): string {
  return raw !== null && raw.startsWith('/') && !raw.startsWith('//') ? raw : fallback;
}
