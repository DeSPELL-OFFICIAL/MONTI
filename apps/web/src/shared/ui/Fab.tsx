import { createPortal } from 'react-dom';
import { Pressable } from '../motion';

/**
 * The floating action button, portaled to `document.body` so its `position: fixed` is anchored to
 * the viewport rather than to the transformed `.route-view` it is nested under. The route
 * transition animates that wrapper with a transform, which would otherwise become this button's
 * containing block and drag it along the slide (friction-log R1). The tab bar escapes the same trap
 * by living outside `.route-view` in the router; a portal is how a screen-owned button gets out
 * without being hoisted up there.
 *
 * A hidden marker stays in place inside the screen so `.screen:has(.fab-anchor)` still reserves the
 * room at the foot for the button that is no longer one of its descendants.
 */
export function Fab({ label, onClick, disabled }: { label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <>
      <span className="fab-anchor" aria-hidden="true" hidden />
      {createPortal(
        <Pressable type="button" className="fab" onClick={onClick} disabled={disabled}>
          {label}
        </Pressable>,
        document.body,
      )}
    </>
  );
}
