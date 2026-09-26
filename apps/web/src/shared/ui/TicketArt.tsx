import { gatewayUrl } from '../envio/ipfs';
import { fmt, useCopy } from '../i18n';
import { buildTicketSvg } from './ticketArt/buildTicketSvg';

/**
 * `Tier` has no room for a picture (`Ticket.sol:40-47`) and `updateEventMeta` closes the moment
 * an event goes public, so the art key lives in Firestore instead of the pinned JSON. What is
 * stored is therefore ten bytes — one of these twelve letters — or a CID the organiser uploaded.
 *
 * **Twelve, because three alphabets have to agree and the narrowest one wins.** The server's
 * `ART_PRESETS` (`functions/src/functions/eventArt.ts`) and the draft rule
 * (`art.get('preset','a').matches('^[a-l]$')`, firestore.rules) both say `a`–`l`; a thirteenth
 * letter here would be a picker whose choice autosave rejects with a permission error, and the
 * rules file warns about exactly that failure. The two client-side copies of this alphabet —
 * `TICKET_ART_PRESETS` in `shared/api/firestore.ts` and in `organizer/scene/draftRules.ts` —
 * are both typed against this union, so widening it without widening them fails the build.
 */
export type TicketArtPreset = 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g' | 'h' | 'i' | 'j' | 'k' | 'l';

/** One of the bundled backdrops, or a picture the organiser cropped and pinned themselves. */
export type TicketArtSource = { preset: TicketArtPreset } | { imageCid: string };

export interface TicketArtProps {
  art: TicketArtSource;
  title: string;
  tierName: string;
  /** Whose ticket it is. Blank draws no line — the ticket never carries a placeholder name. */
  holder?: string;
  /** When the event starts, already formatted. Blank draws no line, for the same reason. */
  dateText?: string;
  /** Derived from the index (`checkIn != null`) by whoever renders this; see T-EV-W9. */
  used?: boolean;
}

/**
 * One ticket, drawn as a single inline SVG.
 *
 * The title and the kind used to be HTML laid over an `<img>`, because SVG `<text>` does not
 * wrap and a long event name would have run out of the frame. The wrap is decided in JS now
 * ({@link wrapTitle}), so the picture and its words are one object rather than two that line
 * up — which is what lets the ticket carry a name and a date at all.
 *
 * `dangerouslySetInnerHTML` is safe here for exactly one reason: every interpolated string
 * goes through {@link escapeXml} inside {@link buildTicketSvg}. A title containing `<script>`
 * is drawn as those nine characters and cannot become an element; there is a test that proves
 * it, and it is the test that must be kept green if this markup is ever built another way.
 *
 * The accessible name is unchanged: the picture is one `role="img"` with a label from copy, so
 * a screen reader hears the event, the kind and — on a spent ticket — 사용됨, and never the
 * fifteen `<text>` nodes that make up the drawing.
 */
export function TicketArt({
  art, title, tierName, holder = '', dateText = '', used = false,
}: TicketArtProps) {
  const copy = useCopy().tickets;
  const label = fmt(used ? copy.artLabelUsed : copy.artLabel, { title, tier: tierName });
  const svg = buildTicketSvg({
    ...('preset' in art ? { preset: art.preset } : { imageHref: gatewayUrl(art.imageCid) }),
    title,
    tierName,
    holder,
    dateText,
    used,
    usedLabel: copy.artUsed,
  });

  return (
    <div
      className="ticket-art"
      role="img"
      aria-label={label}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
