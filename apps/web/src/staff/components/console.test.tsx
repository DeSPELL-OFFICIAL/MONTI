import { act } from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { fmt, setLocale } from '../../shared/i18n';
import { staffEn, staffKo } from '../copy';
import { TAP_REFUSAL, type SettledTap } from '../gate/machine';
import { DRY_RUN_MARK, LATE_WINDOW_ELAPSED } from '../queue/opQueue';
import { DENY_CODES, GATE_STATES, type GateContext, type GateState, type SnapshotTicket } from '../types';
import { GateConsole, type GateConsoleProps } from '../Console';
import {
  AdmitCard,
  ConfirmingCard,
  DenyCard,
  LastTapChip,
  OfflineAdmitCard,
  OfflineBadge,
  OverrideDialog,
  QueueBanner,
  ReceivedCard,
  RefusedToast,
  StaffShell,
  TapPrompt,
} from './index';

const GATE_NAME = '1번 문';
const EVENT_TITLE = '여름 공연';
const STAFF_NAME = '김민지';
const ATTENDEE = '박서준';

function ticket(overrides: Partial<SnapshotTicket> = {}): SnapshotTicket {
  return {
    tokenId: '1042',
    account: '0x1111111111111111111111111111111111111111',
    deviceX: '0x22',
    deviceY: '0x33',
    photoJpegB64: '',
    displayName: ATTENDEE,
    tier: 0,
    tierName: 'VIP',
    seat: 'A12',
    checkedIn: false,
    ...overrides,
  };
}

function context(overrides: Partial<GateContext> = {}): GateContext {
  return {
    state: 'ready',
    gateId: 7n,
    eventId: 1n,
    orgId: 2n,
    finalized: false,
    checking: false,
    retapHint: false,
    pendingCount: 0,
    snapshotAgeMs: 0,
    online: true,
    ...overrides,
  };
}

function renderShell(overrides: Partial<Parameters<typeof StaffShell>[0]> = {}) {
  return render(
    <StaffShell
      gateName={GATE_NAME}
      eventTitle={EVENT_TITLE}
      staffName={STAFF_NAME}
      blockNumber={1234n}
      finalized={false}
      online
      snapshotAgeMs={0}
      entriesCount={3}
      {...overrides}
    >
      <p>본문</p>
    </StaffShell>,
  );
}

function renderConsole(ctx: Partial<GateContext> = {}, props: Partial<GateConsoleProps> = {}) {
  return render(
    <GateConsole
      gateName={GATE_NAME}
      eventTitle={EVENT_TITLE}
      context={context(ctx)}
      entriesCount={12}
      {...props}
    />,
  );
}

/** The one aria-live region every verdict lands in. Scopes a query away from the header. */
function verdict(): HTMLElement {
  const region = document.querySelector('.gate__verdict');
  if (!(region instanceof HTMLElement)) throw new Error('verdict region missing');
  return region;
}

