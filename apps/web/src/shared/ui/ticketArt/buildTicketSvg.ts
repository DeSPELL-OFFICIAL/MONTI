import type { TicketArtPreset } from '../TicketArt';
import { TICKET_BACKDROPS, TICKET_HEIGHT, TICKET_WIDTH } from './presets';

/**
 * One ticket, as a single SVG document.
 *
 * The four strings a ticket carries — the event, the kind, whose it is and when it is — are
 * `<text>` inside the picture rather than HTML laid over it, which is the whole point of this
 * module. The old component put them in a `<div>` on top of an `<img>`, so the picture and the
 * words were two different objects that only happened to line up; everything drawn here is one
 * object, and a rasteriser handed this string alone produces exactly what the screen shows.
 *
 * **There is no PNG export.** The plan's E-4 (`<a download>` off a canvas) is deliberately
 * dropped for the demo: baking Korean out of a system font stack through `canvas.drawImage` is
 * the Safari risk the plan itself flags in section H-4, and it buys nothing a long-press on an
 * inline picture does not already give. If you came here looking for the download, that is why
 * it is not here — the SVG is rendered inline and nothing else.
 */

/**
 * The Korean fallback chain, inside the document rather than in a stylesheet, so the string is
 * self-contained. No font is embedded or subset: a family that is already on the device costs
 * nothing to name, and a subset large enough for arbitrary Korean would dwarf the picture.
 */
export const FONT_STACK = "system-ui, -apple-system, 'Apple SD Gothic Neo', 'Noto Sans KR', sans-serif";

/**
 * How wide one character is, in multiples of the font size. SVG `<text>` cannot wrap and no
 * text measurement exists before the document is in a browser, so the break has to be decided
 * from the characters alone. Korean and the rest of CJK are square — one em each — while ASCII
 * averages a little over half that in the sans-serifs this stack resolves to. Anything else
 * (Latin with diacritics, Cyrillic, emoji) counts as wide, which errs towards a shorter line:
 * a title that breaks one character early is a great deal better than one that runs off.
 */
const ASCII_WIDTH = 0.55;
const WIDE_WIDTH = 1;

const ELLIPSIS = '…';

/** Type sizes and the grid they sit on, all in the 1000×1600 frame's own units. */
const PAD = 72;
const TITLE_SIZE = 72;
const TITLE_LINE_HEIGHT = 86;
/** The last title line's baseline. Extra lines are stacked upwards from it, never downwards. */
const TITLE_BASELINE = 1090;
const TIER_SIZE = 34;
/** The kind is tracked out, and every character pays for it — so the fit has to count it. */
const TIER_SPACING = 4;
/** How far the kind's baseline sits above the top of the title block. */
const TIER_GAP = 34;
/** The name on the stub. */
const HOLDER_SIZE = 46;
const MAX_TITLE_LINES = 2;
/** The room one title line has, in the em units {@link textWidth} counts. */
const TITLE_UNITS = (TICKET_WIDTH - PAD * 2) / TITLE_SIZE;
/**
 * The room a one-line string has, in the frame's own units. The title block is inset on both
 * sides; the kind and the name start at the left margin and run to the frame's edge.
 */
const LINE_BUDGET = TICKET_WIDTH - PAD;

/** The tear, and the stub below it. */
const PERFORATION_Y = 1180;
const STUB_FIRST_BASELINE = 1310;
const STUB_LINE_STEP = 96;

/**
 * The whole of the used treatment on the picture, and the reason it is a style rather than a
 * second document: the stored bytes, the CID and the backdrop are the ones a valid ticket
 * shows. It stays on the backdrop group alone — never on the band or the words — so a test can
 * prove the untouched original is what is being greyed out.
 */
const USED_FILTER = 'grayscale(1) contrast(.9)';

/**
 * Every string that reaches this module is user input — an event title, a ticket kind an
 * organiser typed, a display name somebody chose — and the result is handed to
 * `dangerouslySetInnerHTML`. This escaper is the only reason that is safe, so nothing may be
 * interpolated into the document without going through it.
 */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** One character's width, in multiples of the font size. See {@link ASCII_WIDTH}. */
