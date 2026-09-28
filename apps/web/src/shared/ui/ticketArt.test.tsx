import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { getConfig } from '../config';
import { TicketArt, type TicketArtPreset } from './index';

const PRESETS: TicketArtPreset[] = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'];

/** The group the backdrop is painted in — the only thing `used` is allowed to touch. */
function backdrop(): SVGElement {
  const group = document.querySelector<SVGElement>('.ticket-art__backdrop');
  if (!group) throw new Error('no backdrop rendered');
  return group;
}

describe('TicketArt', () => {
  /**
   * Twelve drawings, not one drawing with twelve colour props: what Firestore stores is the
   * letter, so a letter that quietly fell through to the same picture as another would be
   * invisible on the screen and silent in every other test.
   */
  it('draws a different backdrop for each of the twelve presets', () => {
    const drawings = PRESETS.map((preset) => {
      const { unmount } = render(<TicketArt art={{ preset }} title="재즈 나이트" tierName="일반" />);
      const markup = backdrop().innerHTML;
      unmount();
      return markup;
    });
    expect(drawings.every((markup) => markup.length > 0)).toBe(true);
    expect(new Set(drawings).size).toBe(12);
  });

  /** An uploaded picture is a CID, and the gateway host is configuration, never a literal here. */
  it('reads an uploaded picture through the configured gateway', () => {
    const cid = 'bafkreiabcticketart';
    const { container } = render(<TicketArt art={{ imageCid: cid }} title="재즈 나이트" tierName="일반" />);
    const image = container.querySelector('image');
    expect(image?.getAttribute('href')).toBe(`${getConfig().ipfsGateway}${cid}`);
  });

  /**
   * The strings are `<text>` inside the picture rather than HTML laid over it, so the drawing
   * and the words it carries are one object — which is what lets a ticket carry a name at all.
   */
  it('draws the event, the kind, the holder and the date on the ticket itself', () => {
    const { container } = render(
      <TicketArt
        art={{ preset: 'a' }}
        title="재즈 나이트"
        tierName="스탠딩"
        holder="김태완"
        dateText="2026. 10. 13."
      />,
    );
    expect(container.querySelector('svg')).toBeInTheDocument();
    for (const text of ['재즈 나이트', '스탠딩', '김태완', '2026. 10. 13.']) {
      expect(screen.getByText(text).tagName.toLowerCase()).toBe('text');
    }
  });

  it('draws nothing where there is no holder and no date', () => {
    const { container } = render(<TicketArt art={{ preset: 'a' }} title="재즈 나이트" tierName="스탠딩" />);
    // Three runs of type: the wordmark, the kind, and the one line the title needed.
    expect(container.querySelectorAll('text')).toHaveLength(3);
    expect(screen.getByText('재즈 나이트')).toBeInTheDocument();
  });

  it('keeps the band off a ticket that has not been used', () => {
    const { container } = render(<TicketArt art={{ preset: 'b' }} title="재즈 나이트" tierName="일반" />);
    expect(container.querySelector('.ticket-art__band')).toBeNull();
    expect(screen.queryByText('사용됨')).toBeNull();
    expect(screen.getByRole('img', { name: '재즈 나이트 · 일반 티켓 그림' })).toBeInTheDocument();
  });

  it('paints the band, in copy, once the ticket has been used', () => {
    const { container } = render(
      <TicketArt art={{ preset: 'b' }} title="재즈 나이트" tierName="일반" used />,
    );
    expect(container.querySelector('.ticket-art__band')).toHaveTextContent('사용됨');
    // A screen reader gets the state too — it cannot see a red band across the picture.
    expect(screen.getByRole('img', { name: '재즈 나이트 · 일반 티켓 그림 · 사용됨' })).toBeInTheDocument();
  });

  /**
   * The used ticket is the same drawing with one CSS property added to the backdrop alone:
   * nothing in storage — bytes, CID or JSON — is rewritten when somebody walks through a door,
   * and the band and the words stay in colour on top of a grey picture.
   */
  it('greys out the untouched original only while used is set', () => {
    const { container, rerender } = render(
      <TicketArt art={{ preset: 'c' }} title="재즈 나이트" tierName="일반" />,
    );
    const before = backdrop().innerHTML;
    expect(backdrop().getAttribute('style')).toBeNull();

    rerender(<TicketArt art={{ preset: 'c' }} title="재즈 나이트" tierName="일반" used />);
    expect(backdrop().getAttribute('style')).toContain('grayscale(1) contrast(.9)');
    expect(backdrop().innerHTML).toBe(before);
    // The filter is on the picture and nowhere near the band that has to stay red.
    expect(container.querySelector('.ticket-art__band')?.getAttribute('style')).toBeNull();
  });

  /**
   * `dangerouslySetInnerHTML` is only acceptable because every interpolated string is escaped
   * first. A title is user input; this is the test that says so out loud.
   */
  it('cannot be broken out of by a title that is markup', () => {
    const { container } = render(
      <TicketArt
        art={{ preset: 'a' }}
        title='<script>alert(1)</script> & "x"'
        tierName="일반"
      />,
    );
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelectorAll('svg')).toHaveLength(1);
    // The characters are still drawn — escaped, not dropped.
    expect(container.textContent).toContain('<script>');
  });

  /**
   * A large, animated ticket stops animating when it scrolls out of view — the observer adds a
   * paused class the stylesheet turns into `animation-play-state: paused`. jsdom ships no
   * `IntersectionObserver`, so the test installs one that hands its callback back.
   */
  it('pauses an animated ticket while it is off-screen and resumes it on-screen', () => {
    const callbacks: IntersectionObserverCallback[] = [];
    class MockIO {
      constructor(cb: IntersectionObserverCallback) { callbacks.push(cb); }
      observe(): void {}
      disconnect(): void {}
    }
    const original = globalThis.IntersectionObserver;
    globalThis.IntersectionObserver = MockIO as unknown as typeof IntersectionObserver;
    try {
      const { container } = render(
        <TicketArt art={{ preset: 'a' }} title="재즈 나이트" tierName="일반" animated />,
      );
      const frame = container.querySelector('.ticket-art');
      expect(frame).not.toBeNull();
      const fire = callbacks[0];
      expect(fire).toBeDefined();

      fire?.([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver);
      expect(frame?.classList.contains('ticket-art--paused')).toBe(true);

      fire?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
      expect(frame?.classList.contains('ticket-art--paused')).toBe(false);
    } finally {
      globalThis.IntersectionObserver = original;
    }
  });

  /** A still ticket (the default) attaches no observer at all — there is nothing to pause. */
  it('attaches no observer to a still ticket', () => {
    const seen: unknown[] = [];
    class MockIO {
      constructor(cb: unknown) { seen.push(cb); }
      observe(): void {}
      disconnect(): void {}
    }
    const original = globalThis.IntersectionObserver;
    globalThis.IntersectionObserver = MockIO as unknown as typeof IntersectionObserver;
    try {
      render(<TicketArt art={{ preset: 'a' }} title="재즈 나이트" tierName="일반" />);
      expect(seen).toHaveLength(0);
    } finally {
      globalThis.IntersectionObserver = original;
    }
  });
});
