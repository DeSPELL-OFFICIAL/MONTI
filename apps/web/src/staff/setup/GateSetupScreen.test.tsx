import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { GateRegistration } from './useGateRegistration';

const ADDRESS = '0xCf83795Af2E30a8Bb373610f45563eB97A5aEDb1' as const;
const KX = `0x${'11'.repeat(32)}` as const;
const KY = `0x${'22'.repeat(32)}` as const;

const resubmit = vi.fn();
const useGateRegistration = vi.fn<(params?: { eventId?: string }) => GateRegistration>();

vi.mock('./useGateRegistration', async (importOriginal) => ({
  // `gatePayloadText` is the thing the QR is built from, so the screen must use the real one.
  ...(await importOriginal<typeof import('./useGateRegistration')>()),
  useGateRegistration: (params?: { eventId?: string }) => useGateRegistration(params),
}));

const { GateSetupScreen, PHONE_SIGN_IN_PATH, STAFF_SETUP_PATH } = await import('./GateSetupScreen');
const { staffSetupKo } = await import('../copy');
const { SEEDED_EVENT_ID } = await import('../constants');

function registration(overrides: Partial<GateRegistration> = {}): GateRegistration {
  return {
    status: 'waiting',
    address: ADDRESS,
    payload: { eventId: '1', gateAccount: ADDRESS, kx: KX, ky: KY },
    open: false,
    revoked: false,
    submitted: true,
    submittedAt: Date.now(),
    resubmit,
    ...overrides,
  };
}

/** Stands in for the attendee phone screen, and reports the return target it was handed. */
function SignInProbe() {
  const { state } = useLocation();
  return <div data-testid="sign-in">{(state as { returnTo?: string } | null)?.returnTo ?? ''}</div>;
}

/**
 * The fallback QR is generated asynchronously, so a bare `render` leaves one React update
 * outstanding. Flushing it here keeps every assertion below act-clean without any test having
 * to know that the code exists.
 */
async function renderSetup(): Promise<ReturnType<typeof render>> {
  const view = render(
    <MemoryRouter initialEntries={[STAFF_SETUP_PATH]}>
      <Routes>
        <Route path={STAFF_SETUP_PATH} element={<GateSetupScreen />} />
        <Route path={PHONE_SIGN_IN_PATH} element={<SignInProbe />} />
      </Routes>
    </MemoryRouter>,
  );
  await act(async () => undefined);
  return view;
}

beforeEach(() => {
  resubmit.mockReset();
  useGateRegistration.mockReset().mockReturnValue(registration());
});

