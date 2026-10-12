import { useState } from 'react';

/**
 * A full identifier, shown whole for whoever needs it (it only ever sits under a 상세) and
 * copied in one press, so nobody transcribes 66 characters by eye. The value also rides on
 * `data-value`, which is what tests and the e2e harness read.
 */
export function CopyValue({ value, copyLabel, copiedLabel }: { value: string; copyLabel: string; copiedLabel: string }) {
  const [copied, setCopied] = useState(false);
  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      // No clipboard on this device: the value is on screen to read out.
    }
  }
  return (
    <span className="copy-value" data-value={value}>
      <span className="mono selectable copy-value__text">{value}</span>{' '}
      <button type="button" className="copy-value__button" onClick={() => void copy()}>
        {copied ? copiedLabel : copyLabel}
      </button>
    </span>
  );
}
