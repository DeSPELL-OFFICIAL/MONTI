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
  };
}
