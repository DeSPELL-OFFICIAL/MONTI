import type { Abi, Hex } from 'viem';
import { getConfig } from '../config';
import { getPublicClient } from './client';
import { identityAbi, ticketAbi } from './abis';

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

/** One `readContract` bound to a contract, so every call below is a single named line. */
function reader(address: Hex, abi: Abi) {
  return <T>(functionName: string, args: readonly unknown[]): Promise<T> =>
    getPublicClient().readContract({ address, abi, functionName, args }) as Promise<T>;
}

export function readIdentity() {
  const call = reader(getConfig().addresses.identity, identityAbi);
  return {
    isMember: (account: Hex) => call<boolean>('isMember', [account]),
    isLocked: (account: Hex) => call<boolean>('isLocked', [account]),
    kycLevelOf: (account: Hex) => call<number>('kycLevelOf', [account]),
  };
}

export function readTicket() {
  const call = reader(getConfig().addresses.ticket, ticketAbi);
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
