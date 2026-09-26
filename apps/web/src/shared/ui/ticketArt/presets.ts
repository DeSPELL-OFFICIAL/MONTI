import type { TicketArtPreset } from '../TicketArt';

/**
 * The frame every ticket is drawn in. It is a portrait 5:8 rather than the A4 the poster uses,
 * because this is a ticket and not a page: the extra height is the stub below the tear line.
 * A picture the organiser uploaded was cropped to A4 and is placed with `slice`, so it fills
 * the frame and loses a sliver of its sides rather than being letterboxed inside it.
 */
export const TICKET_WIDTH = 1000;
export const TICKET_HEIGHT = 1600;

/**
 * One backdrop, split the way SVG needs it: `defs` are hoisted into the single `<defs>` of the
 * built document, `body` is painted over the whole frame. Every id inside is prefixed with the
 * preset's own letter, so twelve of these could share one document without colliding.
 */
export interface TicketBackdrop {
  defs: string;
  body: string;
}

/**
 * The twelve bundled backdrops, as markup rather than as files.
 *
 * They used to be four `.svg` files under `src/assets/ticket-art` that Vite bundled and an
 * `<img src>` pointed at. Markup instead, for two reasons the plan spells out (section E-1):
 * a ticket rasterised from this document must never issue a network request for its own
 * background, and whether a bundled file arrives as a data URI or as a second request is
 * Vite's `assetsInlineLimit` talking, not a decision this screen should be resting on.
 *
 * Twelve letters, not the plan's eight: the backend shipped `ART_PRESETS = a..l` and the
 * Firestore rule validates `^[a-l]$`, so this is the alphabet the stored document may hold.
 * Each one has to be *visibly* different — what a draft stores is the letter, so a letter that
 * quietly fell through to another one's picture would be silent everywhere but the eye.
 */
