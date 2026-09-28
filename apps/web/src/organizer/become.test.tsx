import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallableErrorCode } from '../shared/api/functions';

/**
 * Only the callable is replaced; `CallableError` and `callableFailure` stay the real ones, so
 * every reason below travels exactly the path a server refusal travels.
 */
const createOrganizerForMe = vi.fn(async (_args: { name: string }) => ({ orgId: '42' }));
vi.mock('../shared/api/functions', async (orig) => ({
  ...(await orig<typeof import('../shared/api/functions')>()),
  api: { createOrganizerForMe },
}));

// Only `useNavigate` is stubbed; `MemoryRouter` stays real.
const navigate = vi.fn();
vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
}));

const { CallableError } = await import('../shared/api/functions');
const { organizerCopy } = await import('./copy');
const { Become } = await import('./Become');
const { ko } = await import('../shared/copy');
const copy = organizerCopy.ko.become;
/**
 * The sentence for every refusal the table does not name. It is the shared one, not an
 * organiser sentence: since T-UX-8 this arm goes through `describeFailure`, which writes from
 * `common` — and would write the offline or the indexer line instead, if either were true.
 */
const GENERIC = ko.common.error;

function open() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <Become />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Fills the one field. `fireEvent` rather than typing, because one name below carries a
 *  control character no keyboard can send. */
function type(value: string): void {
  fireEvent.change(screen.getByLabelText(copy.name), { target: { value } });
}

function createButton(): HTMLElement {
  return screen.getByRole('button', { name: copy.create });
}

/** Opens the screen, writes a name the rule accepts and presses the button once. */
async function press(name = '재즈 컴퍼니'): Promise<void> {
  const user = userEvent.setup();
  open();
  type(name);
  await user.click(createButton());
}

/** A promise this test settles by hand, so "while the call is in flight" is a real state. */
function deferred(): {
  promise: Promise<{ orgId: string }>;
  resolve: (value: { orgId: string }) => void;
} {
  let settle: (value: { orgId: string }) => void = () => undefined;
  const promise = new Promise<{ orgId: string }>((resolve) => {
    settle = resolve;
  });
  return { promise, resolve: (value) => settle(value) };
}

beforeEach(() => {
  navigate.mockClear();
  createOrganizerForMe.mockReset();
  createOrganizerForMe.mockResolvedValue({ orgId: '42' });
});

describe('making an organisation', () => {
  /**
   * The name goes out trimmed — the server trims too, but a name that would be refused for its
   * spaces must never cost the attester a send. The number comes back from the chain, and
   * `replace` is what stops Back returning to a form that would make a second organisation.
   */
  it('sends the trimmed name and lands on the organisation the chain numbered', async () => {
    createOrganizerForMe.mockResolvedValue({ orgId: '42' });
    await press('  재즈 컴퍼니  ');

    await waitFor(() => expect(createOrganizerForMe).toHaveBeenCalledWith({ name: '재즈 컴퍼니' }));
    expect(navigate).toHaveBeenCalledWith('/org?org=42', { replace: true });
  });

  /**
   * The non-idempotency guard, and the reason this screen exists in this shape: the callable
   * hands out a fresh organisation on every call, so a second tap while the first is still in
   * flight would be a second organisation. Nothing on the server deduplicates it.
   */
  it('locks the button for the whole call, so a second tap sends nothing', async () => {
    const user = userEvent.setup();
    const pending = deferred();
    createOrganizerForMe.mockImplementation(() => pending.promise);
    open();
    type('재즈 컴퍼니');
    await user.click(createButton());

    const working = await screen.findByRole('button', { name: copy.working });
    expect(working).toBeDisabled();
    expect(screen.getByRole('progressbar')).toBeInTheDocument();

    await user.click(working);
    expect(createOrganizerForMe).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();

    pending.resolve({ orgId: '7' });
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/org?org=7', { replace: true }));
    expect(createOrganizerForMe).toHaveBeenCalledTimes(1);
  });
});

/**
 * The same rule the server applies, so a name it would refuse never leaves. Code points, not
 * UTF-16 units — `'🎪'.length` is 2 and `'🎪'.repeat(40).length` is 80, and reading either as
 * the character count would refuse a good name and let a bad one through.
 */
