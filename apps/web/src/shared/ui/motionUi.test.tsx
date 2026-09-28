import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hasReducedMotionListener, prefersReducedMotion } from 'motion/react';
import { AnimatePresence, LIST_STAGGER, m, MotionProvider, useReducedMotion } from '../motion';
import { Skeleton, Toast, TOAST_MS } from './index';

/** framer caches the reduced-motion answer in module state; clear it between tests. */
function resetReducedMotionCache(): void {
  hasReducedMotionListener.current = false;
  prefersReducedMotion.current = null;
}
function reduceMotion(on: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches: on, media: query, onchange: null,
    addEventListener: () => undefined, removeEventListener: () => undefined,
    addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  resetReducedMotionCache();
}
afterEach(resetReducedMotionCache);

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 40)); });

describe('Skeleton', () => {
  it('is a decorative, aria-hidden block with the shimmer class', () => {
    const { container } = render(<Skeleton width={80} height={16} radius={8} />);
    const block = container.querySelector('.skeleton');
    expect(block).not.toBeNull();
    expect(block).toHaveAttribute('aria-hidden', 'true');
    expect(block).toHaveStyle({ width: '80px', height: '16px' });
  });

  it('stacks a whole list of rows from one count', () => {
    const { container } = render(<Skeleton count={4} height={20} />);
    expect(container.querySelectorAll('.skeleton')).toHaveLength(4);
  });

  it('still renders as a calm static placeholder under reduced motion', () => {
    // The sweep is frozen by the CSS killswitch (not measurable in jsdom); what this pins is that
    // the block is present and stays decoration — never a flashing, announced element.
    reduceMotion(true);
    const { container } = render(<Skeleton height={16} />);
    const block = container.querySelector('.skeleton');
    expect(block).not.toBeNull();
    expect(block).toHaveAttribute('aria-hidden', 'true');
  });
});

/** A list built exactly the way the attendee screens spread `LIST_STAGGER`. */
const ITEMS = ['하나', '둘', '셋', '넷'];
function StaggerList() {
  const reduce = useReducedMotion();
  const list = reduce ? {} : { variants: LIST_STAGGER.container, initial: 'hidden' as const, animate: 'show' as const };
  const item = reduce ? {} : { variants: LIST_STAGGER.item };
  return (
    <m.ul className="event-list" {...list}>
      {ITEMS.map((label) => (
        <m.li key={label} {...item}>{label}</m.li>
      ))}
    </m.ul>
  );
}

describe('list stagger', () => {
  it('renders every row even while the stagger runs', async () => {
    render(<MotionProvider><StaggerList /></MotionProvider>);
    await settle();
    for (const label of ITEMS) expect(screen.getByText(label)).toBeInTheDocument();
  });

  it('shows every row at once under reduced motion', async () => {
    reduceMotion(true);
    render(<MotionProvider><StaggerList /></MotionProvider>);
    await settle();
    for (const label of ITEMS) expect(screen.getByText(label)).toBeInTheDocument();
  });
});

describe('Toast', () => {
  it('is a polite status line with the text and a labelled dismiss', () => {
    render(
      <MotionProvider>
        <AnimatePresence>
          <Toast key="t" text="저장했어요" dismiss="닫기" onDone={() => undefined} />
        </AnimatePresence>
      </MotionProvider>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('저장했어요');
    expect(screen.getByRole('button', { name: '닫기' })).toBeInTheDocument();
  });

  it('calls onDone by itself after TOAST_MS', () => {
    vi.useFakeTimers();
    const onDone = vi.fn();
    render(
      <MotionProvider>
        <AnimatePresence>
          <Toast key="t" text="저장했어요" dismiss="닫기" onDone={onDone} />
        </AnimatePresence>
      </MotionProvider>,
    );
    expect(onDone).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(TOAST_MS); });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('calls onDone when the ✕ is pressed', () => {
    const onDone = vi.fn();
    render(
      <MotionProvider>
        <AnimatePresence>
          <Toast key="t" text="저장했어요" dismiss="닫기" onDone={onDone} />
        </AnimatePresence>
      </MotionProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: '닫기' }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('animates out when removed inside AnimatePresence', async () => {
    function Host({ show }: { show: boolean }) {
      return (
        <MotionProvider>
          <AnimatePresence>
            {show ? <Toast key="t" text="저장했어요" dismiss="닫기" onDone={() => undefined} /> : null}
          </AnimatePresence>
        </MotionProvider>
      );
    }
    const { rerender } = render(<Host show />);
    await settle();
    expect(screen.getByRole('status')).toBeInTheDocument();
    rerender(<Host show={false} />);
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull(), { timeout: 3000 });
  });
});
