import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toFunctionSelector } from 'viem';
import { DEVICE_COOLDOWN_SECONDS, MIGRATE_DELAY_SECONDS } from '@monti/shared';
import { ko } from '../../shared/copy/index';

const ACCOUNT = `0x${'ab'.repeat(20)}` as const;
/** The account a rotation pushed aside, when that account is not this phone. */
const OTHER = `0x${'cd'.repeat(20)}` as const;
/** What `rotatedFrom` answers when there is no rotation to undo. */
const NO_ACCOUNT = `0x${'00'.repeat(20)}` as const;
const PERSON_ID = `0x${'11'.repeat(32)}` as const;
const DAY = 86_400;
const NOW = () => Math.floor(Date.now() / 1000);
const AUTH = { name: 'auth' };
/** The grace period the server answers with: seven days, in epoch seconds. */
const SCHEDULED_FOR = Math.floor(Date.now() / 1000) + 7 * DAY;

/**
 * Deliberately NOT 24 h. The recovery sentences interpolate whatever
 * `Identity.ROTATION_UNDO_WINDOW()` answers with, so a screen that went back to writing the
 * span out by hand would read 24 here and fail.
 */
const UNDO_WINDOW_SECONDS = 30 * 3_600;

const isLocked = vi.fn(async () => false);
const deviceUpdatedAt = vi.fn(async () => BigInt(NOW() - 2 * DAY));
const nicknameOwner = vi.fn(async () => `0x${'00'.repeat(20)}`);
const rotationUndoWindow = vi.fn(async () => BigInt(UNDO_WINDOW_SECONDS));
const rotatedFrom = vi.fn(async (): Promise<string> => NO_ACCOUNT);
const rotatedAt = vi.fn(async () => 0n);
const migrateDelay = vi.fn(async () => BigInt(UNDO_WINDOW_SECONDS));
const eventOf = vi.fn(async () => 5n);
const eventMeta = vi.fn(async () => ({ orgId: 9n }));
vi.mock('../../shared/chain/reads', async (orig) => ({
  ...(await orig<typeof import('../../shared/chain/reads')>()),
  readIdentity: () => ({
    isLocked, deviceUpdatedAt, nicknameOwner, rotationUndoWindow, rotatedFrom, rotatedAt,
  }),
  readTicket: () => ({ migrateDelay, eventOf, eventMeta }),
}));
// The real `OpReverted` is kept: both recovery buttons tell a named refusal from anything else
// by the four bytes that class carries, and a stubbed-out module would make `instanceof` throw.
const identityOp = vi.fn();
const ticketOp = vi.fn();
vi.mock('../../shared/chain/ops', async (orig) => ({
  ...(await orig<typeof import('../../shared/chain/ops')>()),
  identityOp,
  ticketOp,
}));
vi.mock('../../shared/chain/accounts', () => ({ getAttendeeAccount: async () => ({ address: ACCOUNT }) }));

// The tickets to migrate are read for the account the rotation pushed aside, not for the
// signed-in one — `migrate` is what moves them, so until it runs the index still shows the old
// account holding them.
const loadMyTickets = vi.fn(async (_owner: string): Promise<{ tokenId: string; state: string }[]> => []);
vi.mock('../tickets/useTickets', () => ({ loadMyTickets }));

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
// The stored 표시 이름, which is what the ticket is printed with and what the box prefills from.
const loadMyProfile = vi.fn(async (): Promise<{ displayName: string } | null> => ({
  displayName: '김태완',
}));
/**
 * The cap `users/{uid}.displayName` is held to, on this side and in the deployed rule alike.
 * Written out here rather than imported because the module it lives in is mocked away above —
 * the screen reuses the real constant, and this is the number that constant has to be.
 */