export const TICKET_BACKDROPS: Record<TicketArtPreset, TicketBackdrop> = {
  // a — aurora over a night sky.
  a: {
    defs:
      '<linearGradient id="ta-a-sky" x1="0" y1="0" x2="0.35" y2="1">'
      + '<stop offset="0" stop-color="#0a0f2e"/><stop offset="0.55" stop-color="#241f6b"/>'
      + '<stop offset="1" stop-color="#0c3f52"/></linearGradient>'
      + '<linearGradient id="ta-a-veil" x1="0" y1="0" x2="1" y2="0">'
      + '<stop offset="0" stop-color="#4f7dff" stop-opacity="0"/>'
      + '<stop offset="0.45" stop-color="#6ee7ff" stop-opacity="0.9"/>'
      + '<stop offset="1" stop-color="#a06bff" stop-opacity="0"/></linearGradient>'
      + '<filter id="ta-a-soft" x="-30%" y="-30%" width="160%" height="160%">'
      + '<feGaussianBlur stdDeviation="44"/></filter>',
    body:
      '<rect width="1000" height="1600" fill="url(#ta-a-sky)"/>'
      + '<g filter="url(#ta-a-soft)">'
      + '<path d="M-120 430C200 230 430 610 1120 300L1120 560C430 860 200 470 -120 690Z" fill="url(#ta-a-veil)"/>'
      + '<path d="M-120 790C240 590 540 950 1120 680L1120 880C540 1150 240 820 -120 1000Z" fill="url(#ta-a-veil)" opacity="0.6"/>'
      + '</g>'
      + '<g fill="#ffffff" opacity="0.34"><circle cx="170" cy="240" r="3"/><circle cx="325" cy="160" r="2"/>'
      + '<circle cx="520" cy="275" r="3.5"/><circle cx="700" cy="195" r="2.5"/><circle cx="865" cy="335" r="3"/>'
      + '<circle cx="130" cy="410" r="2"/><circle cx="615" cy="120" r="2"/><circle cx="820" cy="105" r="3"/></g>',
  },

  // b — embers rising out of the dark.
  b: {
    defs:
      '<radialGradient id="ta-b-glow" cx="0.5" cy="0.88" r="0.9">'
      + '<stop offset="0" stop-color="#ff7a18"/><stop offset="0.42" stop-color="#a51e0f"/>'
      + '<stop offset="1" stop-color="#170604" stop-opacity="0"/></radialGradient>',
    body:
      '<rect width="1000" height="1600" fill="#170604"/>'
      + '<rect width="1000" height="1600" fill="url(#ta-b-glow)"/>'
      + '<g fill="#ffd8a8" opacity="0.55"><circle cx="180" cy="900" r="6"/><circle cx="300" cy="700" r="4"/>'
      + '<circle cx="430" cy="1010" r="5"/><circle cx="560" cy="780" r="3"/><circle cx="690" cy="930" r="6"/>'
      + '<circle cx="820" cy="690" r="4"/><circle cx="905" cy="1040" r="3"/><circle cx="240" cy="560" r="3"/>'
      + '<circle cx="640" cy="520" r="4"/><circle cx="770" cy="430" r="2.5"/></g>',
  },

  // c — teal, with rings spreading out of one point.
  c: {
    defs:
      '<linearGradient id="ta-c-bg" x1="0" y1="0" x2="0.3" y2="1">'
      + '<stop offset="0" stop-color="#04231f"/><stop offset="1" stop-color="#0d6b5c"/></linearGradient>',
    body:
      '<rect width="1000" height="1600" fill="url(#ta-c-bg)"/>'
      + '<g fill="none" stroke="#7ff0d4" stroke-opacity="0.3" stroke-width="7">'
      + '<circle cx="500" cy="500" r="130"/><circle cx="500" cy="500" r="245"/><circle cx="500" cy="500" r="375"/>'
      + '<circle cx="500" cy="500" r="520"/><circle cx="500" cy="500" r="680"/></g>'
      + '<circle cx="500" cy="500" r="58" fill="#7ff0d4" opacity="0.45"/>',
  },

  // d — the sun going down behind a banded horizon.
  d: {
    defs:
      '<linearGradient id="ta-d-bg" x1="0" y1="0" x2="0" y2="1">'
      + '<stop offset="0" stop-color="#2b1055"/><stop offset="0.55" stop-color="#7b2d6b"/>'
      + '<stop offset="1" stop-color="#f0794b"/></linearGradient>',
    body:
      '<rect width="1000" height="1600" fill="url(#ta-d-bg)"/>'
      + '<circle cx="500" cy="620" r="205" fill="#ffd27d" opacity="0.9"/>'
      + '<g fill="#2b1055" opacity="0.55"><rect x="270" y="628" width="460" height="14"/>'
      + '<rect x="270" y="666" width="460" height="20"/><rect x="270" y="712" width="460" height="26"/>'
      + '<rect x="270" y="766" width="460" height="34"/></g>'
      + '<rect y="812" width="1000" height="6" fill="#ffd27d" opacity="0.6"/>',
  },

  // e — a neon grid running to a vanishing point.
  e: {
    defs:
      '<linearGradient id="ta-e-bg" x1="0" y1="0" x2="0" y2="1">'
      + '<stop offset="0" stop-color="#05061a"/><stop offset="0.5" stop-color="#170a35"/>'
      + '<stop offset="1" stop-color="#2a0b42"/></linearGradient>',
    body:
      '<rect width="1000" height="1600" fill="url(#ta-e-bg)"/>'
      + '<circle cx="500" cy="720" r="150" fill="#ff2fb0" opacity="0.55"/>'
      + '<g stroke="#38f2ff" stroke-opacity="0.45" stroke-width="4">'
      + '<path d="M500 820L-700 1600M500 820L-220 1600M500 820L140 1600M500 820L500 1600'
      + 'M500 820L860 1600M500 820L1220 1600M500 820L1700 1600"/>'
      + '<path d="M0 858H1000M0 906H1000M0 972H1000M0 1064H1000M0 1196H1000M0 1386H1000"/></g>',
  },

  // f — confetti over a deep violet.
  f: {
    defs:
      '<linearGradient id="ta-f-bg" x1="0" y1="0" x2="0.4" y2="1">'
      + '<stop offset="0" stop-color="#1b0f3a"/><stop offset="1" stop-color="#4b1f7a"/></linearGradient>',
    body:
      '<rect width="1000" height="1600" fill="url(#ta-f-bg)"/>'
      + '<g opacity="0.9">'
      + '<rect x="120" y="180" width="46" height="18" rx="4" fill="#ffd166" transform="rotate(24 143 189)"/>'
      + '<rect x="320" y="120" width="38" height="16" rx="4" fill="#06d6a0" transform="rotate(-38 339 128)"/>'
      + '<rect x="560" y="220" width="52" height="18" rx="4" fill="#ef476f" transform="rotate(12 586 229)"/>'
      + '<rect x="790" y="140" width="40" height="16" rx="4" fill="#4cc9f0" transform="rotate(-18 810 148)"/>'
      + '<rect x="200" y="420" width="44" height="18" rx="4" fill="#ef476f" transform="rotate(-52 222 429)"/>'
      + '<rect x="470" y="380" width="36" height="16" rx="4" fill="#ffd166" transform="rotate(64 488 388)"/>'
      + '<rect x="720" y="450" width="50" height="18" rx="4" fill="#06d6a0" transform="rotate(-8 745 459)"/>'
      + '<rect x="90" y="640" width="38" height="16" rx="4" fill="#4cc9f0" transform="rotate(36 109 648)"/>'
      + '<rect x="380" y="620" width="48" height="18" rx="4" fill="#ffd166" transform="rotate(-24 404 629)"/>'
      + '<rect x="640" y="690" width="40" height="16" rx="4" fill="#ef476f" transform="rotate(48 660 698)"/>'
      + '<rect x="860" y="600" width="44" height="18" rx="4" fill="#06d6a0" transform="rotate(-62 882 609)"/>'
      + '<rect x="250" y="850" width="42" height="16" rx="4" fill="#4cc9f0" transform="rotate(16 271 858)"/>'
      + '<rect x="540" y="900" width="46" height="18" rx="4" fill="#ffd166" transform="rotate(-44 563 909)"/>'
      + '<rect x="810" y="860" width="38" height="16" rx="4" fill="#ef476f" transform="rotate(28 829 868)"/>'
      + '</g>',
  },

  // g — layered water.
  g: {
    defs:
      '<linearGradient id="ta-g-bg" x1="0" y1="0" x2="0" y2="1">'
      + '<stop offset="0" stop-color="#021b3a"/><stop offset="1" stop-color="#063f78"/></linearGradient>',
    body:
      '<rect width="1000" height="1600" fill="url(#ta-g-bg)"/>'
      + '<path d="M0 560C200 480 320 640 520 580S820 500 1000 570V1600H0Z" fill="#0a5ca8" opacity="0.55"/>'
      + '<path d="M0 720C220 650 360 810 560 750S840 680 1000 740V1600H0Z" fill="#1279cf" opacity="0.5"/>'
      + '<path d="M0 900C180 830 380 980 580 920S850 860 1000 910V1600H0Z" fill="#2f9bea" opacity="0.45"/>'
      + '<path d="M0 1080C240 1010 400 1150 620 1090S880 1040 1000 1080V1600H0Z" fill="#69c3f5" opacity="0.4"/>',
  },

  // h — a sunburst out of the top of the frame.
  h: {
    defs:
      '<linearGradient id="ta-h-bg" x1="0" y1="0" x2="0" y2="1">'
      + '<stop offset="0" stop-color="#b8480c"/><stop offset="0.55" stop-color="#7a2408"/>'
      + '<stop offset="1" stop-color="#2b0d05"/></linearGradient>',
    body:
      '<rect width="1000" height="1600" fill="url(#ta-h-bg)"/>'
      + '<g fill="#fff3c4" opacity="0.16">'
      + '<polygon points="500,150 410,1800 590,1800"/>'
      + '<polygon points="500,150 410,1800 590,1800" transform="rotate(-72 500 150)"/>'
      + '<polygon points="500,150 410,1800 590,1800" transform="rotate(-54 500 150)"/>'
      + '<polygon points="500,150 410,1800 590,1800" transform="rotate(-36 500 150)"/>'
      + '<polygon points="500,150 410,1800 590,1800" transform="rotate(-18 500 150)"/>'
      + '<polygon points="500,150 410,1800 590,1800" transform="rotate(18 500 150)"/>'
      + '<polygon points="500,150 410,1800 590,1800" transform="rotate(36 500 150)"/>'
      + '<polygon points="500,150 410,1800 590,1800" transform="rotate(54 500 150)"/>'
      + '<polygon points="500,150 410,1800 590,1800" transform="rotate(72 500 150)"/></g>'
      + '<circle cx="500" cy="150" r="120" fill="#ffe08a" opacity="0.5"/>',
  },

  // i — soft haze on slate.
  i: {
    defs:
      '<filter id="ta-i-soft" x="-40%" y="-40%" width="180%" height="180%">'
      + '<feGaussianBlur stdDeviation="110"/></filter>',
    body:
      '<rect width="1000" height="1600" fill="#161a24"/>'
      + '<g filter="url(#ta-i-soft)" opacity="0.7">'
      + '<circle cx="240" cy="330" r="230" fill="#7c6cf0"/>'
      + '<circle cx="790" cy="520" r="280" fill="#2f8f9d"/>'
      + '<circle cx="380" cy="860" r="250" fill="#c25e8f"/>'
      + '<circle cx="880" cy="1080" r="210" fill="#4a6ff0"/></g>',
  },

  // j — broad diagonal bars.
  j: {
    defs:
      '<pattern id="ta-j-bars" width="180" height="180" patternUnits="userSpaceOnUse" patternTransform="rotate(35)">'
      + '<rect width="180" height="180" fill="#10131c"/>'
      + '<rect width="90" height="180" fill="#f2b705"/></pattern>',
    body:
      '<rect width="1000" height="1600" fill="url(#ta-j-bars)"/>'
      + '<rect width="1000" height="1600" fill="#0b0d14" opacity="0.3"/>',
  },

  // k — a halftone field over green.
  k: {
    defs:
      '<linearGradient id="ta-k-bg" x1="0" y1="0" x2="0.35" y2="1">'
      + '<stop offset="0" stop-color="#062b18"/><stop offset="1" stop-color="#0e5c33"/></linearGradient>'
      + '<pattern id="ta-k-dots" width="80" height="80" patternUnits="userSpaceOnUse">'
      + '<circle cx="20" cy="20" r="11" fill="#5ef0a6" fill-opacity="0.45"/>'
      + '<circle cx="60" cy="60" r="6" fill="#5ef0a6" fill-opacity="0.28"/></pattern>',
    body:
      '<rect width="1000" height="1600" fill="url(#ta-k-bg)"/>'
      + '<rect width="1000" height="1600" fill="url(#ta-k-dots)"/>',
  },

  // l — traces and nodes on charcoal.
  l: {
    defs: '',
    body:
      '<rect width="1000" height="1600" fill="#0d1017"/>'
      + '<g fill="none" stroke="#5be0ff" stroke-opacity="0.38" stroke-width="5" stroke-linecap="square">'
      + '<path d="M60 200H340V420H620V240H940"/>'
      + '<path d="M60 560H220V760H520V620H880V900"/>'
      + '<path d="M120 1020H400V860H700V1080H940"/>'
      + '<path d="M60 1240H300V1120H560V1320H820V1160"/></g>'
      + '<g fill="#5be0ff" opacity="0.7"><circle cx="340" cy="420" r="12"/><circle cx="620" cy="240" r="12"/>'
      + '<circle cx="520" cy="620" r="12"/><circle cx="880" cy="900" r="12"/><circle cx="400" cy="860" r="12"/>'
      + '<circle cx="700" cy="1080" r="12"/><circle cx="560" cy="1320" r="12"/><circle cx="820" cy="1160" r="12"/></g>',
  },
};
