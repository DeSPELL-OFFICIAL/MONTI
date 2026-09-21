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

export interface CheckInStruct {
  gateId: bigint;
  ts: bigint;
  nonceHash: Hex;
  manual: boolean;
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

/**
 * `Identity.ROTATION_UNDO_WINDOW()` and `Ticket.MIGRATE_DELAY()` — one span under two names,
 * which sub-plan 01b's redeploy asserts are equal to each other. Neither view exists on the
 * ABI this branch builds against, so the span is named once here and read from this constant;
 * no screen interpolates an hour count of its own. When 01b lands it becomes a real read
 * (`readIdentity().rotationUndoWindow()`) and this line goes away.
 */
export const ROTATION_UNDO_WINDOW_SECONDS = 86_400;

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

export function readOrganizers() {
  const call = reader('Organizers', getConfig().addresses.organizers);
  return {
    isOpenGate: (eventId: bigint, gateAccount: Hex) => call<boolean>('isOpenGate', [eventId, gateAccount]),
    hasPermission: (orgId: bigint, account: Hex, bit: number) =>
      call<boolean>('hasPermission', [orgId, account, bit]),
    gateOf: (gateAccount: Hex) => call<bigint>('gateOf', [gateAccount]),
    ownerOf: (orgId: bigint) => call<Hex>('ownerOf', [orgId]),
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
    tierOf: (tokenId: bigint) => call<number>('tierOf', [tokenId]),
    eventStatus: (eventId: bigint) => call<number>('eventStatus', [eventId]),
    isRevoked: (tokenId: bigint) => call<boolean>('isRevoked', [tokenId]),
    transfersOf: (tokenId: bigint) => call<number>('transfersOf', [tokenId]),
    balanceOfEvent: (account: Hex, eventId: bigint) => call<bigint>('balanceOfEvent', [account, eventId]),
    checkInOf: (tokenId: bigint) => call<CheckInStruct>('checkInOf', [tokenId]),
    eventMeta: (eventId: bigint) => call<EventMetaStruct>('eventMeta', [eventId]),
    tiers: (eventId: bigint) => call<readonly TierStruct[]>('tiers', [eventId]),
    offerOf: (tokenId: bigint) => call<OfferStruct>('offerOf', [tokenId]),
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

const CHECK_IN_FIELDS = [
  'gateId', 'ts', 'nonceHash', 'manual',
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

export const STRUCT_SHAPES = {
  Ticket: {
    eventMeta: EVENT_META_FIELDS, tiers: TIER_FIELDS, checkInOf: CHECK_IN_FIELDS,
    offerOf: OFFER_FIELDS,
  },
  Organizers: { gateInfo: GATE_INFO_FIELDS },
  Identity: { activeDevice: ACTIVE_DEVICE_FIELDS },
} as const;
