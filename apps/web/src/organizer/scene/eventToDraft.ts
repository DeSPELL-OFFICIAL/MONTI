import type { EventDraft, EventDraftTier } from '../../shared/api/firestore';
import type { EventMetadata } from '../../shared/envio/ipfs';
import type { EnvioEvent, EnvioTier } from '../../shared/envio/queries';
import type { TicketArtSource } from '../../shared/ui';
import { emptyEventDraft, emptyEventDraftTier } from '../useEventDraft';

const SECONDS_PER_HOUR = 3_600;

/** Everything an event that already exists is scattered across, in the four places it lives. */
export interface EventSources {
  event: EnvioEvent;
  tiers: readonly EnvioTier[];
  /** The readable half, or `null` when the gateway would not hand the document over. */
  metadata: EventMetadata | null;
  /** The real venue, from `getEventPrivate` — only ever present when the venue is hidden. */
  privateVenue: string;
  /** The stored pictures in tier order, as `eventArt/{eventId}` holds them. */
  art: readonly TicketArtSource[];
}

/** A stored picture folded back into the two fields the draft keeps apart. */
function toArtFields(art: TicketArtSource | undefined): Pick<EventDraftTier, 'design' | 'imageCid'> {
  if (art === undefined) return { design: emptyEventDraftTier.design, imageCid: '' };
  return 'preset' in art
    ? { design: art.preset, imageCid: '' }
    : { design: emptyEventDraftTier.design, imageCid: art.imageCid };
}

/**
 * One live event as the creation scene's draft, so that editing it is the same screen and the
 * same rules as making it (T-EV-W12). Nothing here is invented: every field is read back from
 * the place that holds it, and a field no source could answer keeps the empty draft's value.
 *
 * The four sources, and why each one is needed:
 *   - the **indexer** for everything the chain carries as a number or a flag — the times, the
 *     transfer rules, the kinds and their supplies;
 *   - the **pinned document** for everything the chain carries only as a hash — the title, the
 *     description, the venue, the tags and the two visibility flags;
 *   - **`getEventPrivate`** for the venue of an event whose organiser hid it, because the
 *     public document has no `venue` key at all in that case;
 *   - **`eventArt/{eventId}`** for the pictures, which the chain has no room for.
 *
 * `regionCode` comes from the document rather than from `Event.regionCode`: the chain stores
 * `keccak256(<ISO region>)` and a hash cannot be turned back into the region it names.
 * `posterCid` likewise comes from the document's own `image`, not from `Event.imageCid` —
 * that one is the CID of the metadata JSON, not of the picture.
 */
export function eventToDraft(eventId: string, sources: EventSources): EventDraft {
  const { event, tiers, metadata, privateVenue, art } = sources;
  const hiddenVenue = metadata?.venueHidden === true;
  const tierDrafts: EventDraftTier[] = tiers.map((tier, index) => ({
    ...emptyEventDraftTier,
    name: tier.name,
    supply: Number(tier.supply),
    maxPerWallet: Number(tier.maxPerWallet),
    // Every existing event is free — `Ticket.claim` refuses anything else — so the currency is
    // not read back from the chain's cents; it is the one answer the chain can hold today.
    currency: 'free',
    amount: 0,
    ...toArtFields(art[index]),
  }));

  return {
    ...emptyEventDraft,
    orgId: event.orgId,
    title: metadata?.title ?? '',
    description: metadata?.description ?? '',
    posterCid: metadata?.imageCid ?? '',
    category: event.category,
    tags: metadata?.tags ?? [],
    regionCode: metadata?.region ?? emptyEventDraft.regionCode,
    // The hidden venue is not in the public document, so the callable's answer is the only
    // copy of it there is. An empty answer leaves the field empty rather than inventing one.
    venue: hiddenVenue ? privateVenue : (metadata?.venue ?? ''),
    venueHidden: hiddenVenue,
    startsAt: Number(event.startsAt),
    endsAt: Number(event.endsAt),
    timeHidden: metadata?.timeHidden === true,
    transferable: event.transferable,
    transferCutoffHours: Number(event.transferCutoffSeconds) / SECONDS_PER_HOUR,
    requireKyc: event.requireKyc,
    tiers: tierDrafts.length > 0 ? tierDrafts : emptyEventDraft.tiers,
    // This draft was opened from an event; it has not made one. The two are never both set.
    submittedRelayId: '',
    createdEventId: '',
    editingEventId: eventId,
  };
}
