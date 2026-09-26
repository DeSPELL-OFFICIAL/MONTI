import { m, SPRING, useReducedMotion } from '../motion';

/**
 * The check that lands on the two "done" screens — the end of signing up, and the moment an
 * event exists. A ring scales in and a tick draws across it on `SPRING.bouncy`, with a handful
 * of confetti bits thrown out around it.
 *
 * It is honoured twice, the way the rest of the app honours reduced motion: `useReducedMotion()`
 * drops the confetti and renders a still, whole check rather than running the draw in zero time —
 * and where the feature bundle never loads at all, the same still check is what shows.
 *
 * Purely decorative: `aria-hidden`, no words of its own, so a screen reader hears only the title
 * and the copy the screen already had. Everything it animates is transform or opacity, and the
 * confetti stays inside the mark's own footprint, so nothing it does can widen the page.
 */

interface Bit {
  readonly x: number;
  readonly y: number;
  readonly rot: number;
  readonly delay: number;
  readonly color: string;
}

/** A small, fixed spray. Purple is decoration here (a 7px square, never under a word), so the
    brand tints are free to join the success green and the berry warn tone. */
const CONFETTI: readonly Bit[] = [
  { x: -66, y: -10, rot: -28, delay: 0.04, color: 'var(--brand)' },
  { x: -40, y: -54, rot: 20, delay: 0.12, color: 'var(--success)' },
  { x: -14, y: -68, rot: -12, delay: 0.02, color: 'var(--brand-soft)' },
  { x: 16, y: -62, rot: 26, delay: 0.16, color: 'var(--warn)' },
  { x: 44, y: -48, rot: -20, delay: 0.08, color: 'var(--brand)' },
  { x: 66, y: -8, rot: 22, delay: 0.14, color: 'var(--brand-strong)' },
  { x: -52, y: 42, rot: 14, delay: 0.18, color: 'var(--brand-soft)' },
  { x: 52, y: 46, rot: -24, delay: 0.06, color: 'var(--success)' },
];

function Confetti() {
  return (
    <div className="confetti" aria-hidden="true">
      {CONFETTI.map((bit, i) => (
        <m.span
          key={i}
          className="confetti__bit"
          style={{ background: bit.color }}
          initial={{ x: 0, y: 0, scale: 0, opacity: 0, rotate: 0 }}
          animate={{ x: bit.x, y: bit.y, scale: 1, opacity: [0, 1, 1, 0], rotate: bit.rot }}
          transition={{ duration: 0.9, delay: bit.delay, ease: 'easeOut' }}
        />
      ))}
    </div>
  );
}

export function SuccessCheck() {
  const reduce = useReducedMotion();
  return (
    <div className="success-mark" aria-hidden="true">
      {reduce ? null : <Confetti />}
      <m.svg
        className="success-mark__ring"
        viewBox="0 0 64 64"
        width="76"
        height="76"
        fill="none"
        initial={reduce ? false : { scale: 0.5, opacity: 0 }}
        animate={reduce ? undefined : { scale: 1, opacity: 1 }}
        transition={SPRING.bouncy}
      >
        <circle className="success-mark__disc" cx="32" cy="32" r="30" />
        <m.path
          className="success-mark__tick"
          d="M20 33.5 L28.5 42 L44.5 24"
          initial={reduce ? false : { pathLength: 0 }}
          animate={reduce ? undefined : { pathLength: 1 }}
          transition={reduce ? undefined : { ...SPRING.bouncy, delay: 0.12 }}
        />
      </m.svg>
    </div>
  );
}
