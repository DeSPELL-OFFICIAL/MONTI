import type { ReactNode } from 'react';

export interface SheetProps {
  /** The accessible name. A sheet has no visible `<h1>`, so this is the whole of it. */
  label: string;
  children: ReactNode;
}

/**
 * A panel that rises from the foot of the screen with one decision on it.
 *
 * A `<dialog open>` rather than a route: it is one question with every answer on it, and a
 * route would put it in the back button's history. Non-modal on purpose — `showModal()` takes
 * focus, and on a phone that closes the keyboard of whatever was being typed behind it.
 *
 * The grab bar at the top is drawn by `.sheet__body::before` and is decoration: the buttons
 * inside are what closes this. Nothing here is draggable, so nothing pretends to be.
 */
export function Sheet({ label, children }: SheetProps) {
  return (
    <dialog open className="sheet" aria-label={label}>
      <div className="sheet__body">{children}</div>
    </dialog>
  );
}
