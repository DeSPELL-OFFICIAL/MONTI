import type { ReactNode } from 'react';

export interface CardProps {
  /** The heading. A card without one is a plain pane — a picture, a summary, a link block. */
  title?: ReactNode;
  /** Whatever belongs on the title's own line: a count, a state, a small button. */
  aside?: ReactNode;
  /** The scroll target a scene needs to be able to jump to a section (`scene-<name>`). */
  id?: string;
  children: ReactNode;
}

/**
 * The glass pane every screen is made of: one subject, a title, and a hairline between it and
 * whatever is next. It replaces the bare `<section>` a long screen used to be, because on a
 * phone a single scrolling column of unbounded text has no landmarks at all — the founder's
 * complaint about the creation screen was, in the end, that it was one page of fourteen
 * questions with nothing to say where one of them ended.
 *
 * It carries no colour, no radius and no shadow of its own. `.card` is in the glass recipe in
 * `theme.css` alongside the tab bar and the sheet, so all of them change together.
 */
export function Card({ title, aside, id, children }: CardProps) {
  return (
    <section className="card" id={id}>
      {title === undefined ? null : (
        <div className="card__head">
          <h2>{title}</h2>
          {aside}
        </div>
      )}
      {children}
    </section>
  );
}
