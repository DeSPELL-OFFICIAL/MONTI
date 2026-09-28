/**
 * The rule `createOrganizerForMe` holds an organisation's name to
 * (functions/src/functions/createOrganizer.ts), kept here so a doomed request never leaves the
 * phone. Counted in **code points**, the way the server counts them: one emoji is one character
 * on both sides, so forty emoji are a name of forty and not of eighty.
 *
 * Two screens ask for this name — `주최사 만들기` and the one line the creation scene shows
 * somebody who has no organisation yet — and they may not disagree about what a good one is.
 */
export const ORG_NAME_MIN = 2;
export const ORG_NAME_MAX = 40;

/** C0 and C1 controls — exactly the set the server refuses. */
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;

export function isGoodOrgName(name: string): boolean {
  const trimmed = name.trim();
  const points = [...trimmed].length;
  return points >= ORG_NAME_MIN && points <= ORG_NAME_MAX && !CONTROL_RE.test(trimmed);
}
