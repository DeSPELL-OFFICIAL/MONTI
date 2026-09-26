import type { ReactNode } from 'react';
import type { PanInfo } from 'motion/react';
import { m, SPRING, useReducedMotion } from '../motion';

export interface SheetProps {
  /** The accessible name. A sheet has no visible `<h1>`, so this is the whole of it. */
  label: string;
  children: ReactNode;
  /**
   * When given, the sheet can be flung down to leave and this is what a fling calls — the
   * caller's own existing close path, nothing new. Without it the sheet has no gesture at all:
   * a button on it is the only way out, which is the shape it had before this.
   */
  onDismiss?: () => void;
}

/** A fling counts when it has travelled far enough, or left the thumb fast enough. */
const DISMISS_OFFSET = 120;
const DISMISS_VELOCITY = 500;

/**
 * A panel that rises from the foot of the screen with one decision on it.
 *
 * A `role="dialog"` panel rather than a route: it is one question with every answer on it, and a
 * route would put it in the back button's history. Non-modal on purpose — a modal takes focus,
 * and on a phone that closes the keyboard of whatever was being typed behind it, so this never
 * sets `aria-modal`.
 *
 * The rise is a spring rather than the old CSS `@keyframes`, so it can be the same motion the
 * fling springs back along. Under reduced motion it appears in place — no transform entry — and
 * framer makes the exit and the fling's snap-back instant too, so the gesture still works while
 * nothing slides. The grab bar is still `.sheet__body::before`; now it is the real affordance.
 */
export function Sheet({ label, children, onDismiss }: SheetProps) {
  const reduce = useReducedMotion();
  const drag =
    onDismiss === undefined
      ? undefined
      : {
          drag: 'y' as const,
          dragConstraints: { top: 0, bottom: 0 },
          // Only downward gives: a pull up meets the top wall, a push down stretches and, past
          // the threshold on release, dismisses.
          dragElastic: { top: 0, bottom: 0.6 },
          onDragEnd: (_event: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
            if (info.offset.y > DISMISS_OFFSET || info.velocity.y > DISMISS_VELOCITY) onDismiss();
          },
        };

  return (
    <m.div
      role="dialog"
      aria-label={label}
      className="sheet"
      initial={reduce ? false : { y: '100%' }}
      animate={{ y: 0 }}
      exit={{ y: '100%' }}
      transition={SPRING.gentle}
      {...drag}
    >
      <div className="sheet__body">{children}</div>
    </m.div>
  );
}
