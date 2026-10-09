import type { Abi, Hex } from 'viem';
import { getConfig } from '../config';
import { getPublicClient } from './client';
import { ABI_BY_CONTRACT, type UsedContract, type UsedFunction } from './abis';

/**
 * `Ticket.EventStatus` by its solidity ordinal (contracts/src/Ticket.sol:68-73). Named once
 * here so no screen compares an event against a bare number.
 */
export const EventStatus = { Draft: 0, Published: 1, Cancelled: 2, Ended: 3 } as const;
export type EventStatusValue = (typeof EventStatus)[keyof typeof EventStatus];

/**
 * `Ticket.checkInOf`. The 01b order: `nonceHash` sits **in front of** `ts` so that
 * `ts + manual + late` share one storage slot (`contracts/docs/abi-delta-01b.md` §5). Solidity
 * reads the struct by field name and never noticed; viem decodes positionally, so this
 * interface and `CHECK_IN_FIELDS` move together or not at all.
 */
export interface CheckInStruct {
  gateId: bigint;
  nonceHash: Hex;
  ts: bigint;
  manual: boolean;
  /** The tap was recorded through `checkInLate`, outside the code window. Still an entry. */
  late: boolean;
}

export interface EventMetaStruct {
  orgId: bigint;
  titleHash: Hex;
  descHash: Hex;
  imageCid: string;
  startsAt: bigint;
  endsAt: bigint;
  venueHash: Hex;
  saleStart: bigint;
  saleEnd: bigint;
  transferable: boolean;
  transferCutoffSeconds: number;
  maxTransfers: number;
  approvalRequired: boolean;
  category: number;
  regionCode: Hex;
  requireKyc: boolean;
}

/**
 * `Ticket.offerOf`. An absent offer is not an error: the mapping answers with the zero struct,
 * so `from`/`recipientCommitment` at zero is how a screen reads "nothing is pending here".
 */
export interface OfferStruct {
  from: Hex;
  recipientCommitment: Hex;
  expiresAt: bigint;
}

export interface TierStruct {
  name: string;
  priceUsdCents: bigint;
  supply: number;
  minted: number;
  maxPerWallet: number;
  seated: boolean;
}

/**
 * One `readContract` bound to a contract, so every call below is a single named line. The
 * function name is typed against `USED_ABI`, so a read this app has not declared does not
 * compile — and `abis.test.ts` checks every declared name against the generated JSON.
 */
function reader<C extends UsedContract>(contract: C, address: Hex) {
  // Widened to `Abi`: the manifest, not viem's literal inference, is what types the name.
  const abi: Abi = ABI_BY_CONTRACT[contract];
  return <T>(functionName: UsedFunction<C>, args: readonly unknown[]): Promise<T> =>
    getPublicClient().readContract({ address, abi, functionName, args }) as Promise<T>;
}

/** `Identity.activeDevice` answers with two separate `bytes32` outputs, not a struct. */
export interface DeviceKeyPoint {
  x: Hex;
  y: Hex;
}

