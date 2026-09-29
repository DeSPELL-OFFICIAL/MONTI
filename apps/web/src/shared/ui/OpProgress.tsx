import { useEffect, useState } from 'react';
import { fmt, useCopy } from '../i18n';
import { Steps } from './Steps';
import { Button } from './Button';

/**
 * The determinate wait for a sponsored operation, shared by every screen that sends one
 * (publish, claim, requestClaim, approveClaims — plan §2c). It replaces the bare spinner those
 * screens showed: a spinner with no end reads as a hang, and a Monad op that normally settles in
 * three to ten seconds can take thirty, so the person needs to see that it is *still* going.
 *
 * Three named steps — 저장 중 → 확인 중 → 완료 — over an elapsed-seconds counter, so the wait is a
 * thing with a shape rather than an indefinite one. The words are `저장`/`확인`, never a chain or a
 * transaction: this is one of the shared components an attendee sees.
 *
 * Nothing here is time-based motion beyond the counter's own tick and `Steps`' pulse, and the
 * pulse is neutralised by the global `prefers-reduced-motion` rule (`theme.css`) — so a viewer who
 * asked for less motion still gets the number and the steps, just not the animation.
 */

export type OpPhase = 'saving' | 'confirming' | 'done';

/**
 * After this many seconds a run is treated as stuck: the timeout line (and the caller's own
 * decision — 다시 시도, and for create 나중에 확인) replace the counter — never a bare spinner. The
 * operation itself is safe in the background, because every caller's retry is idempotent (publish
 * re-checks its `submittedOpHash`, and the others replace rather than add), so pressing again
 * cannot double anything.
 *
 * 45, not 30: a relayed action on Monad normally settles in seconds, but broadcasting and mining
 * can add a wholly normal delay, and giving up at 30s turned that into a false alarm. 45 gives the
 * relay document time to settle before this counter offers the way out (persona R2 P0-1 / S1).
 */
export const OP_TIMEOUT_SECONDS = 45;
/** When the reassuring "almost there" line joins the counter. Monad normally settles well before. */
const OP_SLOW_SECONDS = 10;

const PHASE_STEP: Record<OpPhase, number> = { saving: 0, confirming: 1, done: 2 };

export interface OpProgressProps {
  phase: OpPhase;
  /** Run again — shown only past the timeout, and only when the caller has an idempotent retry. */
  onRetry?: () => void;
  /**
   * A second choice offered beside 다시 시도 at the timeout — the create scene's 나중에 확인, which
   * leaves the screen with the draft and op hash already preserved. Shown only with {@link laterLabel}.
   */
  onLater?: () => void;
  /** The label for {@link onLater}; without it no second button shows. */
  laterLabel?: string;
  /**
   * Replaces the generic timeout line at the cap — the create scene's "아직 확인 중… 다시 시도하거나
   * 나중에…" — so the two choices below it read as one decision. Falls back to `copy.op.timeout`.
   */
  timeoutMessage?: string;
  /**
   * A short line above the wait while the op is still in flight — the claim path's "잠시 붐벼요. 다시
   * 보내는 중…" during a send-layer resend. Shown only before the timeout, never in place of a step.
   */
  note?: string;
}

export function OpProgress({ phase, onRetry, onLater, laterLabel, timeoutMessage, note }: OpProgressProps) {
  const copy = useCopy();
  const [seconds, setSeconds] = useState(0);
  const done = phase === 'done';

  // One tick a second while the operation is in flight. It counts from mount — the component is
  // rendered for exactly as long as the op is running — and stops at `done`, so it never leaks a
  // timer past the wait it measures.
  useEffect(() => {
    if (done) return undefined;
    const timer = setInterval(() => setSeconds((value) => value + 1), 1_000);
    return () => clearInterval(timer);
  }, [done]);

  const timedOut = !done && seconds >= OP_TIMEOUT_SECONDS;
  const slow = !done && !timedOut && seconds >= OP_SLOW_SECONDS;

  return (
    <div className="op-progress">
      <Steps
        labels={[copy.op.saving, copy.op.confirming, copy.op.done]}
        at={PHASE_STEP[phase]}
        running={!done && !timedOut}
      />
      <div className="op-progress__status" role="status" aria-live="polite">
        {timedOut ? (
          <>
            <p className="muted">{timeoutMessage ?? copy.op.timeout}</p>
            {onRetry ? (
              <Button variant="ghost" onClick={onRetry}>{copy.common.retry}</Button>
            ) : null}
            {onLater && laterLabel ? (
              <Button variant="ghost" onClick={onLater}>{laterLabel}</Button>
            ) : null}
          </>
        ) : done ? null : (
          <>
            {note ? <p className="muted">{note}</p> : null}
            <p className="muted">{copy.op.typical}</p>
            {slow ? <p className="muted">{copy.signup.registerSlow}</p> : null}
          </>
        )}
      </div>
      {/* The elapsed seconds tick once a second, so they are kept out of the live region above and
          marked aria-hidden: otherwise `role="status"` makes a screen reader re-read the whole wait
          every second (expert-4 D4). The live region carries only the step/delay/timeout sentences,
          which change rarely, while the number stays on screen for a sighted viewer. */}
      {!done && !timedOut && seconds > 0 ? (
        <p className="muted" aria-hidden="true">{fmt(copy.op.elapsed, { sec: seconds })}</p>
      ) : null}
    </div>
  );
}
