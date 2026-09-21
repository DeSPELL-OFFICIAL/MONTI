import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEVICE_COOLDOWN_SECONDS } from '@monti/shared';
import { ko } from '../../shared/copy/index';

const ACCOUNT = `0x${'ab'.repeat(20)}` as const;
const DAY = 86_400;
const NOW = () => Math.floor(Date.now() / 1000);

const isLocked = vi.fn(async () => false);
const deviceUpdatedAt = vi.fn(async () => BigInt(NOW() - 2 * DAY));
const nicknameOwner = vi.fn(async () => `0x${'00'.repeat(20)}`);
vi.mock('../../shared/chain/reads', async (orig) => ({
  ...(await orig<typeof import('../../shared/chain/reads')>()),
  readIdentity: () => ({ isLocked, deviceUpdatedAt, nicknameOwner }),
}));
vi.mock('../../shared/chain/ops', () => ({ identityOp: vi.fn() }));
vi.mock('../../shared/chain/accounts', () => ({ getAttendeeAccount: async () => ({ address: ACCOUNT }) }));

const lockDevice = vi.fn(async () => ({ txHash: '0xaa' }));
const startDeviceChange = vi.fn(async () => ({
  allowedAt: NOW(), now: NOW(), cooldownSeconds: DEVICE_COOLDOWN_SECONDS, allowed: true,
}));
const getSignupStatus = vi.fn(async () => ({ status: 'active', kycLevel: 1 }));
vi.mock('../../shared/api/functions', async (orig) => ({
  ...(await orig<typeof import('../../shared/api/functions')>()),
  api: { lockDevice, startDeviceChange, getSignupStatus },
}));

const saveUserProfile = vi.fn(async () => undefined);
vi.mock('../../shared/api/firestore', () => ({ saveUserProfile }));

const setLocale = vi.fn(async () => undefined);
vi.mock('../../shared/i18n', async (orig) => ({
  ...(await orig<typeof import('../../shared/i18n')>()),
  setLocale,
}));

vi.mock('../../shared/config', () => ({
  getConfig: () => ({ explorerUrl: 'https://explorer.test' }),
}));

const navigate = vi.fn();
vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
}));

const { setSession } = await import('../../shared/session');
const { fmt } = await import('../../shared/i18n');
const { ROTATION_UNDO_WINDOW_SECONDS } = await import('../../shared/chain/reads');
const { DeviceLock } = await import('./DeviceLock');
const { NewDevice } = await import('./NewDevice');
const { Profile, KycStatus } = await import('./Profile');

const UNDO_HOURS = ROTATION_UNDO_WINDOW_SECONDS / 3_600;

function wrap(node: ReactNode) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  setSession({ status: 'signedIn', account: ACCOUNT });
  isLocked.mockResolvedValue(false);
  deviceUpdatedAt.mockResolvedValue(BigInt(NOW() - 2 * DAY));
  lockDevice.mockResolvedValue({ txHash: '0xaa' });
  getSignupStatus.mockResolvedValue({ status: 'active', kycLevel: 1 });
});

describe('DeviceLock', () => {
  it('reads the lock state from the chain rather than remembering it', async () => {
    isLocked.mockResolvedValue(true);
    wrap(<DeviceLock />);
    expect(await screen.findByText(ko.me.locked)).toBeInTheDocument();
    expect(await screen.findByText(ko.me.unlockGuide)).toBeInTheDocument();
  });

  it('locks on demand', async () => {
    wrap(<DeviceLock />);
    await userEvent.click(await screen.findByRole('button', { name: ko.me.lockCta }));
    expect(lockDevice).toHaveBeenCalled();
    expect(await screen.findByText(ko.me.locked)).toBeInTheDocument();
  });

  it('treats alreadyLocked as locked, not as a failure', async () => {
    lockDevice.mockResolvedValue({ alreadyLocked: true } as never);
    wrap(<DeviceLock />);
    await userEvent.click(await screen.findByRole('button', { name: ko.me.lockCta }));
    expect(await screen.findByText(ko.me.locked)).toBeInTheDocument();
    expect(screen.queryByText(ko.me.lockFailed)).not.toBeInTheDocument();
  });

  it('says so when the lock did not go through', async () => {
    lockDevice.mockRejectedValueOnce(new Error('nope'));
    wrap(<DeviceLock />);
    await userEvent.click(await screen.findByRole('button', { name: ko.me.lockCta }));
    expect(await screen.findByText(ko.me.lockFailed)).toBeInTheDocument();
  });
});

