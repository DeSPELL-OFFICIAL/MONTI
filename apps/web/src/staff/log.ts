// The staff console's one log seam.
//
// It exists so there is a single place to change when these lines need to go somewhere a staff
// member cannot see — a crash reporter, a support bundle pulled off the terminal after a door
// misbehaved. A `console.warn` scattered through the gate code would be a dozen places.
//
// Deliberately one level and one shape. A staff terminal logs the things nobody is watching for
// in the moment and everybody wants afterwards; anything a staff member must act on *now* is a
// screen, not a log line.

/** `[scope] message`, with an optional value the reader will want (an id, a reason, an entry). */
export function warn(scope: string, message: string, detail?: unknown): void {
  const line = `[${scope}] ${message}`;
  if (detail === undefined) console.warn(line);
  else console.warn(line, detail);
}
