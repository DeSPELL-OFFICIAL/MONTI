/**
 * The one place a USD amount becomes a string. Every settlement screen shows money in test USDC,
 * stored as integer cents (6-dp USDC collapsed to 2 dp for people), so a single formatter keeps
 * `$30`, `$30.50` and `$30.05` consistent across the organiser editor, the purchase sheet and the
 * receipt. No locale currency symbol switching: the demo prices are dollars and the badge beside
 * them already says this is the test environment.
 */

/** `3000` → `"$30"`, `3050` → `"$30.50"`. Negative or non-finite input is clamped to `"$0"`. */
export function formatUsdCents(cents: number): string {
  if (!Number.isFinite(cents) || cents < 0) return '$0';
  const whole = Math.floor(cents / 100);
  const frac = Math.round(cents % 100);
  return frac === 0 ? `$${whole}` : `$${whole}.${frac.toString().padStart(2, '0')}`;
}

/** A whole-dollar input (`"30"`) → integer cents (`3000`). Blank or invalid → `null`. */
export function dollarsToCents(input: string): number | null {
  const trimmed = input.trim();
  if (trimmed === '') return null;
  if (!/^\d+(\.\d{0,2})?$/.test(trimmed)) return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.round(value * 100);
}

/** Integer cents back to the editable dollar string the price input shows (`3000` → `"30"`). */
export function centsToDollars(cents: number): string {
  if (!Number.isFinite(cents) || cents <= 0) return '';
  return cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);
}
