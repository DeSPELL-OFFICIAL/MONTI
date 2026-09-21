import type { Abi } from 'viem';
import { identityAbi, organizersAbi, ticketAbi } from '@monti/shared';

/**
 * The generated ABIs, events included, exactly as sub-plan 01's `export-abi.sh` produced them
 * and `@monti/shared` re-exports them. Nothing here is hand-written: a hand-made fragment
 * carries no events, so `encodeEventTopics` would not find `CheckedIn`, and its `{name,type}`
 * key order never matches solc's `{internalType,name,type}`.
 */
export { identityAbi, organizersAbi, ticketAbi };

export type UsedContract = 'Identity' | 'Organizers' | 'Ticket';

/**
 * Every contract function this app names, and how many arguments it passes. Two things hang
 * off it, which together stop it drifting from the code:
 *
 * - `reads.ts` and the `*Op` helpers type their `functionName` as a key of this map, so a call
 *   the manifest does not list is a compile error rather than a runtime `AbiFunctionNotFound`;
 * - `abis.test.ts` looks every entry up in the generated JSON, so a signature sub-plan 01
 *   renames or re-types breaks a test here first.
 *
 * The arity is what picks an overload: `safeTransferFrom` at 3 is
 * `safeTransferFrom(address,address,uint256)` (`0x42842e0e`), not the 4-argument one.
 */
export const USED_ABI = {
  Identity: { isMember: 1, isLocked: 1, kycLevelOf: 1 },
  Organizers: { gateInfo: 1, isOpenGate: 2, hasPermission: 3, gateOf: 1, ownerOf: 1 },
  Ticket: {
    eventOf: 1, eventOrg: 1, tierOf: 1, eventStatus: 1, isRevoked: 1, transfersOf: 1, balanceOfEvent: 2,
    checkInOf: 1, eventMeta: 1, tiers: 1, offerOf: 1,
    claim: 3, safeTransferFrom: 3,
    createOffer: 3, cancelOffer: 1, acceptOffer: 2,
  },
} as const satisfies Record<UsedContract, Readonly<Record<string, number>>>;

/** The names `USED_ABI` allows for one contract — what `functionName` is typed as. */
export type UsedFunction<C extends UsedContract> = Extract<keyof (typeof USED_ABI)[C], string>;

export const ABI_BY_CONTRACT: Readonly<Record<UsedContract, Abi>> = {
  Identity: identityAbi,
  Organizers: organizersAbi,
  Ticket: ticketAbi,
};
