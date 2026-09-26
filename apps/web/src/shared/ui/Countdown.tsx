import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * `children` is a render function rather than a node so a sentence beside the number is
 * written from the SAME tick. The seconds live in here, so a caller that formats its own
 * sentence from a prop would freeze it at the value of the last parent render while the
 * number next to it kept counting — two numbers on one screen disagreeing.
 */
export function Countdown({
  seconds,
  onExpire,
  children,
}: {
  seconds: number;
  onExpire: () => void;
  children?: (left: number) => ReactNode;
}) {
  const [left, setLeft] = useState(seconds);
  const fired = useRef(false);

  useEffect(() => {
    setLeft(seconds);
    fired.current = false;
  }, [seconds]);

  useEffect(() => {
    if (left <= 0) {
      if (!fired.current) {
        fired.current = true;
        onExpire();
      }
      return;
    }
    const timer = setTimeout(() => setLeft((value) => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [left, onExpire]);

  const value = Math.max(0, left);
  return (
    <div className="countdown">
      <span role="timer" aria-live="polite">
        {value}
      </span>
      {children?.(value)}
    </div>
  );
}
