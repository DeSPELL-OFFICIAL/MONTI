import aurora from '../../assets/ticket-art/aurora.svg';
import dusk from '../../assets/ticket-art/dusk.svg';
import ember from '../../assets/ticket-art/ember.svg';
import mint from '../../assets/ticket-art/mint.svg';
import { gatewayUrl } from '../envio/ipfs';
import { fmt, useCopy } from '../i18n';

/**
 * `Tier` has no room for a picture (`Ticket.sol:40-47`) and `updateEventMeta` closes the moment
 * an event goes public, so the art key lives in Firestore instead of the pinned JSON. What is
 * stored is therefore ten bytes — one of these four letters — or a CID the organiser uploaded.
 */
export type TicketArtPreset = 'a' | 'b' | 'c' | 'd';

/** One of the bundled backdrops, or a picture the organiser cropped and pinned themselves. */
export type TicketArtSource = { preset: TicketArtPreset } | { imageCid: string };

export interface TicketArtProps {
  art: TicketArtSource;
  title: string;
  tierName: string;
  /** Derived from the index (`checkIn != null`) by whoever renders this; see T-EV-W9. */
  used?: boolean;
}

/**
 * Four files, zero pins and zero network: Vite bundles each one, and the small ones land in
 * the page as data URIs. Every event therefore has a picture before anybody uploads anything.
 */
const BACKDROPS: Record<TicketArtPreset, string> = { a: aurora, b: ember, c: mint, d: dusk };

/**
 * The whole of the used treatment on the picture, and the reason it is a style rather than a
 * second file: the stored bytes, the CID and the SVG are the ones a valid ticket shows. It
 * stays on the element so a test can prove the untouched original is what is being greyed out.
 */
const USED_FILTER = 'grayscale(1) contrast(.9)';

function backdropOf(art: TicketArtSource): string {
  return 'preset' in art ? BACKDROPS[art.preset] : gatewayUrl(art.imageCid);
}

/**
 * The title and the tier are HTML over the backdrop rather than `<text>` inside it: SVG text
 * does not wrap, so a long event name would run out of the frame, and the four files stay
 * identical for every event instead of being re-rendered per string.
 */
export function TicketArt({ art, title, tierName, used = false }: TicketArtProps) {
  const copy = useCopy().tickets;
  const label = fmt(used ? copy.artLabelUsed : copy.artLabel, { title, tier: tierName });
  return (
    <div className="ticket-art" role="img" aria-label={label}>
      <img
        className="ticket-art__backdrop"
        src={backdropOf(art)}
        alt=""
        draggable={false}
        style={used ? { filter: USED_FILTER } : undefined}
      />
      <div className="ticket-art__scrim" />
      <div className="ticket-art__caption">
        <p className="ticket-art__tier">{tierName}</p>
        <p className="ticket-art__title">{title}</p>
      </div>
      {used ? <p className="ticket-art__band">{copy.artUsed}</p> : null}
    </div>
  );
}
