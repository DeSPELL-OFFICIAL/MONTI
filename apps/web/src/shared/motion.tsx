import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import {
  AnimatePresence,
  LazyMotion,
  MotionConfig,
  domMax,
  m,
  useReducedMotion,
  type HTMLMotionProps,
  type Variants,
} from 'motion/react';

/**
 * The app's one motion foundation. Every animated part imports from here so that the feature
 * bundle, the spring numbers and the reduced-motion rule are decided in a single place.
 *
 * Why `domMax` and not `domAnimation`: the design batch this belongs to needs pan/drag (the
 * ticket sheet's drag-to-dismiss) and shared-layout (`layoutId`) — the tab indicator here, the
 * FAB's shared element later. `domAnimation` ships neither gesture, so it would force a second,
 * larger bundle the moment the next screen lands. `domMax` is that larger bundle, loaded once,
 * lazily, behind `LazyMotion`. `strict` forbids the full `motion.*` component, so every call
 * site must use `m.*` and the lazy chunk stays the only place features are pulled in.
 *
 * Reduced motion is honoured twice, because the two halves of the app hear it differently:
 *   - CSS transitions/animations are neutered by the killswitch `@media` block in `theme.css`.
 *   - JS-driven motion (framer) is neutered here — `MotionConfig reducedMotion="user"` makes
 *     transform/layout animations instant when the OS asks, and `useReducedMotion()` lets a
 *     component drop a slide entirely rather than merely run it in 0ms.
 */
export function MotionProvider({ children }: { children: ReactNode }) {
  return (
    <LazyMotion features={domMax} strict>
      <MotionConfig reducedMotion="user">{children}</MotionConfig>
    </LazyMotion>
  );
}

/**
 * The two springs the app is allowed to use. `snappy` is the tap and the tab indicator — a
 * short, firm settle; `gentle` is for larger travel that should feel unhurried. These numbers
 * are the tokens: a screen picks one, it does not invent stiffness of its own.
 */
export const SPRING = {
  snappy: { type: 'spring', stiffness: 520, damping: 38 },
  gentle: { type: 'spring', stiffness: 260, damping: 30 },
} as const;

/**
 * A list that deals its rows in rather than snapping the whole block on at once. The container
 * hands each child a 30ms head start; a row rises 8px and fades as it lands. A screen picks these,
 * it does not invent its own stagger. Under reduced motion a screen drops them entirely so the
 * list appears at once — framer would otherwise keep the stagger timing with only the movement
 * removed, which is a list that arrives late for no reason.
 */
export const LIST_STAGGER: Record<'container' | 'item', Variants> = {
  container: { hidden: {}, show: { transition: { staggerChildren: 0.03, delayChildren: 0.02 } } },
  item: { hidden: { opacity: 0, y: 8 }, show: { opacity: 1, y: 0, transition: SPRING.gentle } },
};

/** The one press feedback: the element gives 3% under the thumb and springs back. */
const TAP = { scale: 0.97 } as const;

export interface PressableProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** `button` (the default) for a control; `div` for a tappable card that is not itself a link. */
  as?: 'button' | 'div';
}

/**
 * A control that presses. It is `m.button` by default — Button and Fab are built on it — and
 * `m.div` for a card that is the tap target but not a link. When the OS asks for reduced motion
 * the press animation is dropped, not run instantly: no `whileTap`, no transform at all.
 *
 * Everything a `<button>` needs travels straight through: `className`, `onClick`, `disabled`,
 * `type`, `aria-*`, `children` and the `ref`. The `.btn`/`.fab` CSS `:active` rules stay as the
 * no-JS fallback; this only adds the spring on top of them. The public props are plain DOM
 * button attributes — framer's own overridden handlers are not part of the surface — so the cast
 * at the `m.*` boundary is where those plain props become motion props.
 */
export const Pressable = forwardRef<HTMLButtonElement, PressableProps>(
  function Pressable({ as = 'button', children, ...rest }, ref) {
    const reduce = useReducedMotion();
    const tap = reduce ? undefined : { whileTap: TAP, transition: SPRING.snappy };
    if (as === 'div') {
      return (
        <m.div ref={ref as unknown as Ref<HTMLDivElement>} {...(rest as unknown as HTMLMotionProps<'div'>)} {...tap}>
          {children}
        </m.div>
      );
    }
    return (
      <m.button ref={ref} {...(rest as unknown as HTMLMotionProps<'button'>)} {...tap}>
        {children}
      </m.button>
    );
  },
);

export { AnimatePresence, MotionConfig, m, useReducedMotion };
