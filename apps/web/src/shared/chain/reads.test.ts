import { describe, expect, it, vi } from 'vitest';

const readContract = vi.fn();
vi.mock('./client', () => ({ getPublicClient: () => ({ readContract }) }));
vi.mock('../config', () => ({
  getConfig: () => ({
    addresses: { identity: `0x${'11'.repeat(20)}`, organizers: `0x${'22'.repeat(20)}`, ticket: `0x${'33'.repeat(20)}` },
  }),
}));

const { EventStatus, readIdentity, readOrganizers, readTicket } = await import('./reads');
const { USED_ABI, identityAbi, organizersAbi, ticketAbi } = await import('./abis');

const ACCOUNT = `0x${'aa'.repeat(20)}` as const;
const PERSON_ID = `0x${'cc'.repeat(32)}` as const;

describe('reads', () => {
  it('reads isMember against the identity address with the generated ABI', async () => {
    readContract.mockResolvedValueOnce(true);
    await expect(readIdentity().isMember(ACCOUNT)).resolves.toBe(true);
    expect(readContract).toHaveBeenCalledWith({
      address: `0x${'11'.repeat(20)}`, abi: identityAbi, functionName: 'isMember', args: [ACCOUNT],
    });
  });

  it('maps the gateInfo tuple to a named object', async () => {
    readContract.mockResolvedValueOnce([7n, `0x${'bb'.repeat(20)}`, `0x${'01'.repeat(32)}`, `0x${'02'.repeat(32)}`, true, false]);
    await expect(readOrganizers().gateInfo(3n)).resolves.toEqual({
      eventId: 7n, account: `0x${'bb'.repeat(20)}`, kx: `0x${'01'.repeat(32)}`, ky: `0x${'02'.repeat(32)}`,
      open: true, revoked: false,
    });
    expect(readContract).toHaveBeenLastCalledWith(
      expect.objectContaining({ address: `0x${'22'.repeat(20)}`, abi: organizersAbi, functionName: 'gateInfo' }),
    );
  });

  it('passes every organizer argument through in order', async () => {
    readContract.mockResolvedValue(true);
    await readOrganizers().hasPermission(4n, ACCOUNT, 2);
    expect(readContract).toHaveBeenLastCalledWith(expect.objectContaining({ functionName: 'hasPermission', args: [4n, ACCOUNT, 2] }));
    await readOrganizers().isOpenGate(5n, ACCOUNT);
    expect(readContract).toHaveBeenLastCalledWith(expect.objectContaining({ functionName: 'isOpenGate', args: [5n, ACCOUNT] }));
  });

  // 01b's order is (gateId, nonceHash, ts, manual, late) — abi-delta-01b.md §5. viem fills the
  // object out of the ABI, so this fixture is written the way the deployed ABI names it.
  it('reads checkInOf as a struct against the ticket address', async () => {
    readContract.mockResolvedValueOnce({
      gateId: 1n, nonceHash: `0x${'00'.repeat(32)}`, ts: 1_790_000_000n, manual: false, late: false,
    });
    await expect(readTicket().checkInOf(9n)).resolves.toEqual({
      gateId: 1n, nonceHash: `0x${'00'.repeat(32)}`, ts: 1_790_000_000n, manual: false, late: false,
    });
    expect(readContract).toHaveBeenLastCalledWith(
      expect.objectContaining({ address: `0x${'33'.repeat(20)}`, abi: ticketAbi, functionName: 'checkInOf' }),
    );
  });

  // The recovery-undo views. They take a personId (bytes32), not an account — passing an
  // address here would read the zero slot and the undo button would never appear.
  it('reads the rotation views against the identity address by personId', async () => {
    readContract.mockResolvedValueOnce(1_790_000_000n);
    await expect(readIdentity().rotatedAt(PERSON_ID)).resolves.toBe(1_790_000_000n);
    expect(readContract).toHaveBeenLastCalledWith({
      address: `0x${'11'.repeat(20)}`, abi: identityAbi, functionName: 'rotatedAt', args: [PERSON_ID],
    });

    readContract.mockResolvedValueOnce(ACCOUNT);
    await expect(readIdentity().rotatedFrom(PERSON_ID)).resolves.toBe(ACCOUNT);
    expect(readContract).toHaveBeenLastCalledWith({
      address: `0x${'11'.repeat(20)}`, abi: identityAbi, functionName: 'rotatedFrom', args: [PERSON_ID],
    });
  });

  it('reads ROTATION_UNDO_WINDOW with no arguments', async () => {
    readContract.mockResolvedValueOnce(86_400n);
    await expect(readIdentity().rotationUndoWindow()).resolves.toBe(86_400n);
    expect(readContract).toHaveBeenLastCalledWith({
      address: `0x${'11'.repeat(20)}`, abi: identityAbi, functionName: 'ROTATION_UNDO_WINDOW', args: [],
    });
  });

  it('reads MIGRATE_DELAY with no arguments', async () => {
    readContract.mockResolvedValueOnce(86_400n);
    await expect(readTicket().migrateDelay()).resolves.toBe(86_400n);
    expect(readContract).toHaveBeenLastCalledWith({
      address: `0x${'33'.repeat(20)}`, abi: ticketAbi, functionName: 'MIGRATE_DELAY', args: [],
    });
  });

  // The five caller-chosen inputs go out in this order and no other; the chain fills in
  // `block.chainid` and the Ticket address itself. deviceDigest.parity.test.ts is the half of
  // this that talks to the deployed contract.
  it('passes deviceDigest its five arguments in the ABI order', async () => {
    const nonce = `0x${'11'.repeat(32)}` as const;
    readContract.mockResolvedValueOnce(`0x${'ec'.repeat(32)}`);
    await expect(readTicket().deviceDigest(7n, 3n, 11n, nonce, 1_789_862_400n)).resolves.toBe(
      `0x${'ec'.repeat(32)}`,
    );
    expect(readContract).toHaveBeenLastCalledWith({
      address: `0x${'33'.repeat(20)}`, abi: ticketAbi, functionName: 'deviceDigest',
      args: [7n, 3n, 11n, nonce, 1_789_862_400n],
    });
  });

  // Ticket.sol's enum, in its solidity order. A screen comparing a bare 2 would not say so.
  it('names EventStatus the way the contract orders it', () => {
    expect(EventStatus).toEqual({ Draft: 0, Published: 1, Cancelled: 2, Ended: 3 });
  });

  // The other half of the manifest guard: nothing is exposed here that USED_ABI does not
  // declare, so abis.test.ts really does check every read this app can make.
  it('exposes only reads the usage manifest declares', () => {
    // The manifest types the writes too (`ops.ts` reads it), and a write never shows up here.
    const writes = [
      'setNickname',
      // 01b: the recovery undo and the ticket hand-over. Both go out through ops.ts
      // (`identityOp` / `ticketOp`), so neither belongs on a read helper.
      'cancelRotation', 'migrate',
      // The gate's two writes and manual approval (04). `checkInLate` is the offline queue's
      // flush target and takes `checkIn`'s three arguments; both go out through `checkInOp`.
      'checkIn', 'checkInLate', 'requestOverride', 'manualOverride',
      'claim', 'safeTransferFrom', 'createOffer', 'cancelOffer', 'acceptOffer',
      // 01c approval mode. The attendee's request/cancel go out through `ticketOp`.
      'requestClaim', 'cancelRequest',
      'createEvent', 'publishEvent', 'cancelEvent', 'updateEventMeta',
      'setAdmin', 'setManager', 'registerGate', 'openGate', 'closeGate', 'revokeGate',
    ];
    // Two reads are exposed under a camelCase helper name because the ABI spells them as
    // SCREAMING_CASE constant getters. The manifest keeps the ABI's spelling, so the mapping
    // lives here rather than making `USED_ABI` lie about what the contract is called.
    const helperName: Readonly<Record<string, string>> = {
      ROTATION_UNDO_WINDOW: 'rotationUndoWindow',
      MIGRATE_DELAY: 'migrateDelay',
    };
    const readsOf = (contract: Record<string, number>) =>
      Object.keys(contract)
        .filter((name) => !writes.includes(name))
        .map((name) => helperName[name] ?? name)
        .sort();
    expect(Object.keys(readIdentity()).sort()).toEqual(readsOf(USED_ABI.Identity));
    expect(Object.keys(readOrganizers()).sort()).toEqual(readsOf(USED_ABI.Organizers));
    expect(Object.keys(readTicket()).sort()).toEqual(readsOf(USED_ABI.Ticket));
  });
});