describe('the name rule, before anything leaves the phone', () => {
  const cases: ReadonlyArray<readonly [string, string, boolean]> = [
    ['refuses an empty field', '', false],
    ['refuses one character', '가', false],
    ['accepts exactly two', '가나', true],
    ['accepts exactly forty', '가'.repeat(40), true],
    ['refuses forty-one', '가'.repeat(41), false],
    ['reads one emoji as one character, which is too short', '🎪', false],
    ['reads forty emoji as forty characters, not eighty', '🎪'.repeat(40), true],
    ['refuses a control character', '재즈\u0007컴퍼니', false],
    ['counts the name after trimming, not before', '  가  ', false],
  ];

  for (const [label, value, enabled] of cases) {
    it(label, () => {
      open();
      type(value);
      if (enabled) expect(createButton()).toBeEnabled();
      else expect(createButton()).toBeDisabled();
      expect(createOrganizerForMe).not.toHaveBeenCalled();
    });
  }
});

describe('what the server refuses', () => {
  /**
   * `NOT_ACTIVE` and `NO_SIGNUP` say the same thing to the person but mean different steps, so
   * the sentence cannot tell them apart — the destination does. `invalid-argument` and
   * `failed-precondition` are both HTTP 400, which is why nothing here branches on the status.
   */
  it('sends somebody whose phone is not registered to the device step', async () => {
    createOrganizerForMe.mockRejectedValue(new CallableError('failed-precondition', 'NOT_ACTIVE'));
    await press();

    expect(await screen.findByText(copy.problems.notActive)).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: copy.resume }));
    expect(navigate).toHaveBeenCalledWith('/signup/register');
  });

  it('sends somebody who never signed up to the first signup step', async () => {
    createOrganizerForMe.mockRejectedValue(new CallableError('not-found', 'NO_SIGNUP'));
    await press();

    expect(await screen.findByText(copy.problems.noSignup)).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: copy.resume }));
    expect(navigate).toHaveBeenCalledWith('/signup/phone');
  });

  /** Three per person is the whole limit; the fourth is refused before anything is sent. */
  it('says three is the limit rather than leaving a fourth to fail', async () => {
    createOrganizerForMe.mockRejectedValue(new CallableError('resource-exhausted', 'ORG_LIMIT'));
    await press();

    expect(await screen.findByText(copy.problems.limit)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: copy.resume })).not.toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });

  /** Only reachable if the client rule and the server rule ever disagree — it is mapped anyway. */
  it('shows the name sentence when the server refuses a name this screen allowed', async () => {
    createOrganizerForMe.mockRejectedValue(new CallableError('invalid-argument', 'BAD_NAME'));
    await press();

    expect(await screen.findByText(copy.problems.badName)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: copy.resume })).not.toBeInTheDocument();
  });

  /** Every reason with nothing to say, answered by `describeFailure` rather than by a table. */
  it('falls to the one generic sentence for a reason it has no sentence for', async () => {
    createOrganizerForMe.mockRejectedValue(new CallableError('internal', 'CREATE_ORG_REVERTED'));
    await press();

    expect(await screen.findByText(GENERIC)).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });

  /** A rejection that never came from a callable reads as no reason at all, not as a sentence. */
  it('falls to the same sentence for a failure that is not a server answer', async () => {
    createOrganizerForMe.mockRejectedValue(new Error('Failed to fetch'));
    await press();

    expect(await screen.findByText(GENERIC)).toBeInTheDocument();
  });

  /**
   * The point of routing the else arm through `describeFailure`: a phone with no connection
   * gets told that, and not that making an organisation is the thing that cannot be done.
   */
  it('says the connection is missing when the phone is offline', async () => {
    const onLine = Object.getOwnPropertyDescriptor(Navigator.prototype, 'onLine');
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    try {
      createOrganizerForMe.mockRejectedValue(new Error('Failed to fetch'));
      await press();

      expect(await screen.findByText(ko.common.offlineRetry)).toBeInTheDocument();
      expect(screen.queryByText(GENERIC)).not.toBeInTheDocument();
    } finally {
      Reflect.deleteProperty(navigator, 'onLine');
      if (onLine) Object.defineProperty(Navigator.prototype, 'onLine', onLine);
    }
  });

  /** After a refusal the button is usable again — this one really is worth trying twice. */
  it('unlocks the button again once a refusal is shown', async () => {
    const code: CallableErrorCode = 'internal';
    createOrganizerForMe.mockRejectedValue(new CallableError(code, 'CREATE_ORG_REVERTED'));
    await press();

    expect(await screen.findByText(GENERIC)).toBeInTheDocument();
    expect(createButton()).toBeEnabled();
  });
});
