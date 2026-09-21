import { describe, expect, it, vi } from 'vitest';

const identity = { isMember: vi.fn(), isLocked: vi.fn(), kycLevelOf: vi.fn() };
const ticket = {
  eventMeta: vi.fn(), balanceOfEvent: vi.fn(), transfersOf: vi.fn(),
  checkInOf: vi.fn(), isRevoked: vi.fn(), eventStatus: vi.fn(),
};
// Partial mock: the two factories are stubs, but `EventStatus` stays the real module's, so a
// renamed or renumbered ordinal breaks here instead of passing quietly.
vi.mock('../../shared/chain/reads', async (orig) => ({
  ...(await orig<typeof import('../../shared/chain/reads')>()),
  readIdentity: () => identity,
  readTicket: () => ticket,
}));

const { runPrecheck, precheckMessage } = await import('./precheck');

const ME = `0x${'aa'.repeat(20)}` as const;
const YOU = `0x${'bb'.repeat(20)}` as const;
const meta = {
  transferable: true, transferCutoffSeconds: 3600, maxTransfers: 3,
  startsAt: 1_790_003_600n, orgId: 9n, requireKyc: false,
};
/** Published. Cancelled is 2 and Ended 3; both close the handover. */
const PUBLISHED = 1;

function setup(overrides: Partial<Record<string, unknown>> = {}) {
  identity.isMember.mockResolvedValue(true);
  identity.isLocked.mockResolvedValue(false);
  identity.kycLevelOf.mockResolvedValue(1);
  ticket.eventMeta.mockResolvedValue({ ...meta, ...overrides });
  ticket.balanceOfEvent.mockResolvedValue(0n);
  ticket.transfersOf.mockResolvedValue(0);
  ticket.checkInOf.mockResolvedValue({ gateId: 0n, ts: 0n, nonceHash: `0x${'00'.repeat(32)}`, manual: false });
  ticket.isRevoked.mockResolvedValue(false);
  ticket.eventStatus.mockResolvedValue(PUBLISHED);
}

// startsAt - transferCutoffSeconds = 1_790_003_600 - 3600 = 1_790_000_000.
// A transfer is allowed only while now < that instant; the instant itself is already closed.
const BEFORE_CUTOFF = 1_789_999_999;
const AT_CUTOFF = 1_790_000_000;

