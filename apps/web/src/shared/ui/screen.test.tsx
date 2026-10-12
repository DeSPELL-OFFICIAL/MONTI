import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { Screen } from './Screen';

// A tiny route table whose every entry is just a `Screen`, so a test can land the router on any
// path and read the back bar off the same component the app uses.
const routes = [
  { path: '/', element: <Screen title="홈">홈 본문</Screen> },
  { path: '/tickets', element: <Screen title="내 티켓">티켓 본문</Screen> },
  { path: '/chats', element: <Screen title='Chats'>대화 본문</Screen> },
  { path: '/me', element: <Screen title='Profile'>프로필 본문</Screen> },
  { path: '/tickets/:id', element: <Screen title='Ticket 상세'>상세 본문</Screen> },
  { path: '/org/new', element: <Screen title='Create an event'>만들기 본문</Screen> },
];

function mount(entries: string[], index?: number) {
  const router = createMemoryRouter(routes, { initialEntries: entries, initialIndex: index });
  render(<RouterProvider router={router} />);
  return router;
}

const backButton = () => screen.queryByRole('button', { name: 'Back' });

describe('Screen back bar', () => {
  it('renders the back bar on a stack (non-tab) route', () => {
    mount(['/tickets/abc']);
    expect(backButton()).toBeInTheDocument();
  });

  it('renders the back bar on a nested stack route', () => {
    mount(['/org/new']);
    expect(backButton()).toBeInTheDocument();
  });

  it.each(['/', '/tickets', '/chats', '/me'])(
    'does not render the back bar on the tab root %s',
    (path) => {
      mount([path]);
      expect(backButton()).toBeNull();
    },
  );

  it('falls back to home when there is no history to pop (deep-link / NFC landing)', async () => {
    // A single initial entry: `location.key` is `'default'`, so there is nothing behind it.
    const router = mount(['/tickets/abc']);
    await userEvent.click(backButton()!);
    expect(router.state.location.pathname).toBe('/');
  });

  it('pops one entry when the app has history behind the current screen', async () => {
    // Two entries, landed on the second: back must return to the first, not jump home.
    const router = mount(['/tickets', '/tickets/abc'], 1);
    await userEvent.click(backButton()!);
    expect(router.state.location.pathname).toBe('/tickets');
  });
});
