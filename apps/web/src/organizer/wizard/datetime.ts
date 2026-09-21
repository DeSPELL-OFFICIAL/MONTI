/**
 * `<input type="datetime-local">` speaks the organiser's own clock and the chain speaks epoch
 * seconds, so the two conversions live here rather than in five step components. A blank or
 * half-typed field reads back as 0, which `validateDraft` refuses as a missing time.
 */
export function toLocalInput(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const at = new Date(seconds * 1000);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

export function fromLocalInput(value: string): number {
  const at = new Date(value).getTime();
  return Number.isFinite(at) ? Math.floor(at / 1000) : 0;
}
