/**
 * The three dots above a screen that runs several things off one tap. It is a progress
 * *indicator*, not a progress bar: `registerIdentity` waits for a block to finalise and can take
 * thirty seconds, so a percentage would be a number the screen made up.
 *
 * `at` names the step being worked on. Everything before it is filled, everything after it is
 * empty, and the current one pulses while `running` — an animation is what says the screen is
 * still alive when a step takes longer than anybody expects.
 */
export interface StepsProps {
  labels: readonly string[];
  /** The step in hand, from 0. `labels.length` means every one of them is finished. */
  at: number;
  running?: boolean;
}

function toneOf(index: number, at: number): string {
  if (index < at) return 'steps__step--done';
  return index === at ? 'steps__step--current' : 'steps__step--todo';
}

export function Steps({ labels, at, running = false }: StepsProps) {
  return (
    <ol className="steps">
      {labels.map((label, index) => (
        <li
          key={label}
          className={`steps__step ${toneOf(index, at)}${running && index === at ? ' steps__step--pulse' : ''}`}
          aria-current={index === at ? 'step' : undefined}
        >
          <span className="steps__dot" aria-hidden="true" />
          <span className="steps__label">{label}</span>
        </li>
      ))}
    </ol>
  );
}
