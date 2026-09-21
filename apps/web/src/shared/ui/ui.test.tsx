import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { BottomTabs, Countdown, Screen } from './index';

describe('ui primitives', () => {
  it('Screen renders a main landmark with the mobile max width', () => {
    render(<Screen title="내 티켓">body</Screen>);
    const main = screen.getByRole('main');
    expect(main).toHaveClass('screen');
    expect(screen.getByRole('heading', { name: '내 티켓' })).toBeInTheDocument();
  });

  it('BottomTabs marks the active route', () => {
    render(
      <MemoryRouter initialEntries={['/tickets']}>
        <BottomTabs />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: '내 티켓' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: '탐색' })).not.toHaveAttribute('aria-current');
  });

  it('Countdown ticks down and calls onExpire at zero', () => {
    vi.useFakeTimers();
    const onExpire = vi.fn();
    render(<Countdown seconds={3} onExpire={onExpire} />);
    expect(screen.getByRole('timer')).toHaveTextContent('3');
    // One second per act: the next timer is only armed after React flushes the state update.
    for (let tick = 0; tick < 3; tick += 1) {
      act(() => { vi.advanceTimersByTime(1000); });
    }
    expect(screen.getByRole('timer')).toHaveTextContent('0');
    expect(onExpire).toHaveBeenCalledTimes(1);
  });
});
