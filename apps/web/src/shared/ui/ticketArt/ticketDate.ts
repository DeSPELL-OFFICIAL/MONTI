/**
 * The day an event starts, as the one line a ticket has room for.
 *
 * A ticket's stub carries a date and not a date *and* a time: the frame gives it one line, and
 * the screen the ticket links to already says the hour. `dateStyle: 'medium'` is the same
 * shape the discover list uses (`formatEventDay`), so the day reads identically wherever
 * somebody meets it.
 *
 * A missing start is `''` and draws nothing at all. That is a real answer rather than an
 * error: the indexer has no row for an event nobody has published yet, and an organiser's
 * preview is often opened before a start time has been picked. A placeholder date on a ticket
 * would be worse than no date, because it would look like a date.
 *
 * @param startsAt Unix seconds, as the chain and the indexer hold it. `0` means unknown.
 */
export function formatTicketDate(startsAt: number, locale: string): string {
  const at = startsAt * 1000;
  if (!Number.isFinite(at) || at <= 0) return '';
  return new Date(at).toLocaleDateString(locale, { dateStyle: 'medium' });
}