describe('gate setup screen', () => {
  it('asks before it applies: nothing is submitted on mount', async () => {
    await renderSetup();
    // `undefined` is what makes the hook poll without submitting. An event registered on the
    // wrong number cannot be moved: `registerGate` refuses the account a second time and
    // `revokeGate` does not free it.
    expect(useGateRegistration).toHaveBeenCalledWith({ eventId: undefined });
    expect(useGateRegistration).not.toHaveBeenCalledWith({ eventId: SEEDED_EVENT_ID });
    // The seeded event is prefilled so the demo is one press away, not zero.
    expect(screen.getByDisplayValue(SEEDED_EVENT_ID)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: staffSetupKo.eventApply })).toBeEnabled();
    expect(screen.getByText(staffSetupKo.notRequested)).toBeInTheDocument();
  });

  it('applies for the prefilled event on one press', async () => {
    const user = userEvent.setup();
    await renderSetup();

    await user.click(screen.getByRole('button', { name: staffSetupKo.eventApply }));
    expect(useGateRegistration).toHaveBeenCalledWith({ eventId: SEEDED_EVENT_ID });
  });

  it('applies for a different event only once the staff member confirms it', async () => {
    const user = userEvent.setup();
    await renderSetup();
    const field = screen.getByDisplayValue(SEEDED_EVENT_ID);

    await user.clear(field);
    await user.type(field, '42');
    // Typing alone must not submit: every keystroke would otherwise be its own application.
    expect(useGateRegistration).not.toHaveBeenCalledWith({ eventId: '4' });
    expect(useGateRegistration).not.toHaveBeenCalledWith({ eventId: '42' });

    await user.click(screen.getByRole('button', { name: staffSetupKo.eventApply }));
    expect(useGateRegistration).toHaveBeenCalledWith({ eventId: '42' });
  });

  it('shows the key being made before there is anything to display', async () => {
    useGateRegistration.mockReturnValue(
      registration({ status: 'creating', address: undefined, payload: undefined, submitted: false }),
    );
    await renderSetup();
    expect(screen.getByText(staffSetupKo.creating)).toBeInTheDocument();
    expect(screen.queryByText(staffSetupKo.fallbackTitle)).toBeNull();
  });

  it('says the request is in, and how long it has been in, while it waits', async () => {
    const user = userEvent.setup();
    await renderSetup();
    await user.click(screen.getByRole('button', { name: staffSetupKo.eventApply }));

    expect(screen.getByText(staffSetupKo.submitted)).toBeInTheDocument();
    expect(screen.getByText(/초째 기다리는 중$/)).toBeInTheDocument();
  });

  it('shows the fallback values the organizer would type in, and a way to try again', async () => {
    const user = userEvent.setup();
    await renderSetup();

    expect(screen.getByText(ADDRESS)).toBeInTheDocument();
    expect(screen.getByText(KX)).toBeInTheDocument();
    expect(screen.getByText(KY)).toBeInTheDocument();
    // The QR is drawn from the same payload; it is asynchronous, so it is awaited.
    expect(await screen.findByRole('img', { name: staffSetupKo.qrAlt })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: staffSetupKo.resubmit }));
    expect(resubmit).toHaveBeenCalledTimes(1);
  });

  it('gives every typed failure its own sentence', async () => {
    for (const [error, line] of [
      ['KEY_UNAVAILABLE', staffSetupKo.errKeyUnavailable],
      ['AUTH_REQUIRED', staffSetupKo.errAuthRequired],
      ['NOT_YOUR_GATE', staffSetupKo.errNotYourGate],
      ['TOO_MANY_PENDING', staffSetupKo.errTooManyPending],
      ['UNKNOWN_EVENT', staffSetupKo.errUnknownEvent],
      ['SUBMIT_REJECTED', staffSetupKo.errSubmitRejected],
      ['CHAIN_UNREACHABLE', staffSetupKo.errChainUnreachable],
    ] as const) {
      useGateRegistration.mockReturnValue(registration({ error, submitted: false }));
      const view = await renderSetup();
      expect(screen.getByText(line)).toBeInTheDocument();
      view.unmount();
    }
  });

  it('offers a way in, and comes back here, when the phone is signed out', async () => {
    const user = userEvent.setup();
    useGateRegistration.mockReturnValue(registration({ error: 'AUTH_REQUIRED', submitted: false }));
    await renderSetup();

    await user.click(screen.getByRole('button', { name: staffSetupKo.signIn }));
    // The attendee phone step, which is the only sign-in this app ships, plus the target that
    // brings the staff member back to the gate instead of into the attendee app.
    expect(await screen.findByTestId('sign-in')).toHaveTextContent(STAFF_SETUP_PATH);
  });

  it('offers no sign-in button for a failure signing in would not fix', async () => {
    useGateRegistration.mockReturnValue(registration({ error: 'TOO_MANY_PENDING', submitted: false }));
    await renderSetup();
    expect(screen.queryByRole('button', { name: staffSetupKo.signIn })).toBeNull();
  });

  it('hands off the gate, event and organizer ids once the chain says it is registered', async () => {
    useGateRegistration.mockReturnValue(
      registration({ status: 'registered', gateId: 7n, eventId: 42n, orgId: 5n, open: true }),
    );
    await renderSetup();

    expect(await screen.findByRole('heading', { name: staffSetupKo.registeredTitle })).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.queryByText(staffSetupKo.notOpen)).toBeNull();
  });

  it('warns when the registered gate has not been opened yet', async () => {
    useGateRegistration.mockReturnValue(
      registration({ status: 'registered', gateId: 7n, eventId: 42n, orgId: 5n, open: false }),
    );
    await renderSetup();
    expect(screen.getByText(staffSetupKo.notOpen)).toBeInTheDocument();
  });

  it('keeps a revoked gate off the entry screen and says why', async () => {
    useGateRegistration.mockReturnValue(
      registration({ status: 'registered', gateId: 7n, eventId: 42n, orgId: 5n, open: true, revoked: true }),
    );
    await renderSetup();
    expect(screen.getByText(staffSetupKo.revoked)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: staffSetupKo.registeredTitle })).toBeNull();
  });
});

describe('staff setup copy', () => {
  it('says everything in both locales', async () => {
    const { staffSetupEn } = await import('../copy');
    expect(Object.keys(staffSetupEn).sort()).toEqual(Object.keys(staffSetupKo).sort());
    for (const value of Object.values(staffSetupEn)) expect(value.length).toBeGreaterThan(0);
  });

  it('keeps the interpolation placeholder in both', async () => {
    const { staffSetupEn } = await import('../copy');
    expect(staffSetupKo.elapsed).toContain('{{seconds}}');
    expect(staffSetupEn.elapsed).toContain('{{seconds}}');
  });
});
