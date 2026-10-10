/**
 * Where a screen sends someone once it is done with them — the attendee identity check, the
 * sign-in and signup screens a guarded route bounces a signed-out person to, and the staff phone
 * sign-in borrowed by the gate app — travels as `?returnTo=`.
 *
 * It is one function because it is one rule: a return target is attacker-supplied, and an
 * absolute or protocol-relative URL would turn any of those screens into an open redirect off
 * the app. A second spelling of that check is a second chance to get it wrong. Only a
 * same-origin relative path passes: it starts with one `/`, is not `//` or `/\` (browsers read
 * both as protocol-relative), and carries no control characters.
 */
export function safeReturnTo(raw: string | null | undefined, fallback: string): string {
  if (raw === null || raw === undefined || !raw.startsWith('/')) return fallback;
  if (raw.startsWith('//') || raw.startsWith('/\\')) return fallback;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return fallback;
  return raw;
}
