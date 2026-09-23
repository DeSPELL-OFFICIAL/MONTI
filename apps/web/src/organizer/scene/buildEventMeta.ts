import { keccak256, toBytes } from 'viem';
import type { EventMetaStruct, TierStruct } from '../../shared/chain/reads';

/**
 * One ticket kind as the chain takes it. There is no price: `Ticket.claim` reverts
 * `PaidTiersNotEnabled` on any tier whose `priceUsdCents` is not zero, so an event with a paid
 * tier is one nobody could ever get a ticket for. `buildTiers` writes the zero.
 */
export interface ChainTier {
  name: string;
  supply: number;
  maxPerWallet: number;
  seated: boolean;
}

/**
 * An event in the shape the two builders below read, which is **not** the shape any screen
 * edits. `organizer/scene/usePublish.ts` adapts its draft into this on the way out, so that
 * every readable field is trimmed exactly once and the string hashed onto the chain is the
 * same one pinned to IPFS — `titleHash`, `descHash` and `venueHash` are written once and can
 * never be repaired.
 */
export interface ChainDraft {
  orgId: string;
  title: string; description: string;
  venue: string; regionCode: string; category: number;
  startsAt: number; endsAt: number; saleStart: number; saleEnd: number;
  transferable: boolean; transferCutoffHours: number; maxTransfers: number; approvalRequired: boolean;
  /** Anti-scalping switch. Off for casual meetups, on for concerts. */
  requireKyc: boolean;
  tiers: ChainTier[];
}

const SECONDS_PER_HOUR = 3600;

/**
 * The event as `Ticket.EventMeta`. `metaCid` is the CID of the metadata JSON the backend
 * pinned, and that JSON is what carries the image CID — the chain holds only hashes of the
 * readable fields, so `EventMeta.imageCid` has to point at the document `shared/envio/ipfs.ts`
 * reads `{ name, description, image }` out of, not at the picture.
 */
export function buildEventMeta(draft: ChainDraft, metaCid: string): EventMetaStruct {
  return {
    orgId: BigInt(draft.orgId),
    titleHash: keccak256(toBytes(draft.title)),
    descHash: keccak256(toBytes(draft.description)),
    imageCid: metaCid,
    startsAt: BigInt(draft.startsAt),
    endsAt: BigInt(draft.endsAt),
    // The backend trims the venue before it pins it (`optionalMetaField` in the backend's
    // `organizer.ts`), so the trimmed string is the one the readable document will carry.
    // Hashing the untrimmed one would put a `venueHash` on chain that the pinned document does
    // not match, and nothing can repair that afterwards: `EventMeta` is written once.
    venueHash: keccak256(toBytes(draft.venue.trim())),
    saleStart: BigInt(draft.saleStart),
    saleEnd: BigInt(draft.saleEnd),
    transferable: draft.transferable,
    transferCutoffSeconds: draft.transferCutoffHours * SECONDS_PER_HOUR,
    maxTransfers: draft.maxTransfers,
    approvalRequired: draft.approvalRequired,
    category: draft.category,
    regionCode: keccak256(toBytes(draft.regionCode)),
    requireKyc: draft.requireKyc,
  };
}

/** `minted` is zero on the way in; `createEvent` zeroes it again on the way into storage. */
export function buildTiers(draft: ChainDraft): TierStruct[] {
  return draft.tiers.map((tier) => ({
    name: tier.name,
    priceUsdCents: 0n,
    supply: tier.supply,
    minted: 0,
    maxPerWallet: tier.maxPerWallet,
    seated: tier.seated,
  }));
}