function charWidth(char: string): number {
  return (char.codePointAt(0) ?? 0) < 0x80 ? ASCII_WIDTH : WIDE_WIDTH;
}

/** A string's width, in multiples of the font size. Counted by code point, not by UTF-16 unit. */
export function textWidth(text: string): number {
  let total = 0;
  for (const char of text) total += charWidth(char);
  return total;
}

/** As much of `text` as fits in `maxUnits`, broken at a space when the cut would split a word. */
function takeLine(text: string, maxUnits: number): { line: string; rest: string } {
  const chars = [...text];
  let width = 0;
  let end = 0;
  let lastSpace = -1;
  for (let at = 0; at < chars.length; at += 1) {
    const next = charWidth(chars[at] as string);
    if (width + next > maxUnits) break;
    if (chars[at] === ' ') lastSpace = at;
    width += next;
    end = at + 1;
  }
  if (end >= chars.length) return { line: text, rest: '' };
  // A single character wider than the whole line still has to move the cursor, or this loops.
  if (end === 0) end = 1;
  // Korean runs without spaces, so a break inside a word is normal and is only avoided when
  // there is a space to prefer — and never when that space is the very start of the line.
  const cut = chars[end] !== ' ' && lastSpace > 0 ? lastSpace : end;
  return {
    line: chars.slice(0, cut).join('').trimEnd(),
    rest: chars.slice(cut).join('').trimStart(),
  };
}

/** `line`, shortened until it and a trailing ellipsis both fit. */
function ellipsise(line: string, maxUnits: number): string {
  const chars = [...line];
  while (chars.length > 0 && textWidth(chars.join('')) + WIDE_WIDTH > maxUnits) chars.pop();
  return `${chars.join('').trimEnd()}${ELLIPSIS}`;
}

/**
 * A string the layout gives exactly one line to — the ticket kind and the name on the stub —
 * cut to fit {@link LINE_BUDGET} at the size and tracking it is drawn at.
 *
 * Neither is a title and neither has a second line reserved beneath it, so the answer to one
 * that does not fit is an ellipsis rather than a wrap. Without this a 24-character Korean name
 * (`24 x 46 = 1104`) or a 40-character Korean kind (`40 x 38 = 1520`) — both at their own caps
 * — run past the right edge of a 1000-unit frame and are cut mid-character by it.
 *
 * `spacing` is `letter-spacing`, which SVG adds to every character: charging it per em keeps
 * the sum conservative for Korean, which is exactly one em wide.
 */
export function fitLine(text: string, size: number, spacing = 0): string {
  const maxUnits = LINE_BUDGET / (size + spacing);
  return textWidth(text) <= maxUnits ? text : ellipsise(text, maxUnits);
}

/**
 * An event title broken into at most `maxLines` lines of at most `maxUnits` each, with an
 * ellipsis on the last line when there was more.
 *
 * This is a pure function on purpose: it is the one piece of the ticket that can be wrong in a
 * way nobody notices until a long Korean title is already on somebody's phone, and it is the
 * only piece that can be checked without a browser at all.
 */
export function wrapTitle(title: string, maxUnits = TITLE_UNITS, maxLines = MAX_TITLE_LINES): string[] {
  const text = title.replace(/\s+/g, ' ').trim();
  if (text === '' || maxLines < 1) return [];
  const lines: string[] = [];
  let rest = text;
  while (rest !== '' && lines.length < maxLines) {
    const taken = takeLine(rest, maxUnits);
    const last = lines.length === maxLines - 1;
    lines.push(last && taken.rest !== '' ? ellipsise(taken.line, maxUnits) : taken.line);
    rest = taken.rest;
  }
  return lines;
}

