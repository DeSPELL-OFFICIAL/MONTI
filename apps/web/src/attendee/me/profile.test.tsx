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
const AUTH = { name: 'auth' };
/** The grace period the server answers with: seven days, in epoch seconds. */
const SCHEDULED_FOR = Math.floor(Date.now() / 1000) + 7 * DAY;

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
const requestAccountDeletion = vi.fn(async () => ({ scheduledFor: SCHEDULED_FOR, onChainRetained: true as const }));
vi.mock('../../shared/api/functions', async (orig) => ({
  ...(await orig<typeof import('../../shared/api/functions')>()),
  api: { lockDevice, startDeviceChange, getSignupStatus, requestAccountDeletion },
}));

const signOut = vi.fn(async () => undefined);
vi.mock('firebase/auth', () => ({ signOut }));
vi.mock('../../shared/api/firebase', () => ({
  getFirebaseAuth: () => AUTH,
  getFirebaseFunctions: () => ({ name: 'functions' }),
}));

const saveUserProfile = vi.fn(async () => undefined);
// `loadOrgName` belongs to the same module and is what `useMyOrgs` — now reached through the
// profile's 주최자 section — reads an organisation's display name with. Left out of the mock it
// is not a missing stub but a missing export, and every render in this file throws.
const loadOrgName = vi.fn(async (): Promise<string | null> => null);
vi.mock('../../shared/api/firestore', () => ({ saveUserProfile, loadOrgName }));