export function readIdentity() {
  const call = reader('Identity', getConfig().addresses.identity);
  return {
    isMember: (account: Hex) => call<boolean>('isMember', [account]),
    isLocked: (account: Hex) => call<boolean>('isLocked', [account]),
    kycLevelOf: (account: Hex) => call<number>('kycLevelOf', [account]),
    /** Zero means nobody holds this name yet — how the profile blocks `NicknameTaken` early. */
    nicknameOwner: (nicknameHash: Hex) => call<Hex>('nicknameOwner', [nicknameHash]),
    /** `uint64` seconds. The device cooldown is counted from here, never from Firestore. */
    deviceUpdatedAt: (account: Hex) => call<bigint>('deviceUpdatedAt', [account]),
    /** The P-256 point `Ticket.checkIn` verifies the device signature against. */
    activeDevice: async (account: Hex): Promise<DeviceKeyPoint> => {
      const [x, y] = await call<[Hex, Hex]>('activeDevice', [account]);
      return { x, y };
    },
    /**
     * `uint64` seconds — when this person's account last moved. Note the argument is a
     * **personId** (`bytes32`), not an account address, unlike every read above.
     *
     * `register` stamps this too (`contracts/docs/abi-delta-01b.md` §1), so a non-zero
     * `rotatedAt` is *not* on its own "there is a rotation to undo" — every registered person
     * has one. {@link rotatedFrom} is the flag; this only bounds the window.
     */
    rotatedAt: (personId: Hex) => call<bigint>('rotatedAt', [personId]),
    /**
     * The account a rotation pushed aside, or the zero address once the window closed or the
     * undo already happened. **This is the flag.** Takes a **personId** (`bytes32`).
     *
     * For the account asking, "may I undo right now?" is the whole of:
     * `rotatedFrom(personId) === me && now < rotatedAt(personId) + ROTATION_UNDO_WINDOW`.
     */
    rotatedFrom: (personId: Hex) => call<Hex>('rotatedFrom', [personId]),
    /**
     * `86400` (1 day), and equal to `Ticket.MIGRATE_DELAY` by construction — a contracts test
     * asserts it. Read rather than interpolated, so no screen carries an hour count of its own.
     *
     * The undo itself, `Identity.cancelRotation()`, is a **write**, not a read: it takes no
     * argument (the contract reads the caller) and goes out through `identityOp` in `ops.ts`
     * like every other Identity write. It is sponsored, which is the point — the pushed-aside
     * account has no gas.
     */
    rotationUndoWindow: () => call<bigint>('ROTATION_UNDO_WINDOW', []),
  };
}

/** `Organizers.gateInfo` returns six values, not a struct, so viem hands back a positional
 * tuple. Naming them here is the only place that mapping should live. */
export interface GateInfoStruct {
  eventId: bigint;
  account: Hex;
  kx: Hex;
  ky: Hex;
  open: boolean;
  revoked: boolean;
}

/**
 * `Organizers.managerOf` returns two booleans rather than a struct, so viem hands back a
 * positional pair. `exists` is membership of the organizer's team and `canApprove` is the right
 * to admit somebody by hand — they are genuinely independent, and the gap between them is the
 * whole of `requestOverride`: a manager who exists without `canApprove` files a request that
 * somebody else approves (`Ticket.sol:377`).
 */
export interface ManagerStruct {
  exists: boolean;
  canApprove: boolean;
}

export function readOrganizers() {
  const call = reader('Organizers', getConfig().addresses.organizers);
  return {
    isOpenGate: (eventId: bigint, gateAccount: Hex) => call<boolean>('isOpenGate', [eventId, gateAccount]),
    managerOf: async (orgId: bigint, account: Hex): Promise<ManagerStruct> => {
      const [exists, canApprove] = await call<[boolean, boolean]>('managerOf', [orgId, account]);
      return { exists, canApprove };
    },
    hasPermission: (orgId: bigint, account: Hex, bit: number) =>
      call<boolean>('hasPermission', [orgId, account, bit]),
    gateOf: (gateAccount: Hex) => call<bigint>('gateOf', [gateAccount]),
    ownerOf: (orgId: bigint) => call<Hex>('ownerOf', [orgId]),
    /**
     * The bits an admin actually holds. Zero is "not an admin of this organisation" — this is
     * how the team screen sees an invite finish, because the invite document's own `done` flag
     * is written by the Tenderly webhook and the UI must not wait on it.
     */
    adminBitsOf: (orgId: bigint, admin: Hex) => call<number>('adminBitsOf', [orgId, admin]),
    gateInfo: async (gateId: bigint): Promise<GateInfoStruct> => {
      const [eventId, account, kx, ky, open, revoked] =
        await call<[bigint, Hex, Hex, Hex, boolean, boolean]>('gateInfo', [gateId]);
      return { eventId, account, kx, ky, open, revoked };
    },
  };
}

