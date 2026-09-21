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
 * `Ticket.checkInOf`. `nonceHash` is `keccak256(abi.encode(nonce))` of the code the gate served
 * (`Ticket.sol:360`) and is what the gate's verdict matches a tap on; a manual override writes
 * `bytes32(0)` there, which answers no code at all. An unchecked ticket reads back as the zero
 * struct, so `ts === 0n` — not an absent value — is how a screen reads "nobody came in on this".
 */
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

export function readIdentity() {
  const call = reader('Identity', getConfig().addresses.identity);
  return {
    isMember: (account: Hex) => call<boolean>('isMember', [account]),
    isLocked: (account: Hex) => call<boolean>('isLocked', [account]),
    kycLevelOf: (account: Hex) => call<number>('kycLevelOf', [account]),
    /**
     * When this account's device key was last replaced, unix **seconds** (`0` for an account
     * that has never rotated). Spec §13: the gate puts an amber note on the admit card when a
     * phone changed inside the last day, because a stolen-ticket handover looks exactly like a
     * legitimate new phone and the only person who can tell them apart is standing at the door.
     */
    deviceUpdatedAt: (account: Hex) => call<bigint>('deviceUpdatedAt', [account]),
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
    // The organization that owns an event. `Organizers` keys permissions by org, not event,
    // so every screen that starts from an event id and needs a permission passes through here.
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

// 01b: (gateId, nonceHash, ts, manual, late) — the redeploy reorders `ts` and `nonceHash` and
// adds `late: bool` for a tap recorded outside the code window
// (`MONTI-01b/contracts/docs/abi-delta-01b.md` §5; the selector does not change, so nothing
// else can catch it). The CURRENT order is pinned below on purpose: the day the regenerated ABI
// lands, the test above fails rather than decoding `ts` out of `nonceHash`'s slot — and this
// list and `CheckInStruct` move together.
const CHECK_IN_FIELDS = [
  'gateId', 'ts', 'nonceHash', 'manual',
] as const satisfies readonly (keyof CheckInStruct)[];

const OFFER_FIELDS = [
  'from', 'recipientCommitment', 'expiresAt',
] as const satisfies readonly (keyof OfferStruct)[];

const MANAGER_FIELDS = [
  'exists', 'canApprove',
] as const satisfies readonly (keyof ManagerStruct)[];

const GATE_INFO_FIELDS = [
  'eventId', 'account', 'kx', 'ky', 'open', 'revoked',
] as const satisfies readonly (keyof GateInfoStruct)[];

export const STRUCT_SHAPES = {
  Ticket: {
    eventMeta: EVENT_META_FIELDS, tiers: TIER_FIELDS, checkInOf: CHECK_IN_FIELDS,
    offerOf: OFFER_FIELDS,
  },
  Organizers: { gateInfo: GATE_INFO_FIELDS, managerOf: MANAGER_FIELDS },
} as const;