describe('StaffShell', () => {
  it('names the gate, the event and the staff member holding it', () => {
    renderShell();
    expect(screen.getByRole('heading', { level: 1, name: GATE_NAME })).toBeInTheDocument();
    expect(screen.getByText(EVENT_TITLE)).toBeInTheDocument();
    expect(screen.getByText(`${staffKo.shell.staffLabel} ${STAFF_NAME}`)).toBeInTheDocument();
  });

  it('omits the staff line when nobody is named', () => {
    renderShell({ staffName: undefined });
    expect(screen.queryByText(new RegExp(staffKo.shell.staffLabel))).not.toBeInTheDocument();
  });

  it('shows the block number only when there is one', () => {
    renderShell();
    expect(screen.getByText(`${staffKo.shell.blockLabel} 1234`)).toBeInTheDocument();
    cleanup();
    renderShell({ blockNumber: undefined });
    expect(screen.queryByText(new RegExp(staffKo.shell.blockLabel))).not.toBeInTheDocument();
  });

  it('says offline ahead of anything the list claims', () => {
    renderShell({ online: false, finalized: true });
    expect(screen.getByText(staffKo.shell.stageOffline)).toBeInTheDocument();
    expect(screen.queryByText(staffKo.shell.stageSettled)).not.toBeInTheDocument();
  });

  it('separates a settled entry from one still being recorded', () => {
    renderShell({ finalized: true });
    expect(screen.getByText(staffKo.shell.stageSettled)).toBeInTheDocument();
    cleanup();
    renderShell({ finalized: false });
    expect(screen.getByText(staffKo.shell.stageRecording)).toBeInTheDocument();
  });

  it('reads the list age as fresh under a minute and in minutes after that', () => {
    renderShell({ snapshotAgeMs: 59_999 });
    expect(screen.getByText(staffKo.shell.snapshotFresh)).toBeInTheDocument();
    cleanup();
    renderShell({ snapshotAgeMs: 3 * 60_000 + 1000 });
    expect(screen.getByText(fmt(staffKo.shell.snapshotAge, { minutes: 3 }))).toBeInTheDocument();
  });

  it('counts the people already through this door', () => {
    renderShell({ entriesCount: 3 });
    expect(screen.getByText(fmt(staffKo.shell.entriesCount, { count: 3 }))).toBeInTheDocument();
  });

  it('puts its children in a polite, atomic live region', () => {
    renderShell();
    const region = screen.getByText('본문').closest('section');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveAttribute('aria-atomic', 'true');
  });

  it('renders the banner and footer slots around the live region', () => {
    renderShell({ banner: <p>배너</p>, footer: <p>바닥</p> });
    expect(screen.getByText('배너')).toBeInTheDocument();
    expect(screen.getByText('바닥')).toBeInTheDocument();
  });
});

describe('TapPrompt', () => {
  it.each([true, false])('asks for the next tap while rotating=%s', (rotating) => {
    render(<TapPrompt rotating={rotating} />);
    expect(screen.getByText(staffKo.ready.tap)).toBeInTheDocument();
    expect(screen.getByText(staffKo.ready.hint)).toBeInTheDocument();
  });
});

describe('ReceivedCard', () => {
  it.each([
    ['ok', staffKo.received.precheckOk],
    ['unknown', staffKo.received.precheckUnknown],
    ['fail', staffKo.received.precheckFail],
  ] as const)('reads the list result %s', (precheck, sentence) => {
    render(<ReceivedCard tokenIdMasked="••42" precheck={precheck} />);
    expect(screen.getByText(staffKo.received.title)).toBeInTheDocument();
    expect(screen.getByText(sentence)).toBeInTheDocument();
  });

  it('shows the masked ticket number it was handed', () => {
    render(<ReceivedCard tokenIdMasked="••42" precheck="ok" />);
    expect(screen.getByText(staffKo.received.ticketLabel)).toBeInTheDocument();
    expect(screen.getByText('••42')).toBeInTheDocument();
  });
});

describe('ConfirmingCard', () => {
  it('says only that it is confirming before the five-second mark', () => {
    render(<ConfirmingCard checking waitHint={false} />);
    expect(screen.getByText(staffKo.confirming.title)).toBeInTheDocument();
    expect(screen.queryByText(staffKo.confirming.wait)).not.toBeInTheDocument();
  });

  it('adds the wait line at the five-second mark', () => {
    render(<ConfirmingCard checking waitHint />);
    expect(screen.getByText(staffKo.confirming.title)).toBeInTheDocument();
    expect(screen.getByText(staffKo.confirming.wait)).toBeInTheDocument();
  });

  it('never tells the attendee to tap again', () => {
    render(<ConfirmingCard checking waitHint />);
    expect(document.body.textContent).not.toContain('다시 대세요');
  });
});