export function readTicket() {
  const call = reader('Ticket', getConfig().addresses.ticket);
  return {
    eventOf: (tokenId: bigint) => call<bigint>('eventOf', [tokenId]),
    /** The address holding this token now. `ownerOf` reverts for a token that was never minted,
     *  so a deep link to a non-existent id throws rather than naming a zero owner. */
    ownerOf: (tokenId: bigint) => call<Hex>('ownerOf', [tokenId]),
    /** The organisation an event belongs to. Zero means there is no such event — the same
     *  answer the backend turns into `UNKNOWN_EVENT` rather than "you have no permission". */
    eventOrg: (eventId: bigint) => call<bigint>('eventOrg', [eventId]),
    tierOf: (tokenId: bigint) => call<number>('tierOf', [tokenId]),
    eventStatus: (eventId: bigint) => call<number>('eventStatus', [eventId]),
    isRevoked: (tokenId: bigint) => call<boolean>('isRevoked', [tokenId]),
    transfersOf: (tokenId: bigint) => call<number>('transfersOf', [tokenId]),
    balanceOfEvent: (account: Hex, eventId: bigint) => call<bigint>('balanceOfEvent', [account, eventId]),
    checkInOf: (tokenId: bigint) => call<CheckInStruct>('checkInOf', [tokenId]),
    eventMeta: (eventId: bigint) => call<EventMetaStruct>('eventMeta', [eventId]),
    tiers: (eventId: bigint) => call<readonly TierStruct[]>('tiers', [eventId]),
    offerOf: (tokenId: bigint) => call<OfferStruct>('offerOf', [tokenId]),
    /**
     * `86400` (1 day). How long a ticket waits before it will follow a rotated account:
     * `migrate` inside that window reverts `RotationPending`
     * (`contracts/docs/abi-delta-01b.md` §6), so the "티켓 가져오기" button counts from here.
     */
    migrateDelay: () => call<bigint>('MIGRATE_DELAY', []),
    /**
     * **The parity target.** The exact 32 bytes the attendee phone must sign for `checkIn` /
     * `checkInLate` (`contracts/docs/abi-delta-01b.md` §7.2):
     * `sha256(abi.encode(block.chainid, address(this), tokenId, gateId, eventId, nonce,
     * issuedAt))` — seven words, 224 bytes.
     *
     * The two inputs a client cannot choose — `block.chainid` and `address(this)` — are filled
     * in by the contract, not passed. That is exactly why a hand-rolled sha256 that omits them
     * passes every local test and then fails at the door, and why `deviceDigest.parity.test.ts`
     * pins one vector against this deployed view rather than against another local function.
     */
    deviceDigest: (tokenId: bigint, gateId: bigint, eventId: bigint, nonce: Hex, issuedAt: bigint) =>
      call<Hex>('deviceDigest', [tokenId, gateId, eventId, nonce, issuedAt]),
  };
}

/**
 * The exact component names, in the exact order, of every value the helpers above hand back
 * as a named object. viem fills those objects positionally out of the ABI tuple, so a field
 * sub-plan 01 reorders or renames would land in the wrong property — same width, no error,
 * wrong value — and `gateInfo`'s six separate outputs are destructured by index here.
 *
 * `abis.test.ts` pins every list below against the generated ABI, so that change breaks a
 * test instead of a screen. `satisfies` keeps each list honest against its interface.
 */
const EVENT_META_FIELDS = [
  'orgId', 'titleHash', 'descHash', 'imageCid', 'startsAt', 'endsAt', 'venueHash',
  'saleStart', 'saleEnd', 'transferable', 'transferCutoffSeconds', 'maxTransfers',
  'approvalRequired', 'category', 'regionCode', 'requireKyc',
] as const satisfies readonly (keyof EventMetaStruct)[];

const TIER_FIELDS = [
  'name', 'priceUsdCents', 'supply', 'minted', 'maxPerWallet', 'seated',
] as const satisfies readonly (keyof TierStruct)[];

