import { useEffect, useRef } from 'react';
import { m, SPRING } from '../motion';

/**
 * One sentence, said for a moment and then gone.
 *
 * It exists because an action whose whole result is that nothing visibly changed — 임시 저장,
 * which writes a draft the organiser is still looking at — otherwise leaves the person
 * wondering whether the button did anything (plan section F-2).
 *
 * It is deliberately not a dialog: nothing is being asked, so nothing may take focus. A person
 * typing into the scene behind it keeps their cursor and their keyboard, the ✕ is there for
 * anybody who wants it gone sooner, and it leaves by itself either way. `role="status"` makes a
 * screen reader announce it politely rather than interrupting whatever it was reading.
 *
 * It slides and fades in on a spring, and — wrapped in `AnimatePresence` at the call site —
 * fades back out rather than vanishing. Under reduced motion framer makes the slide instant; the
 * fade is opacity only, which reduced motion leaves alone.
 */

/** Long enough to read a short sentence, short enough that nobody waits for it to go. */
export const TOAST_MS = 2_400;

export interface ToastProps {
  text: string;
  /** What to call the ✕. Passed in, so this part carries no product copy of its own. */
  dismiss: string;
  onDone: () => void;
}

export function Toast({ text, dismiss, onDone }: ToastProps) {
  // Through a ref, so an `onDone` written inline at the call site — which is a new function on
  // every render — cannot restart the timer forever and leave the sentence on screen for good.
  const doneRef = useRef(onDone);
  useEffect(() => {
    doneRef.current = onDone;
  }, [onDone]);

  useEffect(() => {
    const timer = setTimeout(() => doneRef.current(), TOAST_MS);
    return () => clearTimeout(timer);
  }, [text]);

  return (
    <m.div
      className="toast"
      role="status"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 8 }}
      transition={SPRING.gentle}
    >
      <span>{text}</span>
      <button type="button" className="toast__x" aria-label={dismiss} onClick={onDone}>✕</button>
    </m.div>
  );
}
