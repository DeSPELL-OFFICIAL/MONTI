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
  Identity: {
    isMember: 1, isLocked: 1, kycLevelOf: 1, activeDevice: 1, deviceUpdatedAt: 1,
    nicknameOwner: 1, setNickname: 2,
    // 01b's recovery undo. `rotatedAt`/`rotatedFrom` take a **personId** (`bytes32`), not an
    // account; `register` stamps `rotatedAt` too, so `rotatedFrom` is the flag that says there
    // is anything to undo (abi-delta-01b.md §1). `cancelRotation` takes no argument — the
    // contract reads the caller — and is sponsored, so it works from an empty account.
    rotatedAt: 1, rotatedFrom: 1, ROTATION_UNDO_WINDOW: 0, cancelRotation: 0,
  },
  Organizers: {
    gateInfo: 1, isOpenGate: 2, hasPermission: 3, gateOf: 1, ownerOf: 1,
    adminBitsOf: 2, managerOf: 2,
    // The organiser's team screen and gate screen. `setAdmin` is owner-only and `setManager`
    // needs PERM_MANAGE_MANAGERS, which is why the backend hands back calldata rather than
    // sending either itself (functions/src/functions/invites.ts).
    setAdmin: 3, setManager: 4,
    registerGate: 4, openGate: 1, closeGate: 1, revokeGate: 1,
  },
  Ticket: {
    eventOf: 1, eventOrg: 1, tierOf: 1, eventStatus: 1, isRevoked: 1, transfersOf: 1, balanceOfEvent: 2,
    checkInOf: 1, eventMeta: 1, tiers: 1, offerOf: 1,
    checkIn: 3,
    // Manual approval (04 T32). Both are sent from the staff member's OWN passkey account and
    // never from the gate account: the chain records `msg.sender` as the approver, and a gate
    // terminal is a device rather than a person who can stand behind letting somebody in.
    requestOverride: 3, manualOverride: 3,
    claim: 3, safeTransferFrom: 3,
    createOffer: 3, cancelOffer: 1, acceptOffer: 2,
    createEvent: 2,
    // The event lifecycle. `updateEventMeta` reverts `NotDraft` once the event is published,
    // which is why the organiser screen only offers it before publishing. `eventOrg` is
    // declared once, above — the merge that brought the organiser block in unioned it a second
    // time here, which is TS1117 and silently drops one of the two entries.
    publishEvent: 1, cancelEvent: 1, updateEventMeta: 3,
    // 01b. `deviceDigest(tokenId, gateId, eventId, nonce, issuedAt)` is the parity target: the
    // contract fills in `block.chainid` and `address(this)` itself, which is exactly why a
    // hand-rolled sha256 passes every local test and fails at the door
    // (abi-delta-01b.md §7.2, and the live vector in §10).
    deviceDigest: 5,
    // T27b's "티켓 가져오기": after a recovery, the NEW account calls `migrate(tokenId)` once
    // `MIGRATE_DELAY` (24 h) has passed, or the call reverts `RotationPending` (§6).
    MIGRATE_DELAY: 0, migrate: 1,
  },
} as const satisfies Record<UsedContract, Readonly<Record<string, number>>>;

/**
 * Every **event** this app subscribes to, and how many parameters it carries. `USED_ABI` above
 * covers the calls; a log subscription needs the same guard for the opposite reason: a renamed
 * event does not throw, it simply never fires, and on the entry screen that is indistinguishable
 * from a gate that refused. `abis.test.ts` checks each name against the generated JSON.
 *
 * `CheckedInLate` is the second half of check-in: a tap recorded outside the code window is
 * emitted under its own name, and an attendee whose entry landed that way must still see the
 * green. It is live as of the 2026-09-23 redeploy, so it is no longer in {@link PENDING_EVENTS}.
 */
export const USED_EVENTS = {
  Identity: {},
  Organizers: {},
  Ticket: {
    /** `CheckedIn(uint256 tokenId, uint256 eventId, uint256 gateId, bytes32 nonceHash, uint64 ts)` */
    CheckedIn: 5,
    /**
     * `EventCreated(uint256 indexed eventId, uint256 indexed orgId, address indexed creator)`.
     * `createEvent` returns the new id, but a sponsored operation gives back a receipt rather
     * than a return value — so this log is the only way the scene learns which event it just
     * made without waiting for the indexer.
     */
    EventCreated: 3,
    /**
     * `CheckedInLate(uint256 indexed tokenId, uint256 indexed gateId, uint64 issuedAt,
     * uint64 ts)` — **four** parameters, no `eventId` and no `nonceHash`
     * (`contracts/docs/abi-delta-01b.md` §2). Live as of the 2026-09-23 Monad testnet redeploy
     * (chain 10143), so the subscription carries it. It is emitted *in addition to* `CheckedIn`
     * on the late path, which is why it is subscribed for the green and never for counting —
     * counting admissions still means counting `CheckedIn` alone.
     */
    CheckedInLate: 4,
    /**
     * `ManualOverride(uint256 indexed tokenId, uint256 indexed gateId, address indexed approver,
     * uint8 role, uint8 reason)` — **five** parameters (`Ticket.sol:114-116`). A gate subscribes
     * to it for one case only: after this terminal filed a `requestOverride`, it is the log that
     * says somebody with the right approved it. Without it a filed request is a dead end on the
     * phone — `requestOverride` writes no check-in, so nothing else will ever mention it again.
     */
    ManualOverride: 5,
  },
} as const satisfies Record<UsedContract, Readonly<Record<string, number>>>;

/**
 * Names `USED_EVENTS` declares that the deployed ABI does not carry yet. The mechanism stands
 * even while the list is empty: {@link eventTopic} answers `null` for a pending name, so a
 * subscription simply leaves it out of its `topic0` filter instead of throwing, and one
 * subscription therefore covers both eras of the ABI with no other change. `abis.test.ts`
 * asserts a pending name is still absent, so the day the ABI gains it the test fails and the
 * name has to be taken out of here — which is what turns the subscription on.
 *
 * Every list is empty today: `CheckedInLate` was the last entry and the 2026-09-23 redeploy
 * put it in the generated ABI. A name goes back on only when `USED_EVENTS` declares an event
 * that the contracts branch has written but not yet deployed and exported.
 */
export const PENDING_EVENTS: Readonly<Record<UsedContract, readonly string[]>> = {
  Identity: [],
  Organizers: [],
  Ticket: [],
};

/**
 * `topic0` for one event, or `null` while the generated ABI has no such event. Callers build a
 * `topic0` array out of the non-null answers, which is how one subscription covered `CheckedIn`
 * alone before the 01b redeploy and covers `CheckedIn` + `CheckedInLate` after it, with no
 * other change.
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