describe('runPrecheck', () => {
  it('passes a clean member transfer before the cutoff', async () => {
    setup();
    await expect(runPrecheck({ tokenId: 1n, eventId: 5n, from: ME, to: YOU, now: BEFORE_CUTOFF, maxPerWallet: 2 }))
      .resolves.toBeNull();
  });

  it('blocks exactly at the cutoff instant', async () => {
    setup();
    await expect(runPrecheck({ tokenId: 1n, eventId: 5n, from: ME, to: YOU, now: AT_CUTOFF, maxPerWallet: 2 }))
      .resolves.toBe('afterCutoff');
  });

  it('flags every blocking rule from spec 5.4', async () => {
    setup();
    identity.isMember.mockResolvedValueOnce(false);
    await expect(runPrecheck({ tokenId: 1n, eventId: 5n, from: ME, to: YOU, now: BEFORE_CUTOFF, maxPerWallet: 2 }))
      .resolves.toBe('notMember');

    setup(); identity.isLocked.mockResolvedValue(true);
    await expect(runPrecheck({ tokenId: 1n, eventId: 5n, from: ME, to: YOU, now: BEFORE_CUTOFF, maxPerWallet: 2 }))
      .resolves.toBe('locked');

    setup(); ticket.checkInOf.mockResolvedValue({ gateId: 1n, ts: 5n, nonceHash: `0x${'00'.repeat(32)}`, manual: false });
    await expect(runPrecheck({ tokenId: 1n, eventId: 5n, from: ME, to: YOU, now: BEFORE_CUTOFF, maxPerWallet: 2 }))
      .resolves.toBe('alreadyEntered');

    setup({ transferable: false });
    await expect(runPrecheck({ tokenId: 1n, eventId: 5n, from: ME, to: YOU, now: BEFORE_CUTOFF, maxPerWallet: 2 }))
      .resolves.toBe('notTransferable');

    setup(); ticket.transfersOf.mockResolvedValue(3);
    await expect(runPrecheck({ tokenId: 1n, eventId: 5n, from: ME, to: YOU, now: BEFORE_CUTOFF, maxPerWallet: 2 }))
      .resolves.toBe('noTransfersLeft');

    setup(); ticket.balanceOfEvent.mockResolvedValue(2n);
    await expect(runPrecheck({ tokenId: 1n, eventId: 5n, from: ME, to: YOU, now: BEFORE_CUTOFF, maxPerWallet: 2 }))
      .resolves.toBe('maxPerWallet');

    setup();
    await expect(runPrecheck({ tokenId: 1n, eventId: 5n, from: ME, to: ME, now: BEFORE_CUTOFF, maxPerWallet: 2 }))
      .resolves.toBe('self');
  });

  // Ticket._update reverts with TicketRevoked; the ticket list already hides a voided ticket,
  // but the precheck is the mirror of the contract, not of the list.
  it('blocks a voided ticket the way _update does', async () => {
    setup(); ticket.isRevoked.mockResolvedValue(true);
    await expect(runPrecheck({ tokenId: 1n, eventId: 5n, from: ME, to: YOU, now: BEFORE_CUTOFF, maxPerWallet: 2 }))
      .resolves.toBe('revoked');
  });

  // Not a contract rule — _update never reads eventStatus — but handing over a seat at an
  // event that was called off or is already over only moves a dead ticket.
  it('blocks a cancelled and an ended event', async () => {
    setup(); ticket.eventStatus.mockResolvedValue(2);
    await expect(runPrecheck({ tokenId: 1n, eventId: 5n, from: ME, to: YOU, now: BEFORE_CUTOFF, maxPerWallet: 2 }))
      .resolves.toBe('eventCancelled');

    setup(); ticket.eventStatus.mockResolvedValue(3);
    await expect(runPrecheck({ tokenId: 1n, eventId: 5n, from: ME, to: YOU, now: BEFORE_CUTOFF, maxPerWallet: 2 }))
      .resolves.toBe('eventCancelled');
  });

  // The contract compares `>=` with no zero guard, so a tier nobody may hold blocks everybody.
  it('mirrors maxPerWallet at zero instead of treating it as no limit', async () => {
    setup();
    await expect(runPrecheck({ tokenId: 1n, eventId: 5n, from: ME, to: YOU, now: BEFORE_CUTOFF, maxPerWallet: 0 }))
      .resolves.toBe('maxPerWallet');
  });

  // Ticket._update refuses in one fixed order (contracts/src/Ticket.sol): revoked →
  // transferable → checked in → cutoff → member → kyc → transfer limit → maxPerWallet.
  // When two rules fail at once the person must read the one the chain would have named.
  it('answers with the rule the chain would revert on when two fail at once', async () => {
    // A voided ticket sent to someone who never signed up: TicketRevoked comes first.
    setup();
    ticket.isRevoked.mockResolvedValue(true);
    identity.isMember.mockResolvedValue(false);
    await expect(runPrecheck({ tokenId: 1n, eventId: 5n, from: ME, to: YOU, now: BEFORE_CUTOFF, maxPerWallet: 2 }))
      .resolves.toBe('revoked');

    // Past the deadline and out of handovers: TransferCutoffPassed comes before TransferLimitReached.
    setup();
    ticket.transfersOf.mockResolvedValue(3);
    await expect(runPrecheck({ tokenId: 1n, eventId: 5n, from: ME, to: YOU, now: AT_CUTOFF, maxPerWallet: 2 }))
      .resolves.toBe('afterCutoff');

    // Not a member, and unverified on an event that demands it: NotMember comes before KycRequired.
    setup({ requireKyc: true });
    identity.isMember.mockResolvedValue(false);
    identity.kycLevelOf.mockResolvedValue(0);
    await expect(runPrecheck({ tokenId: 1n, eventId: 5n, from: ME, to: YOU, now: BEFORE_CUTOFF, maxPerWallet: 2 }))
      .resolves.toBe('notMember');

    // An event that is over and a ticket already used: eventCancelled is ours and outranks the mirror.
    setup();
    ticket.eventStatus.mockResolvedValue(3);
    ticket.checkInOf.mockResolvedValue({ gateId: 1n, ts: 5n, nonceHash: `0x${'00'.repeat(32)}`, manual: false });
    await expect(runPrecheck({ tokenId: 1n, eventId: 5n, from: ME, to: YOU, now: BEFORE_CUTOFF, maxPerWallet: 2 }))
      .resolves.toBe('eventCancelled');
  });

  // Nine sequential awaits on a phone is nine round trips before the sentence appears. Issued
  // together they coalesce into one multicall (client.ts sets batch.multicall), and the rule
  // order above stops depending on which read resolves first.
  it('issues every read up front instead of walking them one at a time', async () => {
    vi.clearAllMocks();
    setup();
    ticket.isRevoked.mockResolvedValue(true);
    await expect(runPrecheck({ tokenId: 1n, eventId: 5n, from: ME, to: YOU, now: BEFORE_CUTOFF, maxPerWallet: 2 }))
      .resolves.toBe('revoked');
    // The reads behind the rules `revoked` short-circuits were already in flight.
    for (const read of [identity.isMember, identity.isLocked, identity.kycLevelOf, ticket.isRevoked,
      ticket.checkInOf, ticket.eventStatus, ticket.eventMeta, ticket.transfersOf, ticket.balanceOfEvent]) {
      expect(read).toHaveBeenCalledTimes(1);
    }
  });

  // No read leaves at all when the recipient is the sender: it is settled from the arguments.
  it('refuses a handover to yourself without reading anything', async () => {
    vi.clearAllMocks();
    setup();
    await expect(runPrecheck({ tokenId: 1n, eventId: 5n, from: ME, to: ME, now: BEFORE_CUTOFF, maxPerWallet: 2 }))
      .resolves.toBe('self');
    expect(identity.isMember).not.toHaveBeenCalled();
    expect(ticket.eventMeta).not.toHaveBeenCalled();
  });

  it('maps every failure to attendee copy', () => {
    const copy = { transfer: {
      alertSelf: 'self', alertNotMember: 'notMember', alertLocked: 'locked',
      alertAlreadyEntered: 'entered', alertNotTransferable: 'noTransfer',
      alertAfterCutoff: 'cutoff', alertNoTransfersLeft: 'noneLeft', alertMaxPerWallet: 'maxed',
      alertRevoked: 'revoked', alertEventCancelled: 'eventCancelled',
    }, kyc: { recipientNotVerified: 'notVerified' } } as unknown as Parameters<typeof precheckMessage>[0];
    for (const failure of ['self', 'notMember', 'locked', 'alreadyEntered', 'notTransferable',
      'afterCutoff', 'noTransfersLeft', 'maxPerWallet', 'recipientNotVerified',
      'revoked', 'eventCancelled'] as const) {
      expect(precheckMessage(copy, failure)).toBeTruthy();
    }
  });

  it('blocks an unverified recipient on a KYC event', async () => {
    setup({ requireKyc: true });
    identity.kycLevelOf.mockResolvedValue(0);
    await expect(runPrecheck({ tokenId: 1n, eventId: 5n, from: ME, to: YOU, now: BEFORE_CUTOFF, maxPerWallet: 2 }))
      .resolves.toBe('recipientNotVerified');

    setup({ requireKyc: false });
    identity.kycLevelOf.mockResolvedValue(0);
    await expect(runPrecheck({ tokenId: 1n, eventId: 5n, from: ME, to: YOU, now: BEFORE_CUTOFF, maxPerWallet: 2 }))
      .resolves.toBeNull();
  });
});
