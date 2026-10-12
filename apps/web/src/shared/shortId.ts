/**
 * A long hex identifier (a device's address, a key half) cut to what a person can read back:
 * the first and last four digits, without the `0x`, e.g. `3f9a…c21e`. The full value is never
 * dropped by a screen that uses this — it waits under 상세 with a copy button.
 */
export function shortId(value: string): string {
  const digits = value.startsWith('0x') || value.startsWith('0X') ? value.slice(2) : value;
  return digits.length > 10 ? `${digits.slice(0, 4)}…${digits.slice(-4)}`.toLowerCase() : digits;
}
