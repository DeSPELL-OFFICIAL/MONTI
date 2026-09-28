import { fireEvent, render, screen, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpProgress } from './OpProgress';
import { ko } from '../copy/index';

const op = ko.op;

/** The label of whichever step `Steps` is marking as current. */
function currentStep(): string | null {
  return document.querySelector('.steps__step--current .steps__label')?.textContent ?? null;
}

/** The elapsed line the way `fmt` renders it, so a test never asserts the raw template. */
function elapsed(sec: number): string {
  return op.elapsed.replace('{{sec}}', String(sec));
}

describe('OpProgress', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('walks the determinate steps 저장 중 → 확인 중 → 완료 as the phase advances', () => {
    const { rerender } = render(<OpProgress phase="saving" />);
    expect(currentStep()).toBe(op.saving);
    rerender(<OpProgress phase="confirming" />);
    expect(currentStep()).toBe(op.confirming);
    rerender(<OpProgress phase="done" />);
    expect(currentStep()).toBe(op.done);
  });

  it('counts the seconds and adds the reassuring line at ten', () => {
    render(<OpProgress phase="saving" />);
    expect(screen.getByText(op.typical)).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getByText(elapsed(1))).toBeInTheDocument();
    expect(screen.queryByText(ko.signup.registerSlow)).toBeNull();
    act(() => vi.advanceTimersByTime(9_000));
    expect(screen.getByText(ko.signup.registerSlow)).toBeInTheDocument();
  });

  it('keeps the per-second elapsed count out of the live region (expert-4 D4)', () => {
    render(<OpProgress phase="saving" />);
    act(() => vi.advanceTimersByTime(3_000));
    // Still on screen for a sighted viewer...
    const line = screen.getByText(elapsed(3));
    expect(line).toBeInTheDocument();
    // ...but aria-hidden and outside role="status", so a screen reader is not made to re-read the
    // whole wait every second — the live region carries only the sentences.
    expect(line).toHaveAttribute('aria-hidden', 'true');
    const status = screen.getByRole('status');
    expect(status.textContent ?? '').not.toContain(elapsed(3));
    expect(status.textContent ?? '').toContain(op.typical);
  });

  it('shows the timeout line and 다시 시도 at forty-five seconds, never a bare spinner', () => {
    const onRetry = vi.fn();
    render(<OpProgress phase="confirming" onRetry={onRetry} />);
    act(() => vi.advanceTimersByTime(44_000));
    // Not yet: the cap is 45s, so a run at 44s is still just going.
    expect(screen.queryByText(op.timeout)).toBeNull();
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getByText(op.timeout)).toBeInTheDocument();
    // The reassuring line and the counter give way to the timeout, and there is no bare spinner.
    expect(screen.queryByText(ko.signup.registerSlow)).toBeNull();
    expect(screen.queryByRole('progressbar')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: ko.common.retry }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('leaves the retry button out when the caller has no idempotent retry', () => {
    render(<OpProgress phase="saving" />);
    act(() => vi.advanceTimersByTime(45_000));
    expect(screen.getByText(op.timeout)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: ko.common.retry })).toBeNull();
  });

  it('offers a second choice and its own line at the cap when the caller passes them', () => {
    const onRetry = vi.fn();
    const onLater = vi.fn();
    render(
      <OpProgress
        phase="confirming"
        onRetry={onRetry}
        onLater={onLater}
        laterLabel="나중에 확인"
        timeoutMessage="아직 확인 중이에요"
      />,
    );
    act(() => vi.advanceTimersByTime(45_000));
    // The caller's own line replaces the generic timeout line.
    expect(screen.getByText('아직 확인 중이에요')).toBeInTheDocument();
    expect(screen.queryByText(op.timeout)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '나중에 확인' }));
    expect(onLater).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: ko.common.retry }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('leaves the second button out without a label, even when onLater is passed', () => {
    render(<OpProgress phase="confirming" onLater={vi.fn()} />);
    act(() => vi.advanceTimersByTime(45_000));
    expect(screen.getByText(op.timeout)).toBeInTheDocument();
    // No 다시 시도 (no onRetry) and no second button (no label): just the line.
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('stops the counter once the operation is done', () => {
    const { rerender } = render(<OpProgress phase="saving" />);
    act(() => vi.advanceTimersByTime(5_000));
    rerender(<OpProgress phase="done" />);
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.queryByText(op.timeout)).toBeNull();
    expect(currentStep()).toBe(op.done);
  });

  it('shows a caller note above the wait while the op is in flight', () => {
    render(<OpProgress phase="saving" note={op.busy} />);
    expect(screen.getByText(op.busy)).toBeInTheDocument();
    // A note is for the in-flight state only: once done, only the step remains.
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getByText(op.busy)).toBeInTheDocument();
  });
});