describe('AdmitCard', () => {
  it('shows the attendee photo when the event carries one', () => {
    render(<AdmitCard displayName={ATTENDEE} photoJpegB64="QUJD" finalized={false} />);
    const photo = screen.getByRole('img', { name: fmt(staffKo.admit.photoAlt, { name: ATTENDEE }) });
    expect(photo).toHaveAttribute('src', 'data:image/jpeg;base64,QUJD');
  });

  it('draws an initial instead when there is no photo', () => {
    render(<AdmitCard displayName={ATTENDEE} photoJpegB64="" finalized={false} />);
    const avatar = screen.getByRole('img', { name: fmt(staffKo.admit.avatarAlt, { name: ATTENDEE }) });
    expect(avatar).toHaveTextContent('박');
    expect(document.querySelector('img')).toBeNull();
  });

  it('names the attendee, the tier, the seat and the entry number', () => {
    render(
      <AdmitCard
        displayName={ATTENDEE}
        tierLabel="VIP"
        seat="A12"
        entryNumber={41}
        blockNumber={1234n}
        finalized={false}
      />,
    );
    expect(screen.getByText(staffKo.admit.title)).toBeInTheDocument();
    expect(screen.getByText(ATTENDEE)).toBeInTheDocument();
    expect(screen.getByText('VIP · A12')).toBeInTheDocument();
    expect(screen.getByText(staffKo.admit.entryLabel)).toBeInTheDocument();
    expect(screen.getByText(fmt(staffKo.admit.entryValue, { count: 41 }))).toBeInTheDocument();
    expect(screen.getByText(`${staffKo.admit.blockLabel} 1234`)).toBeInTheDocument();
  });

  it('distinguishes a settled entry from one still being recorded', () => {
    render(<AdmitCard displayName={ATTENDEE} finalized />);
    expect(screen.getByText(staffKo.admit.settled)).toBeInTheDocument();
    cleanup();
    render(<AdmitCard displayName={ATTENDEE} finalized={false} />);
    expect(screen.getByText(staffKo.admit.recording)).toBeInTheDocument();
  });

  it('warns only when the phone changed in the last day', () => {
    render(<AdmitCard displayName={ATTENDEE} finalized deviceChangedRecently />);
    expect(screen.getByText(staffKo.admit.deviceChanged)).toBeInTheDocument();
    cleanup();
    render(<AdmitCard displayName={ATTENDEE} finalized />);
    expect(screen.queryByText(staffKo.admit.deviceChanged)).not.toBeInTheDocument();
  });

  it('clears to the next attendee once', async () => {
    const onDone = vi.fn();
    const user = userEvent.setup();
    render(<AdmitCard displayName={ATTENDEE} finalized onDone={onDone} />);
    await user.click(screen.getByRole('button', { name: staffKo.done }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('offers no clear button when nothing can be cleared', () => {
    render(<AdmitCard displayName={ATTENDEE} finalized />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('OfflineAdmitCard', () => {
  it('cannot be read as an online admit', () => {
    render(<OfflineAdmitCard displayName={ATTENDEE} queuedCount={2} />);
    expect(screen.getByText(staffKo.offlineAdmit.title)).toBeInTheDocument();
    expect(screen.queryByText(staffKo.admit.title)).not.toBeInTheDocument();
    expect(screen.queryByText(staffKo.admit.settled)).not.toBeInTheDocument();
  });

  it('says how many entries are still waiting to be sent', () => {
    render(<OfflineAdmitCard displayName={ATTENDEE} queuedCount={2} />);
    expect(screen.getByText(staffKo.offlineAdmit.note)).toBeInTheDocument();
    expect(screen.getByText(fmt(staffKo.offlineAdmit.queued, { count: 2 }))).toBeInTheDocument();
  });

  it('draws the same photo or initial the online card does', () => {
    render(<OfflineAdmitCard displayName={ATTENDEE} photoJpegB64="QUJD" queuedCount={0} />);
    expect(screen.getByRole('img', { name: fmt(staffKo.admit.photoAlt, { name: ATTENDEE }) })).toHaveAttribute(
      'src',
      'data:image/jpeg;base64,QUJD',
    );
  });

  it('clears to the next attendee', async () => {
    const onDone = vi.fn();
    const user = userEvent.setup();
    render(<OfflineAdmitCard displayName={ATTENDEE} queuedCount={1} onDone={onDone} />);
    await user.click(screen.getByRole('button', { name: staffKo.done }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});

describe('DenyCard', () => {
  it('interrupts the screen reader and names the refusal', () => {
    render(<DenyCard code="ALREADY_USED" />);
    const alert = screen.getByRole('alert');
    expect(within(alert).getByText(staffKo.denyTitle)).toBeInTheDocument();
    expect(within(alert).getByText(staffKo.deny.ALREADY_USED)).toBeInTheDocument();
  });

  it('reads a second code as its own sentence', () => {
    render(<DenyCard code="GATE_MISMATCH" />);
    expect(screen.getByText(staffKo.deny.GATE_MISMATCH)).toBeInTheDocument();
  });

  it('adds the detail line only when the caller has one', () => {
    render(<DenyCard code="TX_FAILED" detail="0xdeadbeef" />);
    expect(screen.getByText('0xdeadbeef')).toBeInTheDocument();
    cleanup();
    render(<DenyCard code="TX_FAILED" />);
    expect(screen.queryByText('0xdeadbeef')).not.toBeInTheDocument();
  });

  it('clears to the next attendee', async () => {
    const onDone = vi.fn();
    const user = userEvent.setup();
    render(<DenyCard code="NO_TICKET" onDone={onDone} />);
    await user.click(screen.getByRole('button', { name: staffKo.done }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it.each([...DENY_CODES])('has a sentence for %s', (code) => {
    render(<DenyCard code={code} />);
    expect(staffKo.deny[code].length).toBeGreaterThan(0);
    expect(screen.getByText(staffKo.deny[code])).toBeInTheDocument();
  });

  it('carries every §13 code in both locales, and says something different in each', () => {
    const sorted = [...DENY_CODES].sort();
    expect(Object.keys(staffKo.deny).sort()).toEqual(sorted);
    expect(Object.keys(staffEn.deny).sort()).toEqual(sorted);
    for (const code of DENY_CODES) {
      expect(staffEn.deny[code].length).toBeGreaterThan(0);
      expect(staffEn.deny[code]).not.toBe(staffKo.deny[code]);
    }
  });
});

describe('RefusedToast', () => {
  it.each([
    [TAP_REFUSAL.confirming, staffKo.refusal.confirming],
    [TAP_REFUSAL.showingVerdict, staffKo.refusal.showingVerdict],
  ] as const)('explains the gate refusal %s', (refusal, sentence) => {
    render(<RefusedToast refusal={refusal} />);
    expect(within(screen.getByRole('status')).getByText(sentence)).toBeInTheDocument();
  });

  it('is never an alert — the gate is busy, the attendee is not refused', () => {
    render(<RefusedToast refusal={TAP_REFUSAL.confirming} />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText(staffKo.denyTitle)).not.toBeInTheDocument();
  });
});

describe('LastTapChip', () => {
  const settled = (overrides: Partial<SettledTap> = {}): SettledTap => ({
    tap: { tokenId: 1042n, nonce: '0xab' },
    state: 'admit',
    finalized: true,
    ...overrides,
  });

  it('says so when nothing has happened yet', () => {
    render(<LastTapChip />);
    expect(screen.getByText(staffKo.lastTap.none)).toBeInTheDocument();
  });

  it('keeps the previous admit and who it was', () => {
    render(<LastTapChip lastTap={settled({ ticket: ticket() })} />);
    expect(screen.getByText(staffKo.lastTap.label)).toBeInTheDocument();
    expect(screen.getByText(staffKo.lastTap.admit)).toBeInTheDocument();
    expect(screen.getByText(ATTENDEE)).toBeInTheDocument();
  });

  it('keeps the previous refusal and why', () => {
    render(<LastTapChip lastTap={settled({ state: 'deny', deny: 'ALREADY_USED', finalized: false })} />);
    expect(screen.getByText(staffKo.lastTap.deny)).toBeInTheDocument();
    expect(screen.getByText(staffKo.deny.ALREADY_USED)).toBeInTheDocument();
  });

  it('marks an offline admit as its own thing', () => {
    render(<LastTapChip lastTap={settled({ state: 'offlineAdmit', finalized: false })} />);
    expect(screen.getByText(staffKo.lastTap.offlineAdmit)).toBeInTheDocument();
  });
});

describe('OfflineBadge', () => {
  it('stays out of the way while the connection is up', () => {
    const { container } = render(<OfflineBadge online snapshotAgeMs={0} queuedCount={4} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('says what is lost and how stale the list is', () => {
    render(<OfflineBadge online={false} snapshotAgeMs={3 * 60_000} queuedCount={4} />);
    expect(screen.getByText(staffKo.shell.stageOffline)).toBeInTheDocument();
    expect(screen.getByText(fmt(staffKo.shell.snapshotAge, { minutes: 3 }))).toBeInTheDocument();
    expect(screen.getByText(fmt(staffKo.queue.pending, { count: 4 }))).toBeInTheDocument();
  });

  it('leaves the count out when there is nothing queued', () => {
    render(<OfflineBadge online={false} snapshotAgeMs={0} queuedCount={0} />);
    expect(screen.getByText(staffKo.shell.snapshotFresh)).toBeInTheDocument();
    expect(screen.queryByText(fmt(staffKo.queue.pending, { count: 0 }))).not.toBeInTheDocument();
  });
});

describe('QueueBanner', () => {
  it('shows nothing when the queue is empty and healthy', () => {
    const { container } = render(<QueueBanner pendingCount={0} parkedCount={0} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('counts what is waiting and what has stopped', () => {
    render(<QueueBanner pendingCount={3} parkedCount={2} />);
    expect(screen.getByText(fmt(staffKo.queue.pending, { count: 3 }))).toBeInTheDocument();
    expect(screen.getByText(fmt(staffKo.queue.parked, { count: 2 }))).toBeInTheDocument();
    expect(screen.getByText(staffKo.queue.sending)).toBeInTheDocument();
  });

  it('hands a passed deadline to the organizer instead of promising a retry', () => {
    render(<QueueBanner pendingCount={0} parkedCount={2} lastError={LATE_WINDOW_ELAPSED} />);
    expect(screen.getByText(staffKo.queue.lateWindowElapsed)).toBeInTheDocument();
    expect(screen.queryByText(staffKo.queue.sending)).not.toBeInTheDocument();
  });

  it('says a device that cannot send late entries cannot send them', () => {
    render(<QueueBanner pendingCount={2} parkedCount={0} lastError={DRY_RUN_MARK} />);
    expect(screen.getByText(staffKo.queue.lateUnavailable)).toBeInTheDocument();
  });

  it('stays quiet about a send failure that will simply be retried', () => {
    render(<QueueBanner pendingCount={1} parkedCount={0} lastError="HTTP 503" />);
    expect(screen.queryByText(staffKo.queue.lateWindowElapsed)).not.toBeInTheDocument();
    expect(screen.queryByText(staffKo.queue.lateUnavailable)).not.toBeInTheDocument();
    expect(screen.getByText(staffKo.queue.sending)).toBeInTheDocument();
  });
});

describe('OverrideDialog', () => {
  const noop = () => {};

  it('is a modal dialog with a name', () => {
    render(<OverrideDialog canApprove onSubmit={noop} onCancel={noop} />);
    const dialog = screen.getByRole('dialog', { name: staffKo.override.title });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
  });

  it('asks to approve when this staff member may, and to escalate when they may not', () => {
    render(<OverrideDialog canApprove onSubmit={noop} onCancel={noop} />);
    expect(screen.getByRole('button', { name: staffKo.override.approve })).toBeInTheDocument();
    cleanup();
    render(<OverrideDialog canApprove={false} onSubmit={noop} onCancel={noop} />);
    expect(screen.getByRole('button', { name: staffKo.override.request })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: staffKo.override.approve })).not.toBeInTheDocument();
  });

  it('lists the four §-approved reasons', () => {
    render(<OverrideDialog canApprove onSubmit={noop} onCancel={noop} />);
    const select = screen.getByLabelText(staffKo.override.reasonLabel);
    expect(within(select).getAllByRole('option')).toHaveLength(4);
    for (const label of [
      staffKo.override.reason1,
      staffKo.override.reason2,
      staffKo.override.reason3,
      staffKo.override.reason4,
    ]) {
      expect(within(select).getByRole('option', { name: label })).toBeInTheDocument();
    }
  });

  it('hands the PIN and the chosen reason back', async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<OverrideDialog canApprove={false} onSubmit={onSubmit} onCancel={noop} />);
    await user.type(screen.getByLabelText(staffKo.override.pin), '1234');
    await user.selectOptions(screen.getByLabelText(staffKo.override.reasonLabel), '2');
    await user.click(screen.getByRole('button', { name: staffKo.override.request }));
    expect(onSubmit).toHaveBeenCalledWith('1234', 2);
  });

  it('backs out without submitting', async () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    const user = userEvent.setup();
    render(<OverrideDialog canApprove onSubmit={onSubmit} onCancel={onCancel} />);
    await user.click(screen.getByRole('button', { name: staffKo.override.cancel }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('GateConsole', () => {
  const CASES: ReadonlyArray<readonly [GateState, string]> = [
    ['idle', staffKo.ready.tap],
    ['ready', staffKo.ready.tap],
    ['received', staffKo.received.title],
    ['confirming', staffKo.confirming.title],
    ['admit', staffKo.admit.title],
    ['offlineAdmit', staffKo.offlineAdmit.title],
    ['deny', staffKo.denyTitle],
    ['override', staffKo.override.title],
  ];

  it('has a card for every gate state', () => {
    expect(CASES.map(([state]) => state)).toEqual([...GATE_STATES]);
  });

  it.each(CASES)('renders the %s card inside the live region', (state, sentence) => {
    renderConsole({ state, ticket: ticket(), deny: state === 'deny' ? 'ALREADY_USED' : undefined });
    expect(within(verdict()).getAllByText(sentence).length).toBeGreaterThan(0);
  });

  it('masks the ticket down to its last two characters', () => {
    renderConsole({ state: 'received', ticket: ticket({ tokenId: '1042' }) });
    expect(screen.getByText('••42')).toBeInTheDocument();
  });

  it('reads the list result from what the snapshot already said', () => {
    renderConsole({ state: 'received', ticket: ticket() });
    expect(screen.getByText(staffKo.received.precheckOk)).toBeInTheDocument();
    cleanup();
    renderConsole({ state: 'received' });
    expect(screen.getByText(staffKo.received.precheckUnknown)).toBeInTheDocument();
    cleanup();
    renderConsole({ state: 'received', ticket: ticket(), deny: 'ALREADY_USED' });
    expect(screen.getByText(staffKo.received.precheckFail)).toBeInTheDocument();
  });

  it('passes the two §7.3 clocks through to the confirming card', () => {
    renderConsole({ state: 'confirming', checking: true, retapHint: false });
    expect(screen.queryByText(staffKo.confirming.wait)).not.toBeInTheDocument();
    cleanup();
    renderConsole({ state: 'confirming', checking: true, retapHint: true });
    expect(screen.getByText(staffKo.confirming.wait)).toBeInTheDocument();
  });

  it('falls back to an unreadable reason rather than an empty refusal', () => {
    renderConsole({ state: 'deny', denyDetail: '0xbeef' });
    expect(screen.getByText(staffKo.deny.UNKNOWN_REVERT)).toBeInTheDocument();
    expect(screen.getByText('0xbeef')).toBeInTheDocument();
  });

  // `offlineAdmit.queued` and `queue.pending` are the same sentence, and the banner is on screen
  // beside the card, so this one is scoped to the card rather than to the whole console.
  it('counts the queued entries on the offline card', () => {
    renderConsole({ state: 'offlineAdmit', ticket: ticket(), pendingCount: 3, online: false });
    expect(
      within(verdict()).getByText(fmt(staffKo.offlineAdmit.queued, { count: 3 })),
    ).toBeInTheDocument();
  });

  it('shows the refusal above the card without replacing it', () => {
    renderConsole({ state: 'confirming', checking: true }, { refusal: TAP_REFUSAL.confirming });
    expect(screen.getByRole('status')).toHaveTextContent(staffKo.refusal.confirming);
    expect(screen.getByText(staffKo.confirming.title)).toBeInTheDocument();
  });

  it('hides the refusal when the machine took the tap', () => {
    renderConsole({ state: 'confirming', checking: true });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('raises the offline badge beside the header line when the connection drops', () => {
    renderConsole({ online: false, snapshotAgeMs: 0 });
    expect(screen.getAllByText(staffKo.shell.stageOffline)).toHaveLength(2);
    cleanup();
    renderConsole({ online: true });
    expect(screen.queryByText(staffKo.shell.stageOffline)).not.toBeInTheDocument();
  });

  it('carries the queue trouble into the banner slot', () => {
    renderConsole({ pendingCount: 2 }, { parkedCount: 1, queueError: LATE_WINDOW_ELAPSED });
    expect(screen.getByText(staffKo.queue.lateWindowElapsed)).toBeInTheDocument();
    expect(screen.getByText(fmt(staffKo.queue.parked, { count: 1 }))).toBeInTheDocument();
  });

  it('keeps the previous tap in the footer', () => {
    renderConsole({}, { lastTap: { tap: { tokenId: 1n, nonce: '0xab' }, state: 'admit', ticket: ticket(), finalized: true } });
    expect(screen.getByText(staffKo.lastTap.label)).toBeInTheDocument();
    expect(screen.getByText(ATTENDEE)).toBeInTheDocument();
  });

  it('wires the clear button to the caller', async () => {
    const onDone = vi.fn();
    const user = userEvent.setup();
    renderConsole({ state: 'admit', ticket: ticket() }, { onDone });
    await user.click(screen.getByRole('button', { name: staffKo.done }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('wires the override dialog to the caller', async () => {
    const onOverrideSubmit = vi.fn();
    const onOverrideCancel = vi.fn();
    const user = userEvent.setup();
    renderConsole({ state: 'override' }, { canApprove: true, onOverrideSubmit, onOverrideCancel });
    await user.type(screen.getByLabelText(staffKo.override.pin), '99');
    await user.click(screen.getByRole('button', { name: staffKo.override.approve }));
    expect(onOverrideSubmit).toHaveBeenCalledWith('99', 1);
    await user.click(screen.getByRole('button', { name: staffKo.override.cancel }));
    expect(onOverrideCancel).toHaveBeenCalledTimes(1);
  });
});

describe('locale', () => {
  it('reaches the English table when the device is set to English', async () => {
    try {
      await act(async () => {
        await setLocale('en');
      });
      render(<DenyCard code="ALREADY_USED" />);
      expect(screen.getByText(staffEn.deny.ALREADY_USED)).toBeInTheDocument();
      expect(screen.getByText(staffEn.denyTitle)).toBeInTheDocument();
    } finally {
      cleanup();
      await act(async () => {
        await setLocale('ko');
      });
    }
  });
});