// The 주최자 section is driven through the real `useMyOrgs` here — this file is where the
// whole chain, indexer row to button label, is proved — so the indexer transport is mocked and
// nothing else is.
const gql = vi.fn();
vi.mock('../../shared/envio/client', () => ({ gql }));

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
  gql.mockReset();
  loadOrgName.mockReset();
  // The plain case: this person organises for nobody.
  gql.mockResolvedValue({ Organizer: [], Admin: [], Manager: [] });
  loadOrgName.mockResolvedValue(null);
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

  it('asks the server when the change is allowed, and says what to do next', async () => {
    deviceUpdatedAt.mockResolvedValue(BigInt(NOW() - 8 * DAY));
    wrap(<NewDevice />);
    await userEvent.click(await screen.findByRole('button', { name: ko.me.newDeviceCta }));
    // `sms` needs a phone re-auth session this app cannot open, so it is not offered at all.
    expect(startDeviceChange).toHaveBeenCalledWith({ method: 'kyc' });
    expect(await screen.findByText(ko.me.newDeviceReady)).toBeInTheDocument();
    // Nothing switched here and nothing can: the screen has to hand the person on.
    expect(await screen.findByText(ko.me.newDeviceNext)).toBeInTheDocument();
  });

  it('offers no method to pick, because only one of them can answer', async () => {
    wrap(<NewDevice />);
    await screen.findByRole('button', { name: ko.me.newDeviceCta });
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('sends the unverified to the one screen that exists, and promises nothing else', async () => {
    startDeviceChange.mockRejectedValueOnce({ code: 'failed-precondition', message: 'KYC_REQUIRED' } as never);
    wrap(<NewDevice />);
    await userEvent.click(await screen.findByRole('button', { name: ko.me.newDeviceCta }));
    expect(await screen.findByText(ko.me.newDeviceNeedsKyc)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: ko.kyc.cta }));
    expect(navigate).toHaveBeenCalledWith('/me/verify?returnTo=/me');
  });

  it('does not tell anybody to re-verify a number on a screen that does not exist', async () => {
    startDeviceChange.mockRejectedValueOnce({ code: 'failed-precondition', message: 'PHONE_REAUTH_REQUIRED' } as never);
    wrap(<NewDevice />);
    await userEvent.click(await screen.findByRole('button', { name: ko.me.newDeviceCta }));
    expect(await screen.findByText(ko.me.newDeviceNeedsPhone)).toBeInTheDocument();
    // No route serves a phone re-authentication, so this refusal gets no button at all.
    expect(screen.queryByRole('button', { name: ko.kyc.cta })).not.toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('says the tickets are fetched on the new phone, not that they arrive by themselves', async () => {
    wrap(<NewDevice />);
    const sentence = fmt(ko.me.recoveryMigrate, { hours: UNDO_HOURS });
    expect(await screen.findByText(sentence)).toBeInTheDocument();
    // `Ticket.migrate` is a call the NEW account has to send; nothing moves on its own.
    expect(sentence).toContain('티켓 가져오기');
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
    expect(await screen.findByText(ko.kyc.mineVerified)).toBeInTheDocument();
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

  /**
   * Every other way out of this screen is self-service. Locking the phone, changing phones and
   * deleting the account all end somewhere a person may need a human, and the footer is the only
   * address the app ever gives them — so it is pinned to the shared key rather than to a literal.
   */
  it('offers the support address in the footer, as something to tap', async () => {
    wrap(<Profile />);
    const link = await screen.findByRole('link', { name: ko.common.contactEmail });
    expect(link).toHaveAttribute('href', `mailto:${ko.common.contactEmail}`);
    expect(screen.getByText(ko.common.contactHelp, { exact: false })).toBeInTheDocument();
  });

  it('states the three facts before it deletes anything', async () => {
    wrap(<Profile />);
    await userEvent.click(await screen.findByRole('button', { name: ko.me.deleteCta }));
    // Signing in stops now, the personal details go in seven days, the public record stays.
    expect(screen.getByText(ko.me.deleteSignOut)).toBeInTheDocument();
    expect(screen.getByText(ko.me.deleteErase)).toBeInTheDocument();
    expect(screen.getByText(ko.me.deleteRetained)).toBeInTheDocument();
    // Asking is not requesting: nothing has been sent while the dialog is up.
    expect(requestAccountDeletion).not.toHaveBeenCalled();
  });

  it('requests the deletion once, shows the date and signs the person out', async () => {
    wrap(<Profile />);
    await userEvent.click(await screen.findByRole('button', { name: ko.me.deleteCta }));
    await userEvent.click(screen.getByRole('button', { name: ko.me.deleteConfirmCta }));

    await waitFor(() => expect(requestAccountDeletion).toHaveBeenCalledTimes(1));
    const date = new Date(SCHEDULED_FOR * 1_000).toLocaleDateString('ko');
    expect(await screen.findByText(fmt(ko.me.deleteScheduled, { date }))).toBeInTheDocument();
    // The server already revoked this session; leaving the app looking signed in would only
    // hand back opaque refusals on the next tap.
    await waitFor(() => expect(signOut).toHaveBeenCalledWith(AUTH));
    // Nothing left to press: the account is on its way out.
    expect(screen.queryByRole('button', { name: ko.me.deleteCta })).not.toBeInTheDocument();
  });

  it('does nothing at all when the person backs out', async () => {
    wrap(<Profile />);
    await userEvent.click(await screen.findByRole('button', { name: ko.me.deleteCta }));
    await userEvent.click(screen.getByRole('button', { name: ko.common.cancel }));

    expect(requestAccountDeletion).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
    expect(screen.queryByText(ko.me.deleteSignOut)).not.toBeInTheDocument();
    // The way back in is still there.
    expect(screen.getByRole('button', { name: ko.me.deleteCta })).toBeInTheDocument();
  });

  /**
   * The profile is the other half of the answer to "there is no way into `/org`" — the first
   * half being 탐색's floating 만들기. Both read `useOrganizerEntry`, and this is the file that
   * drives it through the real indexer rows rather than through a stubbed hook.
   */
  it('opens the organiser screens for somebody who organises for an organisation', async () => {
    gql.mockResolvedValue({
      Organizer: [{ id: '3', owner: ACCOUNT.toLowerCase() }], Admin: [], Manager: [],
    });
    loadOrgName.mockResolvedValue('재즈 컴퍼니');
    wrap(<Profile />);
    await userEvent.click(await screen.findByRole('button', { name: ko.me.organizerOpen }));
    // Manage, not make: the profile never drops anybody straight into creating, even an owner.
    expect(navigate).toHaveBeenCalledWith('/org');
    expect(screen.queryByText(ko.me.organizerHint)).not.toBeInTheDocument();
  });

  it('offers to make one, and says what for, when there is no organisation', async () => {
    wrap(<Profile />);
    await userEvent.click(await screen.findByRole('button', { name: ko.me.organizerBecome }));
    expect(navigate).toHaveBeenCalledWith('/org/become');
    expect(screen.getByText(ko.me.organizerHint)).toBeInTheDocument();
  });

  it('says nothing at all while the indexer is still answering', async () => {
    // A question that never resolves: the section may show its heading and a spinner, and
    // neither label — `주최자 되기` to somebody who already runs three organisations would be
    // the worse of the two guesses.
    gql.mockImplementation(() => new Promise(() => undefined));
    wrap(<Profile />);
    expect(await screen.findByRole('heading', { name: ko.me.organizer })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: ko.me.organizerBecome })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: ko.me.organizerOpen })).not.toBeInTheDocument();
    expect(screen.queryByText(ko.me.organizerHint)).not.toBeInTheDocument();
  });

  it('keeps the person signed in when the request did not go through', async () => {
    requestAccountDeletion.mockRejectedValueOnce(new Error('unavailable') as never);
    wrap(<Profile />);
    await userEvent.click(await screen.findByRole('button', { name: ko.me.deleteCta }));
    await userEvent.click(screen.getByRole('button', { name: ko.me.deleteConfirmCta }));

    expect(await screen.findByText(ko.me.deleteFailed)).toBeInTheDocument();
    expect(signOut).not.toHaveBeenCalled();
    // The dialog is still up, so a second try is one tap away.
    expect(screen.getByRole('button', { name: ko.me.deleteConfirmCta })).toBeInTheDocument();
  });
});
