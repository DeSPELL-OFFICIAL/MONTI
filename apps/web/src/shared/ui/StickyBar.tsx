import type { ReactNode } from 'react';

/**
 * The bar pinned to the foot of a scene: where the draft stands on the left, the one action on
 * the right. It is fixed rather than at the end of the document because a scene is one long
 * scroll — an action that has to be scrolled to is an action nobody finds.
 *
 * The scene pads its own foot by `--sticky-bar-h`; this part only draws the bar.
 */
export function StickyBar({ status, children }: { status?: ReactNode; children: ReactNode }) {
  return (
    <div className="sticky-bar">
      <div className="sticky-bar__status">{status}</div>
      <div className="sticky-bar__action">{children}</div>
    </div>
  );
}
