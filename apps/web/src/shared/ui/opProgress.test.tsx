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

  it('shows the timeout line and 다시 시도 at thirty seconds, never a bare spinner', () => {
    const onRetry = vi.fn();
    render(<OpProgress phase="confirming" onRetry={onRetry} />);
    act(() => vi.advanceTimersByTime(30_000));
    expect(screen.getByText(op.timeout)).toBeInTheDocument();
    // The reassuring line and the counter give way to the timeout, and there is no bare spinner.
    expect(screen.queryByText(ko.signup.registerSlow)).toBeNull();
    expect(screen.queryByRole('progressbar')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: ko.common.retry }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('leaves the retry button out when the caller has no idempotent retry', () => {
    render(<OpProgress phase="saving" />);
    act(() => vi.advanceTimersByTime(30_000));
    expect(screen.getByText(op.timeout)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: ko.common.retry })).toBeNull();
  });

  it('stops the counter once the operation is done', () => {
    const { rerender } = render(<OpProgress phase="saving" />);
    act(() => vi.advanceTimersByTime(5_000));
    rerender(<OpProgress phase="done" />);
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.queryByText(op.timeout)).toBeNull();
    expect(currentStep()).toBe(op.done);
  });
});