export interface TicketSvgInput {
  /** One of the twelve bundled backdrops. Ignored when `imageHref` is filled in. */
  preset?: TicketArtPreset;
  /** A resolved URL for a picture the organiser uploaded. The caller does the gateway lookup. */
  imageHref?: string;
  title: string;
  tierName: string;
  /** Whose ticket it is. Empty draws no line at all — never a placeholder (plan section E-3). */
  holder?: string;
  /** The day the event starts, already formatted for the locale. Empty draws no line at all. */
  dateText?: string;
  used?: boolean;
  /**
   * The event's name has not arrived from the gateway yet, so its line is a shimmer rather than a
   * word — never the fallback, which is what a *failed* read draws. Off by default, so a ticket
   * whose name is known is byte-for-byte the document it always was.
   */
  titleLoading?: boolean;
  /**
   * Whether this ticket should play its backdrop's animation, when it has one. Off by default and
   * left off for every thumbnail, list row and picker tile, so a page of still tickets stays
   * still; a large preview and the ticket detail turn it on. An uploaded picture is never
   * animated, and a backdrop with no `anim` is drawn exactly as it is whatever this says.
   */
  animated?: boolean;
  /**
   * The word across a spent ticket. It is a parameter and not a literal because it is Korean
   * product copy, and product copy lives in the copy modules — this one is `tickets.artUsed`,
   * the same string the picture's accessible name already ends with.
   */
  usedLabel?: string;
}

/** One `<text>`, or nothing at all when there is no string to draw. */
interface LineAttrs {
  x: number;
  y: number;
  size: number;
  weight: number;
  fill: string;
  spacing?: number;
  opacity?: number;
  anchor?: 'start' | 'middle';
}

function line(text: string, attrs: LineAttrs): string {
  if (text === '') return '';
  const spacing = attrs.spacing === undefined ? '' : ` letter-spacing="${attrs.spacing}"`;
  const opacity = attrs.opacity === undefined ? '' : ` opacity="${attrs.opacity}"`;
  const anchor = attrs.anchor === undefined ? '' : ` text-anchor="${attrs.anchor}"`;
  return `<text x="${attrs.x}" y="${attrs.y}" font-family="${FONT_STACK}" font-size="${attrs.size}"`
    + ` font-weight="${attrs.weight}" fill="${attrs.fill}"${spacing}${opacity}${anchor}>`
    + `${escapeXml(text)}</text>`;
}

/**
 * The whole ticket: backdrop, scrim, tear line, stub, and the four strings drawn on top.
 *
 * The scrim is not decoration. Three of the twelve backdrops run bright where the title sits,
 * and the words are white on all twelve — so the gradient is what makes one set of type legible
 * over every picture, an uploaded one included.
 */
