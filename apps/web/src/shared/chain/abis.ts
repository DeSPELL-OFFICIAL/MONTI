import { encodeEventTopics, type Abi, type Hex } from 'viem';
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
  Identity: { isMember: 1, isLocked: 1, kycLevelOf: 1, deviceUpdatedAt: 1 },
  Organizers: { gateInfo: 1, isOpenGate: 2, hasPermission: 3, gateOf: 1, ownerOf: 1 },
  Ticket: {
    eventOf: 1, eventOrg: 1, tierOf: 1, eventStatus: 1, isRevoked: 1, transfersOf: 1, balanceOfEvent: 2,
    checkInOf: 1, eventMeta: 1, tiers: 1, offerOf: 1,
    checkIn: 3,
    claim: 3, safeTransferFrom: 3,
    createOffer: 3, cancelOffer: 1, acceptOffer: 2,
  },
} as const satisfies Record<UsedContract, Readonly<Record<string, number>>>;

/**
 * Every **event** this app subscribes to, and how many parameters it carries. `USED_ABI` above
 * covers the calls; a log subscription needs the same guard for the opposite reason: a renamed
 * event does not throw, it simply never fires, and at a gate that is indistinguishable from a
 * door the chain never answered. `abis.test.ts` checks each name against the generated JSON.
 *
 * `CheckedInLate` is the second half of check-in after sub-plan 01b's redeploy: a tap recorded
 * outside the code window is emitted under its own name as well. It is listed here and in
 * {@link PENDING_EVENTS}, because the ABI this branch builds against does not have it yet.
 */
export const USED_EVENTS = {
  Identity: {},
  Organizers: {},
  Ticket: {
    /**
     * `CheckedIn(uint256 indexed tokenId, uint256 indexed eventId, uint256 indexed gateId,
     * bytes32 nonceHash, uint64 ts)` — the gate's verdict. `nonceHash` in the data is
     * `keccak256(abi.encode(nonce))` of the code the gate served (`Ticket.sol:360`), which is
     * the only thing that says *which tap* this log answers.
     */
    CheckedIn: 5,
    /**
     * 01b: `CheckedInLate(uint256 indexed tokenId, uint256 indexed gateId, uint64 issuedAt,
     * uint64 ts)` — **four** parameters, no `eventId` and no `nonceHash`
     * (`MONTI-01b/contracts/docs/abi-delta-01b.md:54`). It is emitted *in addition to*
     * `CheckedIn` on the late path, so the nonce match still lands on `CheckedIn`; this one is
     * subscribed so the filter needs no edit the day the offline queue drains through
     * `checkInLate`. Pending until the redeploy.
     */
    CheckedInLate: 4,
  },
} as const satisfies Record<UsedContract, Readonly<Record<string, number>>>;

/**
 * Names `USED_EVENTS` declares that the deployed ABI does not carry yet. {@link eventTopic}
 * answers `null` for these, so a subscription simply leaves them out of its `topic0` filter
 * instead of throwing — and `abis.test.ts` asserts they are still absent, so the day 01b's ABI
 * lands the test fails and the name has to be removed from here to turn the subscription on.
 */
export const PENDING_EVENTS: Readonly<Record<UsedContract, readonly string[]>> = {
  Identity: [],
  Organizers: [],
  Ticket: ['CheckedInLate'],
};

/**
 * `topic0` for one event, or `null` while the generated ABI has no such event. Callers build a
 * `topic0` array out of the non-null answers, which is how one subscription can cover both
 * `CheckedIn` today and `CheckedIn` + `CheckedInLate` after the redeploy, with no other change.
 */
export function eventTopic(contract: UsedContract, eventName: string): Hex | null {
  const abi = ABI_BY_CONTRACT[contract];
  if (!abi.some((entry) => entry.type === 'event' && entry.name === eventName)) return null;
  return encodeEventTopics({ abi, eventName })[0] as Hex;
}

/** The names `USED_ABI` allows for one contract — what `functionName` is typed as. */
export type UsedFunction<C extends UsedContract> = Extract<keyof (typeof USED_ABI)[C], string>;

export const ABI_BY_CONTRACT: Readonly<Record<UsedContract, Abi>> = {
  Identity: identityAbi,
  Organizers: organizersAbi,
  Ticket: ticketAbi,
};
