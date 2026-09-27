import type { EventDraft } from '../../shared/api/firestore';
import type { TicketArtPreset } from '../../shared/ui';
import { FONT_STACK, escapeXml, wrapTitle } from '../../shared/ui/ticketArt/buildTicketSvg';
import { TICKET_BACKDROPS } from '../../shared/ui/ticketArt/presets';
import { TICKET_ART_PRESETS } from './draftRules';

/**
 * The default poster, for an event whose organiser never uploaded one (plan section B-2). The
 * poster is optional now, but `pinEventMetadata` still wants an `imageCid`, and the founder's A4
 * requirement stays — so an empty poster is filled at publish with one synthesised here from the
 * two things the event already has: its title and the theme backdrop its ticket picture uses.
 *
 * The "theme colour" is the ticket backdrop itself, reused rather than reinvented: the same
 * twelve drawings the ticket art picker offers ({@link TICKET_BACKDROPS}), so the poster and the
 * ticket read as one event. Nothing new is drawn — the backdrop is placed in the A4 frame and
 * the title is set over a scrim that keeps white type legible over any of the twelve.
 */

/** A4 portrait at 150dpi — the same frame `a4Crop` produces for an uploaded poster. */
const POSTER_WIDTH = 1240;
const POSTER_HEIGHT = 1754;
/** The ticket backdrops are drawn in a 1000×1600 frame; that is what is sliced into the A4 one. */
const BACKDROP_WIDTH = 1000;
const BACKDROP_HEIGHT = 1600;

const PAD = 96;
const TITLE_SIZE = 120;
const TITLE_LINE_HEIGHT = 142;
/** The last title line's baseline, near the lower third; extra lines stack upward from it. */
const TITLE_BASELINE = 1560;
const MAX_TITLE_LINES = 3;
/** The room one title line has, in the em units {@link wrapTitle} counts. */
const TITLE_UNITS = (POSTER_WIDTH - PAD * 2) / TITLE_SIZE;

/** The JPEG quality `a4Crop` encodes an uploaded poster at, so the two are the same weight. */
const POSTER_QUALITY = 0.85;

/** The design letter the first kind carries, folded to a real preset the way `tierArt` does. */
function presetOf(draft: EventDraft): TicketArtPreset {
  const design = draft.tiers[0]?.design ?? 'a';
  return TICKET_ART_PRESETS.find((key) => key === design) ?? 'a';
}

/**
 * The default poster as one SVG document: the theme backdrop sliced to fill the A4 frame, a
 * bottom scrim, and the event title in white near the lower third. Pure — every string that
 * reaches it goes through {@link escapeXml}, the one reason handing this to a rasteriser is safe.
 */
export function buildPosterSvg(title: string, preset: TicketArtPreset): string {
  const backdrop = TICKET_BACKDROPS[preset] ?? TICKET_BACKDROPS.a;
  const lines = wrapTitle(title, TITLE_UNITS, MAX_TITLE_LINES);
  const titleTop = TITLE_BASELINE - (lines.length - 1) * TITLE_LINE_HEIGHT;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${POSTER_WIDTH} ${POSTER_HEIGHT}"`,
    ' width="100%" height="100%" preserveAspectRatio="xMidYMid slice">',

    '<defs>',
    '<linearGradient id="poster-scrim" x1="0" y1="0" x2="0" y2="1">',
    '<stop offset="0.45" stop-color="#08090c" stop-opacity="0"/>',
    '<stop offset="1" stop-color="#08090c" stop-opacity="0.92"/>',
    '</linearGradient>',
    '</defs>',

    // The ticket backdrop, drawn 1000×1600 and sliced to fill the A4 frame — the "theme colour".
    // Its own `defs` ride inside this nested viewport; ids are document-scoped, so they resolve.
    `<svg x="0" y="0" width="${POSTER_WIDTH}" height="${POSTER_HEIGHT}"`,
    ` viewBox="0 0 ${BACKDROP_WIDTH} ${BACKDROP_HEIGHT}" preserveAspectRatio="xMidYMid slice">`,
    `<defs>${backdrop.defs}</defs>`,
    backdrop.body,
    '</svg>',

    `<rect x="0" y="0" width="${POSTER_WIDTH}" height="${POSTER_HEIGHT}" fill="url(#poster-scrim)"/>`,

    ...lines.map((text, at) =>
      `<text x="${PAD}" y="${titleTop + at * TITLE_LINE_HEIGHT}" font-family="${FONT_STACK}"`
      + ` font-size="${TITLE_SIZE}" font-weight="700" fill="#ffffff">${escapeXml(text)}</text>`),

    '</svg>',
  ].join('');
}

/** Loads an SVG data URL into an `Image`; rejects rather than hanging when it cannot be drawn. */
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('POSTER_RENDER_FAILED'));
    image.src = src;
  });
}

/**
 * The default poster as raw base64 JPEG — exactly the shape `pinEventImage` takes, so it goes up
 * the same path an uploaded poster does. The SVG is drawn once onto an A4 canvas and encoded.
 *
 * This is the client-side raster the plan permits (section B-2). It is the same Safari risk
 * `buildTicketSvg` flags for a *download* — Korean baked through `canvas.drawImage` — but here
 * there is no long-press alternative: a pin needs bytes, and the bytes have to be made somewhere.
 * A device with no canvas rejects rather than pins nothing silently.
 */
export async function renderAutoPoster(draft: EventDraft): Promise<string> {
  const svg = buildPosterSvg(draft.title.trim(), presetOf(draft));
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  const image = await loadImage(url);
  const canvas = document.createElement('canvas');
  canvas.width = POSTER_WIDTH;
  canvas.height = POSTER_HEIGHT;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('POSTER_CANVAS_UNAVAILABLE');
  context.drawImage(image, 0, 0, POSTER_WIDTH, POSTER_HEIGHT);
  const dataUrl = canvas.toDataURL('image/jpeg', POSTER_QUALITY);
  return dataUrl.slice(dataUrl.indexOf(',') + 1);
}
