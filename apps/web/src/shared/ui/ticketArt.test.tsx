import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { getConfig } from '../config';
import { TicketArt, type TicketArtPreset } from './index';

const PRESETS: TicketArtPreset[] = ['a', 'b', 'c', 'd'];

function backdrop(): HTMLImageElement {
  const image = document.querySelector<HTMLImageElement>('.ticket-art__backdrop');
  if (!image) throw new Error('no backdrop rendered');
  return image;
}

describe('TicketArt', () => {
  /**
   * Four files, not one file with four colour props: what Firestore stores is the letter, so a
   * letter that quietly fell through to the same picture as another would be invisible on the
   * screen and silent in every other test.
   */
  it('draws a different bundled backdrop for each of the four presets', () => {
    const sources = PRESETS.map((preset) => {
      const { unmount } = render(<TicketArt art={{ preset }} title="재즈 나이트" tierName="일반" />);
      const source = backdrop().getAttribute('src') ?? '';
      unmount();
      return source;
    });
    expect(sources.every((source) => source.length > 0)).toBe(true);
    expect(new Set(sources).size).toBe(4);
  });

  /** An uploaded picture is a CID, and the gateway host is configuration, never a literal here. */
  it('reads an uploaded picture through the configured gateway', () => {
    const cid = 'bafkreiabcticketart';
    render(<TicketArt art={{ imageCid: cid }} title="재즈 나이트" tierName="일반" />);
    expect(backdrop()).toHaveAttribute('src', `${getConfig().ipfsGateway}${cid}`);
  });

  /**
   * The strings are props laid over the picture rather than `<text>` baked into it, so they are
   * real text on the page — which is also the only reason a long title can wrap.
   */
  it('lays the event title and the tier name over the picture as text', () => {
    render(<TicketArt art={{ preset: 'a' }} title="재즈 나이트" tierName="스탠딩" />);
    expect(screen.getByText('재즈 나이트')).toBeInTheDocument();
    expect(screen.getByText('스탠딩')).toBeInTheDocument();
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
   * The used ticket is the same file at the same URL with one CSS property added: nothing in
   * storage — bytes, CID or JSON — is rewritten when somebody walks through the door.
   */
  it('greys out the untouched original only while used is set', () => {
    const { rerender } = render(<TicketArt art={{ preset: 'c' }} title="재즈 나이트" tierName="일반" />);
    const before = backdrop().getAttribute('src');
    expect(backdrop().style.filter).toBe('');

    rerender(<TicketArt art={{ preset: 'c' }} title="재즈 나이트" tierName="일반" used />);
    expect(backdrop()).toHaveStyle({ filter: 'grayscale(1) contrast(.9)' });
    expect(backdrop().getAttribute('src')).toBe(before);
  });
});
