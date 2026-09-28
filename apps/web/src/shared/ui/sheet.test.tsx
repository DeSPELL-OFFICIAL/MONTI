import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { hasReducedMotionListener, prefersReducedMotion } from 'motion/react';
import { AnimatePresence, MotionProvider } from '../motion';
import { Sheet } from './index';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * jsdom 26 ships no `PointerEvent`, so framer's drag never starts a pan session. A minimal
 * polyfill over `MouseEvent` (which does carry `clientX/clientY`) is enough for the gesture to
 * run — this is the one thing that makes drag testable here.
 */
class PointerEventPolyfill extends MouseEvent {
  pointerId: number;
  pointerType: string;
  isPrimary: boolean;
  constructor(type: string, init: any = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
    this.pointerType = init.pointerType ?? 'touch';
    this.isPrimary = init.isPrimary ?? true;
  }
}

beforeAll(() => {
  (globalThis as any).PointerEvent = PointerEventPolyfill;
  // framer reaches for pointer capture and a real box; jsdom has neither.
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.getBoundingClientRect = vi.fn(
    () => ({ x: 0, y: 0, top: 0, left: 0, right: 320, bottom: 480, width: 320, height: 480, toJSON: () => ({}) }) as DOMRect,
  );
});

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

/**
 * A downward drag on the sheet: press, move down through the given points, then release. A pause
 * before release (the long flush) lets framer's velocity decay, so a short slow drag reads as a
 * short slow drag and not a fling.
 */
async function dragDown(el: Element, points: number[], pauseBeforeRelease = 40) {
  await act(async () => {
    fireEvent.pointerDown(el, { pointerId: 1, isPrimary: true, button: 0, buttons: 1, clientX: 10, clientY: 0 });
  });
  await settle();
  for (const y of points) {
    await act(async () => {
      fireEvent.pointerMove(window, { pointerId: 1, isPrimary: true, buttons: 1, clientX: 10, clientY: y });
    });
    await settle();
  }
  await act(async () => { await new Promise((r) => setTimeout(r, pauseBeforeRelease)); });
  const last = points[points.length - 1] ?? 0;
  await act(async () => {
    fireEvent.pointerUp(window, { pointerId: 1, isPrimary: true, buttons: 0, clientX: 10, clientY: last });
  });
  await settle();
}

describe('Sheet', () => {
  it('is a named, modal dialog behind a scrim (expert-4 D7)', () => {
    const { container } = render(
      <MotionProvider>
        <Sheet label="이어서 쓸까요?"><p>본문</p></Sheet>
      </MotionProvider>,
    );
    const sheet = screen.getByRole('dialog', { name: '이어서 쓸까요?' });
    expect(sheet).toHaveClass('sheet');
    expect(sheet).toHaveAttribute('aria-modal', 'true');
    // A full-viewport scrim sits under it, so the scene it covers is inert to taps.
    expect(container.querySelector('.sheet-scrim')).not.toBeNull();
  });

  it('dismisses on a tap on the scrim when there is a way out', async () => {
    const onDismiss = vi.fn();
    const { container } = render(
      <MotionProvider>
        <Sheet label="이어서 쓸까요?" onDismiss={onDismiss}><p>본문</p></Sheet>
      </MotionProvider>,
    );
    await settle();
    fireEvent.click(container.querySelector('.sheet-scrim') as Element);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('keeps a summary sheet with no way out up when its scrim is tapped', async () => {
    const { container } = render(
      <MotionProvider>
        <Sheet label="이어서 쓸까요?"><p>본문</p></Sheet>
      </MotionProvider>,
    );
    await settle();
    // No onDismiss: the scrim still swallows the tap, but the decision has to be made on the sheet.
    fireEvent.click(container.querySelector('.sheet-scrim') as Element);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('dismisses when flung down past the distance threshold', async () => {
    const onDismiss = vi.fn();
    render(
      <MotionProvider>
        <Sheet label="이어서 쓸까요?" onDismiss={onDismiss}><p>본문</p></Sheet>
      </MotionProvider>,
    );
    await settle();
    await dragDown(screen.getByRole('dialog'), [80, 240]);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('does not dismiss on a small, slow drag', async () => {
    const onDismiss = vi.fn();
    render(
      <MotionProvider>
        <Sheet label="이어서 쓸까요?" onDismiss={onDismiss}><p>본문</p></Sheet>
      </MotionProvider>,
    );
    await settle();
    // 50px and then a long hold before release: under both thresholds (120px / 500px·s⁻¹).
    await dragDown(screen.getByRole('dialog'), [50], 260);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('keeps the drag gesture under reduced motion', async () => {
    reduceMotion(true);
    const onDismiss = vi.fn();
    render(
      <MotionProvider>
        <Sheet label="이어서 쓸까요?" onDismiss={onDismiss}><p>본문</p></Sheet>
      </MotionProvider>,
    );
    await settle();
    await dragDown(screen.getByRole('dialog'), [80, 240]);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('appears in place under reduced motion — no slide-up transform', async () => {
    reduceMotion(true);
    render(
      <MotionProvider>
        <Sheet label="이어서 쓸까요?"><p>본문</p></Sheet>
      </MotionProvider>,
    );
    await settle();
    const sheet = screen.getByRole('dialog');
    const transform = sheet.style.transform ?? '';
    // The reduced-motion sheet is not parked off-screen at translateY(100%); it is simply there.
    expect(transform).not.toMatch(/translateY\(1/);
    expect(screen.getByText('본문')).toBeInTheDocument();
  });

  it('animates out when unmounted inside AnimatePresence', async () => {
    function Host({ open }: { open: boolean }) {
      return (
        <MotionProvider>
          <AnimatePresence>
            {open ? <Sheet key="s" label="이어서 쓸까요?" onDismiss={() => undefined}><p>본문</p></Sheet> : null}
          </AnimatePresence>
        </MotionProvider>
      );
    }
    const { rerender } = render(<Host open />);
    await settle();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    rerender(<Host open={false} />);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull(), { timeout: 3000 });
  });
});