// The 01b order (`contracts/docs/abi-delta-01b.md` §5): `nonceHash` in front of `ts`, and
// `late` at the end. `checkInOf`'s selector `0xdb7b7d7e` did **not** change, so nothing about
// this reorder can surface as a compile error, a revert, or a decode failure — a wrong list
// here just reads `ts` out of `nonceHash`'s slot, same width, no error, wrong value.
// `STRUCT_SHAPES` below and `abis.test.ts` are the only thing standing between this app and
// exactly that.
const CHECK_IN_FIELDS = [
  'gateId', 'nonceHash', 'ts', 'manual', 'late',
] as const satisfies readonly (keyof CheckInStruct)[];

const OFFER_FIELDS = [
  'from', 'recipientCommitment', 'expiresAt',
] as const satisfies readonly (keyof OfferStruct)[];

const GATE_INFO_FIELDS = [
  'eventId', 'account', 'kx', 'ky', 'open', 'revoked',
] as const satisfies readonly (keyof GateInfoStruct)[];

// Two `bytes32` of the same width: a swap here would hand WebCrypto and the P-256 precompile a
// mirrored point and every check-in would read as a bad device signature.
const ACTIVE_DEVICE_FIELDS = ['x', 'y'] as const satisfies readonly (keyof DeviceKeyPoint)[];

// Two booleans of the same width: swapped, a manager who may only file a request would read as
// one who may approve an entry exception outright.
const MANAGER_FIELDS = ['exists', 'canApprove'] as const satisfies readonly (keyof ManagerStruct)[];

/**
 * The same pin, for the structs this app **sends**. `Ticket.createEvent` takes an `EventMeta`
 * and a `Tier[]` as calldata, and viem encodes an object positionally out of the ABI's
 * components exactly as it decodes one: a field sub-plan 01 reordered would be encoded into
 * the neighbouring slot at the same width, with no error on the way — an event published with
 * its sale window where its schedule should be. `abis.test.ts` pins both lists, reading the
 * function's *inputs* rather than its outputs.
 *
 * The two lists are the same ones the reads use, so a struct can never drift between the
 * screen that writes it and the screen that reads it back.
 */
export const STRUCT_INPUT_SHAPES = {
  Ticket: {
    createEvent: { meta: EVENT_META_FIELDS, tiers_: TIER_FIELDS },
    // The edit path sends the same two structs as the create path and has to be pinned too —
    // otherwise a reordered `EventMeta` is caught when an event is made and missed when it is
    // edited. Both rows reference the same two lists, and so do the reads above, so a struct
    // cannot drift between the screen that creates one, the screen that edits it, and the
    // screen that reads it back.
    updateEventMeta: { meta: EVENT_META_FIELDS, tiers_: TIER_FIELDS },
  },
} as const;

export const STRUCT_SHAPES = {
  Ticket: {
    eventMeta: EVENT_META_FIELDS, tiers: TIER_FIELDS, checkInOf: CHECK_IN_FIELDS,
    offerOf: OFFER_FIELDS,
  },
  Organizers: { gateInfo: GATE_INFO_FIELDS, managerOf: MANAGER_FIELDS },
  Identity: { activeDevice: ACTIVE_DEVICE_FIELDS },
} as const;

/**
 * `Ticket.claimNonce(eventId, account) -> uint256`: the (event, account) claim nonce a relayed
 * `ClaimAuth` must carry (design §12). The 2026-09-29 redeploy exports this view, so it reads
 * through the generated `ticketAbi` like every other Ticket read. It stays a standalone helper
 * rather than a `readTicket` entry because it takes an `(eventId, account)` argument pair no other
 * read here does.
 */
export function readClaimNonce(eventId: bigint, account: Hex): Promise<bigint> {
  return getPublicClient().readContract({
    address: getConfig().addresses.ticket,
    abi: ABI_BY_CONTRACT.Ticket,
    functionName: 'claimNonce',
    args: [eventId, account],
  }) as Promise<bigint>;
}