export function buildTicketSvg(input: TicketSvgInput): string {
  const {
    preset = 'a', imageHref = '', title, tierName,
    holder = '', dateText = '', used = false, titleLoading = false, animated = false, usedLabel = '',
  } = input;
  const uploaded = imageHref !== '';
  const backdrop = TICKET_BACKDROPS[preset] ?? TICKET_BACKDROPS.a;
  // An animated ticket carries a marker class and an inline `<style>`; a still one carries
  // neither and is byte-for-byte what it always was. The style is scoped under `.ta-live` (see
  // `TicketBackdrop.anim`), so it animates this document alone and never a still one beside it on
  // the page. An uploaded picture has no backdrop animation, so it is never live.
  const anim = uploaded ? undefined : backdrop.anim;
  const live = animated && anim !== undefined;

  // A name still loading draws no words: its line is a shimmer, laid out as one line's worth of room.
  const titleLines = titleLoading ? [] : wrapTitle(title);
  const lineCount = titleLoading ? 1 : titleLines.length;
  const titleTop = TITLE_BASELINE - (lineCount - 1) * TITLE_LINE_HEIGHT - TITLE_SIZE;
  const titleSkeleton = titleLoading
    ? `<rect class="ticket-art__title-skeleton" x="${PAD}" y="${titleTop}"`
      + ` width="${(TICKET_WIDTH - PAD * 2) * 0.62}" height="${TITLE_SIZE}" rx="14"`
      + ' fill="#ffffff" fill-opacity="0.22"/>'
    : '';

  // The stub's lines flow: an empty name does not leave a gap where a name would have been,
  // it lets the date move up into the space. Nothing on this ticket is a placeholder.
  const stubLines = [
    { text: fitLine(holder, HOLDER_SIZE), size: HOLDER_SIZE, weight: 600, fill: '#ffffff' },
    { text: dateText, size: 36, weight: 400, fill: '#aab3c5' },
  ].filter((entry) => entry.text !== '');

  const art = uploaded
    ? `<image href="${escapeXml(imageHref)}" x="0" y="0" width="${TICKET_WIDTH}" height="${TICKET_HEIGHT}"`
      + ' preserveAspectRatio="xMidYMid slice"/>'
    : backdrop.body;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" class="ticket-art__svg${live ? ' ta-live' : ''}"`,
    ` viewBox="0 0 ${TICKET_WIDTH} ${TICKET_HEIGHT}" preserveAspectRatio="xMidYMid slice"`,
    ' width="100%" height="100%" focusable="false"',
    uploaded ? '' : ` data-preset="${preset}"`,
    '>',

    '<defs>',
    uploaded ? '' : backdrop.defs,
    '<linearGradient id="ta-scrim" x1="0" y1="0" x2="0" y2="1">',
    '<stop offset="0" stop-color="#08090c" stop-opacity="0"/>',
    '<stop offset="1" stop-color="#08090c" stop-opacity="0.88"/>',
    '</linearGradient>',
    '</defs>',

    // The animation, scoped under `.ta-live`, so a still ticket on the same page cannot pick it up.
    live ? `<style>${anim}</style>` : '',

    `<g class="ticket-art__backdrop"${used ? ` style="filter: ${USED_FILTER}"` : ''}>${art}</g>`,

    `<rect class="ticket-art__scrim" x="0" y="560" width="${TICKET_WIDTH}" height="620" fill="url(#ta-scrim)"/>`,
    `<rect class="ticket-art__stub" x="0" y="${PERFORATION_Y}" width="${TICKET_WIDTH}"`,
    ` height="${TICKET_HEIGHT - PERFORATION_Y}" fill="#0a0c11" opacity="0.9"/>`,

    // The tear: a dashed rule between two bites taken out of the edges.
    `<path class="ticket-art__perforation" d="M60 ${PERFORATION_Y}H940" stroke="#ffffff"`,
    ' stroke-opacity="0.5" stroke-width="5" stroke-dasharray="20 18"/>',
    `<circle cx="0" cy="${PERFORATION_Y}" r="30" fill="#0a0c11"/>`,
    `<circle cx="${TICKET_WIDTH}" cy="${PERFORATION_Y}" r="30" fill="#0a0c11"/>`,

    line('MONTI', { x: PAD, y: 130, size: 38, weight: 700, fill: '#ffffff', spacing: 10, opacity: 0.85 }),
    line(fitLine(tierName, TIER_SIZE, TIER_SPACING), {
      x: PAD, y: titleTop - TIER_GAP, size: TIER_SIZE, weight: 600, fill: '#cfd6e4',
      spacing: TIER_SPACING,
    }),
    titleSkeleton,
    ...titleLines.map((text, at) =>
      line(text, {
        x: PAD,
        y: TITLE_BASELINE - (titleLines.length - 1 - at) * TITLE_LINE_HEIGHT,
        size: TITLE_SIZE, weight: 700, fill: '#ffffff',
      })),
    ...stubLines.map((entry, at) =>
      line(entry.text, {
        x: PAD, y: STUB_FIRST_BASELINE + at * STUB_LINE_STEP,
        size: entry.size, weight: entry.weight, fill: entry.fill,
      })),

    used
      ? '<g class="ticket-art__band" transform="rotate(-16 500 700)">'
        + '<rect x="-140" y="630" width="1280" height="142" fill="#d92d20"/>'
        + line(usedLabel, {
          x: 500, y: 726, size: 78, weight: 700, fill: '#ffffff', spacing: 22, anchor: 'middle',
        })
        + '</g>'
      : '',
    '</svg>',
  ].join('');
}
