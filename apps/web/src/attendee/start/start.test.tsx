import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { en as copy } from './copy';

const PERSON_ID = `0x${'aa'.repeat(32)}`;
const ACCOUNT = `0x${'ab'.repeat(20)}`;
const DEVICE_X = `0x${'11'.repeat(32)}`;
const DEVICE_Y = `0x${'22'.repeat(32)}`;

const startSignup = vi.fn(async () => ({ personId: PERSON_ID }));
const registerIdentity = vi.fn(async () => ({ txHash: '0xtx' }));
const getSignupStatus = vi.fn(async () => ({ status: 'none', hasPasskey: false, hasAccount: false }));
vi.mock('../../shared/api/functions', async (orig) => ({
  ...(await orig<typeof import('../../shared/api/functions')>()),
  api: { startSignup, registerIdentity, getSignupStatus },
}));

const ensureFirebaseUser = vi.fn(async () => ({ reused: false }));
vi.mock('../../shared/api/auth', () => ({ ensureFirebaseUser }));

class DeviceKeyUnavailable extends Error {
  constructor() {
    super('DeviceKeyUnavailable');
    this.name = 'DeviceKeyUnavailable';
  }
}
const ensureDeviceKey = vi.fn(async () => ({ x: DEVICE_X, y: DEVICE_Y, backing: 'software' }));
vi.mock('../../shared/deviceKey', () => ({
  ensureDeviceKey,
  ATTENDEE_KEY_ALIAS: 'monti-attendee',
  DeviceKeyUnavailable,
}));

/** The forced refresh is where the server's claims reach the hydrator — here, the session store. */
const getIdToken = vi.fn(async () => {
  setSession({ status: 'signedIn', personId: PERSON_ID, account: ACCOUNT as `0x${string}` });
  return 'token';
});
vi.mock('../../shared/api/firebase', () => ({
  getFirebaseAuth: () => ({ currentUser: { getIdToken } }),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: () => 'web', isNativePlatform: () => false },
}));

const { setSession } = await import('../../shared/session');
const { getRegistration, resetRegistration } = await import('../../shared/registration');
const { Start, CLAIMS_WAIT_MS } = await import('./Start');

