import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { BottomTabs, Countdown, KycBadge, Screen } from './index';

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

  /**
   * G4: the event side said `KYC 필요` and the profile said `미인증` for one idea. One part now
   * draws both halves, and a signed-out visitor on the public event page gets no status badge —
   * there is nobody yet to have one.
   */
  it('KycBadge shows only what the event asks of a signed-out visitor', () => {
    render(<KycBadge required level={0} signedIn={false} />);
    expect(screen.getByText('본인인증 필수')).toBeInTheDocument();
    expect(screen.queryByText('인증 전')).toBeNull();
    expect(screen.queryByText('인증 완료')).toBeNull();
  });

  it('KycBadge puts an unverified person next to what the event asks', () => {
    render(<KycBadge required level={0} signedIn />);
    expect(screen.getByText('본인인증 필수')).toBeInTheDocument();
    expect(screen.getByText('인증 전')).toBeInTheDocument();
  });

  it('KycBadge says so once the person is verified', () => {
    render(<KycBadge required level={1} signedIn />);
    expect(screen.getByText('본인인증 필수')).toBeInTheDocument();
    expect(screen.getByText('인증 완료')).toBeInTheDocument();
    expect(screen.queryByText('인증 전')).toBeNull();
  });

  it('KycBadge draws nothing for an event that never asked', () => {
    const { container } = render(<KycBadge required={false} level={0} signedIn />);
    expect(container).toBeEmptyDOMElement();
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
