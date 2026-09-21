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

  it('reads checkInOf as a struct against the ticket address', async () => {
    readContract.mockResolvedValueOnce({ gateId: 1n, ts: 1_790_000_000n, nonceHash: `0x${'00'.repeat(32)}`, manual: false });
    await expect(readTicket().checkInOf(9n)).resolves.toMatchObject({ gateId: 1n, manual: false });
    expect(readContract).toHaveBeenLastCalledWith(
      expect.objectContaining({ address: `0x${'33'.repeat(20)}`, abi: ticketAbi, functionName: 'checkInOf' }),
    );
  });

  // Ticket.sol's enum, in its solidity order. A screen comparing a bare 2 would not say so.
  it('names EventStatus the way the contract orders it', () => {
    expect(EventStatus).toEqual({ Draft: 0, Published: 1, Cancelled: 2, Ended: 3 });
  });

  // The other half of the manifest guard: nothing is exposed here that USED_ABI does not
  // declare, so abis.test.ts really does check every read this app can make.
  it('exposes only reads the usage manifest declares', () => {
    expect(Object.keys(readIdentity()).sort()).toEqual(Object.keys(USED_ABI.Identity).sort());
    expect(Object.keys(readOrganizers()).sort()).toEqual(Object.keys(USED_ABI.Organizers).sort());
    // The manifest types the writes too (`ops.ts` reads it), and a write never shows up here.
    const writes = ['checkIn', 'claim', 'safeTransferFrom', 'createOffer', 'cancelOffer', 'acceptOffer'];
    const ticketReads = Object.keys(USED_ABI.Ticket).filter((name) => !writes.includes(name));
    expect(Object.keys(readTicket()).sort()).toEqual(ticketReads.sort());
  });
});
