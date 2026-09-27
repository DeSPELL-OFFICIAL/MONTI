import type { ReactNode } from 'react';

/**
 * A screen with nothing to show yet, drawn as finished rather than unfinished: a soft ticket
 * glyph, one line that says what is missing, and — where there is a next step — one action,
 * all centred in the empty half instead of two muted lines stranded top-left (visual R1-4).
 *
 * The glyph is decoration, so it is `aria-hidden`: the line beside it already carries the
 * meaning, and a screen reader has no use for the picture.
 */
export function EmptyState({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <span className="empty-state__icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor"
             strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2 2 2 0 0 0 0 4 2 2 0 0 0 0 4 2 2 0 0 1-2 2H6a2 2 0 0 1-2-2 2 2 0 0 0 0-4 2 2 0 0 0 0-4Z" />
          <path d="M10 9v6" />
        </svg>
      </span>
      <p className="muted">{children}</p>
      {action ?? null}
    </div>
  );
}