function renderAt(path = '/start?returnTo=%2Fclaim%2F9') {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/start" element={<Start />} />
        <Route path="/claim/:id" element={<h1>claim page</h1>} />
        <Route path="/" element={<h1>home page</h1>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  setSession({ status: 'anonymous' });
  resetRegistration();
  startSignup.mockClear();
  registerIdentity.mockReset().mockResolvedValue({ txHash: '0xtx' });
  getSignupStatus.mockReset().mockResolvedValue({ status: 'none', hasPasskey: false, hasAccount: false });
  ensureFirebaseUser.mockReset().mockResolvedValue({ reused: false });
  ensureDeviceKey.mockReset().mockResolvedValue({ x: DEVICE_X, y: DEVICE_Y, backing: 'software' });
  getIdToken.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Start (open mode)', () => {
  it('shows one button and the promise, nothing to fill in', () => {
    renderAt();
    expect(screen.getByRole('heading', { name: copy.title })).toBeInTheDocument();
    expect(screen.getByText(copy.subtitle)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: copy.cta })).toBeEnabled();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('signs in, starts the person, registers this browser key, refreshes, and goes to returnTo', async () => {
    renderAt();
    await userEvent.click(screen.getByRole('button', { name: copy.cta }));

    expect(await screen.findByRole('heading', { name: 'claim page' })).toBeInTheDocument();
    expect(ensureFirebaseUser).toHaveBeenCalledTimes(1);
    // A fresh anonymous user has nobody behind it yet; asking would be a wasted round trip.
    expect(getSignupStatus).not.toHaveBeenCalled();
    expect(startSignup).toHaveBeenCalledTimes(1);
    expect(ensureDeviceKey).toHaveBeenCalledWith(expect.objectContaining({ alias: 'monti-attendee' }));
    expect(registerIdentity).toHaveBeenCalledWith({
      personId: PERSON_ID, deviceX: DEVICE_X, deviceY: DEVICE_Y, platform: 'web',
    });
    expect(getIdToken).toHaveBeenCalledWith(true);
    expect(getRegistration()).toBe('done');
  });

  it('goes home when there is nowhere to return to', async () => {
    renderAt('/start');
    await userEvent.click(screen.getByRole('button', { name: copy.cta }));
    expect(await screen.findByRole('heading', { name: 'home page' })).toBeInTheDocument();
  });

  it('refuses an off-site returnTo', async () => {
    renderAt('/start?returnTo=https%3A%2F%2Fevil.example');
    await userEvent.click(screen.getByRole('button', { name: copy.cta }));
    expect(await screen.findByRole('heading', { name: 'home page' })).toBeInTheDocument();
  });

  it('skips straight to the refresh when the reused person is already active', async () => {
    ensureFirebaseUser.mockResolvedValue({ reused: true });
    getSignupStatus.mockResolvedValue({ status: 'active', hasPasskey: false, hasAccount: true });
    renderAt();
    await userEvent.click(screen.getByRole('button', { name: copy.cta }));

    expect(await screen.findByRole('heading', { name: 'claim page' })).toBeInTheDocument();
    expect(startSignup).not.toHaveBeenCalled();
    expect(ensureDeviceKey).not.toHaveBeenCalled();
    expect(registerIdentity).not.toHaveBeenCalled();
    expect(getIdToken).toHaveBeenCalledWith(true);
  });

  it('continues a reused person who is still pending', async () => {
    ensureFirebaseUser.mockResolvedValue({ reused: true });
    getSignupStatus.mockResolvedValue({ status: 'pending', hasPasskey: false, hasAccount: false });
    renderAt();
    await userEvent.click(screen.getByRole('button', { name: copy.cta }));
    expect(await screen.findByRole('heading', { name: 'claim page' })).toBeInTheDocument();
    expect(startSignup).toHaveBeenCalledTimes(1);
    expect(registerIdentity).toHaveBeenCalledTimes(1);
  });

  it('never shows the button to somebody already signed in', async () => {
    setSession({ status: 'signedIn', personId: PERSON_ID, account: ACCOUNT as `0x${string}` });
    renderAt();
    expect(await screen.findByRole('heading', { name: 'claim page' })).toBeInTheDocument();
    expect(ensureFirebaseUser).not.toHaveBeenCalled();
  });

  it('says it plainly and offers Try again when registration fails, then succeeds on the retry', async () => {
    registerIdentity.mockRejectedValueOnce({ code: 'internal', message: 'INTERNAL' });
    renderAt();
    await userEvent.click(screen.getByRole('button', { name: copy.cta }));

    expect(await screen.findByText(copy.failed)).toBeInTheDocument();
    const retry = screen.getByRole('button', { name: copy.retry });
    await userEvent.click(retry);
    expect(await screen.findByRole('heading', { name: 'claim page' })).toBeInTheDocument();
  });

  it('surfaces PASSKEY_REQUIRED as our bug, with its code', async () => {
    registerIdentity.mockRejectedValue({ code: 'failed-precondition', message: 'PASSKEY_REQUIRED' });
    renderAt();
    await userEvent.click(screen.getByRole('button', { name: copy.cta }));
    expect(await screen.findByText(copy.serverBug)).toBeInTheDocument();
    expect(screen.getByText(/PASSKEY_REQUIRED/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: copy.retry })).toBeEnabled();
  });

  it('tells a private window it cannot keep a pass', async () => {
    ensureDeviceKey.mockRejectedValue(new DeviceKeyUnavailable());
    renderAt();
    await userEvent.click(screen.getByRole('button', { name: copy.cta }));
    expect(await screen.findByText(copy.noStorage)).toBeInTheDocument();
    expect(registerIdentity).not.toHaveBeenCalled();
  });

  it('waits out a busy attester on its own, saying so, before finishing', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    registerIdentity.mockRejectedValueOnce({ code: 'resource-exhausted', message: 'ATTESTER_BUSY' });
    renderAt();
    await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).click(
      screen.getByRole('button', { name: copy.cta }),
    );
    expect(await screen.findByText(copy.busy)).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(await screen.findByRole('heading', { name: 'claim page' })).toBeInTheDocument();
    expect(registerIdentity).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(copy.busyFailed)).toBeNull();
  });

  it('reports missing claims instead of spinning forever', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    getIdToken.mockImplementationOnce(async () => 'token-without-claims');
    renderAt();
    await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).click(
      screen.getByRole('button', { name: copy.cta }),
    );
    await waitFor(() => expect(getIdToken).toHaveBeenCalled());
    await act(async () => { await vi.advanceTimersByTimeAsync(CLAIMS_WAIT_MS); });
    expect(await screen.findByText(copy.serverBug)).toBeInTheDocument();
    expect(screen.getByText(/CLAIMS_MISSING/)).toBeInTheDocument();
  });
});