describe('NewDevice', () => {
  it('counts the wait from the chain, not from anything stored here', async () => {
    wrap(<NewDevice />);
    expect(await screen.findByText(fmt(ko.me.newDeviceWait, { days: 5 }))).toBeInTheDocument();
    expect(deviceUpdatedAt).toHaveBeenCalledWith(ACCOUNT);
  });

  it('spells out the undo window, the quarantine and the automatic move', async () => {
    wrap(<NewDevice />);
    for (const sentence of [ko.me.recoveryUndo, ko.me.recoveryQuarantine, ko.me.recoveryMigrate]) {
      const rendered = fmt(sentence, { hours: UNDO_HOURS });
      expect(await screen.findByText(rendered)).toBeInTheDocument();
      // The window is read, never typed: the rendered sentence carries the contract's number.
      expect(rendered).toContain(String(UNDO_HOURS));
    }
  });

  it('asks the server when the change is allowed and shows the answer', async () => {
    deviceUpdatedAt.mockResolvedValue(BigInt(NOW() - 8 * DAY));
    wrap(<NewDevice />);
    await userEvent.click(await screen.findByRole('button', { name: ko.me.newDeviceCta }));
    expect(startDeviceChange).toHaveBeenCalledWith({ method: 'sms' });
    expect(await screen.findByText(ko.me.newDeviceReady)).toBeInTheDocument();
  });

  it('turns the server’s refusal reasons into their own sentences', async () => {
    startDeviceChange.mockRejectedValueOnce({ code: 'failed-precondition', message: 'PHONE_REAUTH_REQUIRED' } as never);
    wrap(<NewDevice />);
    await userEvent.click(await screen.findByRole('button', { name: ko.me.newDeviceCta }));
    expect(await screen.findByText(ko.me.newDeviceNeedsPhone)).toBeInTheDocument();

    startDeviceChange.mockRejectedValueOnce({ code: 'failed-precondition', message: 'KYC_REQUIRED' } as never);
    await userEvent.click(screen.getByRole('button', { name: ko.me.newDeviceCta }));
    expect(await screen.findByText(ko.me.newDeviceNeedsKyc)).toBeInTheDocument();
  });
});

describe('KycStatus', () => {
  it('offers the verification screen only while it is unverified', async () => {
    getSignupStatus.mockResolvedValue({ status: 'pending', kycLevel: 0 });
    wrap(<KycStatus />);
    await userEvent.click(await screen.findByRole('button', { name: ko.kyc.cta }));
    expect(navigate).toHaveBeenCalledWith('/me/verify?returnTo=/me');
  });

  it('shows the verified state with nothing left to do', async () => {
    wrap(<KycStatus />);
    expect(await screen.findByText(ko.kyc.verified)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: ko.kyc.cta })).not.toBeInTheDocument();
  });
});

describe('Profile', () => {
  it('stores the chosen language on the device and on the profile', async () => {
    wrap(<Profile />);
    await userEvent.selectOptions(await screen.findByLabelText(ko.me.language), 'en');
    expect(setLocale).toHaveBeenCalledWith('en');
    await waitFor(() => expect(saveUserProfile).toHaveBeenCalledWith({ locale: 'en' }));
  });

  it('links the public record at this account', async () => {
    wrap(<Profile />);
    expect(await screen.findByRole('link', { name: ko.me.publicRecord })).toHaveAttribute(
      'href', `https://explorer.test/address/${ACCOUNT}`,
    );
  });

  it('hands account deletion off by mail, because no callable does it', async () => {
    wrap(<Profile />);
    expect(await screen.findByText(ko.me.deleteRequestNote)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: ko.me.deleteAccount });
    expect(link.getAttribute('href')).toMatch(/^mailto:/);
  });
});