const MAX_DISPLAY_NAME_CHARS = 24;
vi.mock('../../shared/api/firestore', () => ({
  saveUserProfile, loadOrgName, loadMyProfile, MAX_DISPLAY_NAME_CHARS,
}));

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
const { OpReverted } = await import('../../shared/chain/ops');
const { DeviceLock } = await import('./DeviceLock');
const { NewDevice } = await import('./NewDevice');
const { Profile, KycStatus } = await import('./Profile');

const UNDO_HOURS = UNDO_WINDOW_SECONDS / 3_600;

function wrap(node: ReactNode) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  setSession({ status: 'signedIn', account: ACCOUNT, personId: PERSON_ID });
  rotationUndoWindow.mockReset().mockResolvedValue(BigInt(UNDO_WINDOW_SECONDS));
  migrateDelay.mockReset().mockResolvedValue(BigInt(UNDO_WINDOW_SECONDS));
  // The plain case: this person has never been rotated, so neither recovery button is offered.
  rotatedFrom.mockReset().mockResolvedValue(NO_ACCOUNT);
  rotatedAt.mockReset().mockResolvedValue(0n);
  identityOp.mockReset().mockResolvedValue({ success: true });
  ticketOp.mockReset().mockResolvedValue({ success: true });
  loadMyTickets.mockReset().mockResolvedValue([]);
  gql.mockReset();
  loadOrgName.mockReset();
  loadMyProfile.mockReset().mockResolvedValue({ displayName: '김태완' });
  saveUserProfile.mockReset().mockResolvedValue(undefined);
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
      // The window is read, never typed: the rendered sentence carries the contract's number,
      // which is why the mock answers with a span that is deliberately not 24 h.
      expect(rendered).toContain(String(UNDO_HOURS));
    }
    expect(rotationUndoWindow).toHaveBeenCalled();
  });

  it('still says the three things when the window cannot be read', async () => {
    // `Identity.ROTATION_UNDO_WINDOW` and `Ticket.MIGRATE_DELAY` are equal by construction — a
    // contract test asserts it — so an unread view falls back to the other's constant rather
    // than leaving the person with no sentence at all before an irreversible move.
    rotationUndoWindow.mockRejectedValue(new Error('offline'));
    wrap(<NewDevice />);
    const hours = MIGRATE_DELAY_SECONDS / 3_600;
    expect(await screen.findByText(fmt(ko.me.recoveryUndo, { hours }))).toBeInTheDocument();
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

  it('offers neither recovery button to somebody no rotation ever touched', async () => {
    // `rotatedAt` is stamped by `register` too, so every member carries one. Reading it as the
    // flag would put both buttons in front of everybody who ever signed up.
    rotatedAt.mockResolvedValue(BigInt(NOW() - 3_600));
    wrap(<NewDevice />);
    await screen.findByRole('button', { name: ko.me.newDeviceCta });
    expect(screen.queryByRole('button', { name: ko.me.undoCta })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: ko.me.migrateCta })).not.toBeInTheDocument();
  });

  it('lets the account a rotation pushed aside take the move back, without gas of its own', async () => {
    rotatedFrom.mockResolvedValue(ACCOUNT);
    rotatedAt.mockResolvedValue(BigInt(NOW() - 3_600));
    wrap(<NewDevice />);
    await userEvent.click(await screen.findByRole('button', { name: ko.me.undoCta }));
    // Platform-sponsored (ArgKind 1), which is the whole point of C3: the pushed-aside account
    // is the one holding nothing, so `orgId` is 0 rather than any organisation's.
    expect(identityOp).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 0n, functionName: 'cancelRotation', args: [] }),
    );
    expect(await screen.findByText(ko.me.undoDone)).toBeInTheDocument();
  });

  it('warns that undoing leaves this phone locked, because cancelRotation does not clear it', async () => {
    rotatedFrom.mockResolvedValue(ACCOUNT);
    rotatedAt.mockResolvedValue(BigInt(NOW() - 3_600));
    wrap(<NewDevice />);
    expect(await screen.findByText(ko.me.undoBody)).toBeInTheDocument();
  });

  it('says the window has closed when the contract refuses the undo', async () => {
    rotatedFrom.mockResolvedValue(ACCOUNT);
    rotatedAt.mockResolvedValue(BigInt(NOW() - 3_600));
    identityOp.mockRejectedValueOnce(
      new OpReverted('cancelRotation', toFunctionSelector('NoRotationToCancel()')),
    );
    wrap(<NewDevice />);
    await userEvent.click(await screen.findByRole('button', { name: ko.me.undoCta }));
    expect(await screen.findByText(ko.me.undoGone)).toBeInTheDocument();
    expect(screen.queryByText(ko.me.undoFailed)).not.toBeInTheDocument();
  });

  it('takes the undo away once the window has closed, and offers nothing in its place', async () => {
    rotatedFrom.mockResolvedValue(ACCOUNT);
    rotatedAt.mockResolvedValue(BigInt(NOW() - 2 * DAY));
    wrap(<NewDevice />);
    await screen.findByRole('button', { name: ko.me.newDeviceCta });
    expect(screen.queryByRole('button', { name: ko.me.undoCta })).not.toBeInTheDocument();
    // `Ticket.migrate` refuses anybody but the account the rotation moved TO
    // (`NotRotatedAccount`), so this phone never gets that button either.
    expect(screen.queryByRole('button', { name: ko.me.migrateCta })).not.toBeInTheDocument();
    expect(loadMyTickets).not.toHaveBeenCalled();
  });

  it('fetches the tickets still on the old account, one operation each, skipping the spent ones', async () => {
    rotatedFrom.mockResolvedValue(OTHER);
    rotatedAt.mockResolvedValue(BigInt(NOW() - 2 * DAY));
    loadMyTickets.mockResolvedValue([
      { tokenId: '7', state: 'before' },
      // `migrate` refuses a ticket somebody already walked in on (`AlreadyCheckedIn`), so it is
      // never offered — a refusal spent on it would be a refusal the person cannot act on.
      { tokenId: '8', state: 'entered' },
    ]);
    wrap(<NewDevice />);
    await userEvent.click(await screen.findByRole('button', { name: ko.me.migrateCta }));
    // Read for the pushed-aside account, not for the signed-in one: until `migrate` runs, the
    // index still shows the old account holding them.
    expect(loadMyTickets).toHaveBeenCalledWith(OTHER.toLowerCase());
    expect(ticketOp).toHaveBeenCalledTimes(1);
    // TokenId-sponsored, so the organisation is the ticket's own event's — never invented here.
    expect(ticketOp).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 9n, functionName: 'migrate', args: [7n] }),
    );
    expect(await screen.findByText(fmt(ko.me.migrateDone, { count: 1 }))).toBeInTheDocument();
  });

  it('says the wait is still running when the timelock refuses the move', async () => {
    rotatedFrom.mockResolvedValue(OTHER);
    rotatedAt.mockResolvedValue(BigInt(NOW() - 2 * DAY));
    loadMyTickets.mockResolvedValue([{ tokenId: '7', state: 'before' }]);
    ticketOp.mockRejectedValueOnce(new OpReverted('migrate', toFunctionSelector('RotationPending()')));
    wrap(<NewDevice />);
    await userEvent.click(await screen.findByRole('button', { name: ko.me.migrateCta }));
    expect(await screen.findByText(fmt(ko.me.migrateWait, { hours: UNDO_HOURS }))).toBeInTheDocument();
    expect(screen.queryByText(ko.me.migrateFailed)).not.toBeInTheDocument();
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

/**
 * T-UX2-16. The name printed on a ticket is asked for once while signing up; this is the only
 * place it can be changed afterwards. It shares a screen with the chain nickname and shares
 * nothing else with it.
 */
describe('the display name', () => {
  /**
   * The box, once the stored name has actually landed in it. Waiting matters: the read answers
   * a tick after the first render, and typing into the box before it lands would be typing that
   * the prefill then appends itself to — which is the bug the `typed` guard exists to stop.
   */
  async function nameBox(prefill = '김태완'): Promise<HTMLElement> {
    const box = await screen.findByLabelText(ko.me.displayName);
    await waitFor(() => expect(box).toHaveValue(prefill));
    return box;
  }

  function nameSection(box: HTMLElement): HTMLElement {
    return box.closest('section') as HTMLElement;
  }

  it('starts filled in with the name already stored', async () => {
    wrap(<Profile />);
    await waitFor(() => expect(screen.getByLabelText(ko.me.displayName)).toHaveValue('김태완'));
    // One line saying which of the two names this is, so the pair is not one question twice.
    expect(screen.getByText(ko.me.displayNameVsNickname)).toBeInTheDocument();
  });

  it('sends the one field the rule admits, and nothing else', async () => {
    wrap(<Profile />);
    const box = await nameBox();
    await userEvent.clear(box);
    await userEvent.type(box, '김민지');
    await userEvent.click(within(nameSection(box)).getByRole('button', { name: ko.common.save }));

    // Exactly `{ displayName }`: `changedOnly` in firestore.rules refuses a patch that carries
    // anything the list does not name, and a refusal is not a message anybody can act on.
    await waitFor(() => expect(saveUserProfile).toHaveBeenCalledWith({ displayName: '김민지' }));
    expect(saveUserProfile).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(ko.me.displayNameSaved)).toBeInTheDocument();
  });

  it('stops at the length the rule stops at', async () => {
    loadMyProfile.mockResolvedValue({ displayName: '' });
    wrap(<Profile />);
    const box = await nameBox('');
    expect(box).toHaveAttribute('maxlength', String(MAX_DISPLAY_NAME_CHARS));

    await userEvent.type(box, '가'.repeat(MAX_DISPLAY_NAME_CHARS + 6));
    expect(box).toHaveValue('가'.repeat(MAX_DISPLAY_NAME_CHARS));
  });

  it('keeps what was typed when the write is refused, and says so', async () => {
    saveUserProfile.mockRejectedValueOnce(new Error('permission-denied') as never);
    wrap(<Profile />);
    const box = await nameBox();
    await userEvent.clear(box);
    await userEvent.type(box, '김민지');
    await userEvent.click(within(nameSection(box)).getByRole('button', { name: ko.common.save }));

    expect(await screen.findByText(ko.me.displayNameFailed)).toBeInTheDocument();
    // The only copy of what somebody just wrote is not thrown away to tell them it failed.
    expect(box).toHaveValue('김민지');
  });

  it('leaves the chain nickname alone', async () => {
    wrap(<Profile />);
    const box = await nameBox();
    await userEvent.clear(box);
    await userEvent.type(box, '김민지');
    await userEvent.click(within(nameSection(box)).getByRole('button', { name: ko.common.save }));
    await waitFor(() => expect(saveUserProfile).toHaveBeenCalledWith({ displayName: '김민지' }));

    // 별명 costs a sponsored write and is unique across everybody; this costs neither.
    expect(identityOp).not.toHaveBeenCalled();
    expect(nicknameOwner).not.toHaveBeenCalled();
    expect(screen.getByLabelText(ko.me.nickname)).toHaveValue('');
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
   * The profile is the way into `/org` — 탐색's floating 만들기 is the other way in, but it only
   * ever opens the creation scene. So the profile is the one place that reads `useOrganizerEntry`
   * to decide who is an organiser, and this file drives it through the real indexer rows rather
   * than through a stubbed hook.
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
    // The creation scene, not a screen about organisations: it asks for the organiser name
    // inline and makes the organisation inside 만들기 (plan section B-4).
    expect(navigate).toHaveBeenCalledWith('/org/new');
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
