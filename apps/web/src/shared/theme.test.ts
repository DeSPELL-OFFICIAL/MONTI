// @vitest-environment node
//
// Nothing here renders: the file reads `theme.css` off disk and does WCAG arithmetic on it.
// Node rather than jsdom so `import.meta.url` is a real file URL (see hosting.test.ts).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The palette's arithmetic, done where it can fail the build.
 *
 * Glass is the one thing in this design that can quietly go unreadable: a pane is part of what
 * is behind it, so a token that reads fine on paper can land at 3:1 over the purple corner of
 * the page. jsdom paints nothing and measures nothing, so a rendering test could not catch
 * that — but the numbers are in `theme.css`, and WCAG's contrast formula is fifteen lines.
 *
 * So this reads the stylesheet as the source of truth, rebuilds the worst-case background a
 * word can sit on (the most purple spot of the page gradient, seen through a 62% white pane),
 * and holds every text token to 4.5:1 against it. It also pins the legacy token names, because
 * the whole app was restyled by aliasing them rather than by renaming them in ninety files.
 */

const CSS = readFileSync(fileURLToPath(new URL('./theme.css', import.meta.url)), 'utf8');

/** The `:root` block's custom properties, with one level of `var()` resolved. */
function tokens(): Map<string, string> {
  const block = /:root\s*\{([\s\S]*?)\n\}/.exec(CSS)?.[1];
  if (block === undefined) throw new Error('theme.css has no :root block');
  const raw = new Map<string, string>();
  for (const line of block.split('\n')) {
    const match = /^\s*(--[a-z0-9-]+)\s*:\s*([^;]+);/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) raw.set(match[1], match[2].trim());
  }
  const resolve = (value: string, depth = 0): string => {
    if (depth > 8) throw new Error(`token cycle at ${value}`);
    return value.replace(/var\((--[a-z0-9-]+)\)/g, (_, name: string) => {
      const found = raw.get(name);
      if (found === undefined) throw new Error(`theme.css uses undefined ${name}`);
      return resolve(found, depth + 1);
    });
  };
  return new Map([...raw].map(([name, value]) => [name, resolve(value)]));
}

const TOKENS = tokens();

type Rgb = readonly [number, number, number];

function hex(value: string): Rgb {
  const match = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (match?.[1] === undefined) throw new Error(`not a six-digit hex colour: ${value}`);
  const n = Number.parseInt(match[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function token(name: string): Rgb {
  const value = TOKENS.get(name);
  if (value === undefined) throw new Error(`theme.css defines no ${name}`);
  return hex(value);
}

/** `over` seen through `top` at `alpha`. Source-over, which is what a browser does. */
function blend(top: Rgb, alpha: number, over: Rgb): Rgb {
  const mix = (a: number, b: number): number => a * alpha + b * (1 - alpha);
  return [mix(top[0], over[0]), mix(top[1], over[1]), mix(top[2], over[2])];
}

function luminance(colour: Rgb): number {
  const channel = (raw: number): number => {
    const c = raw / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(colour[0]) + 0.7152 * channel(colour[1]) + 0.0722 * channel(colour[2]);
}

function contrast(a: Rgb, b: Rgb): number {
  const one = luminance(a);
  const two = luminance(b);
  return (Math.max(one, two) + 0.05) / (Math.min(one, two) + 0.05);
}

const WHITE: Rgb = [255, 255, 255];

/**
 * The worst background a word on glass can get: the top-left of the page, where the purple
 * radial is at its full 22% over the lighter end of the wash, with the 62% white pane over it.
 * Everywhere else on the page is lighter than this, so clearing it clears the app.
 */
const PAGE_WORST = blend(token('--brand'), 0.22, hex('#F7F5FF'));
const GLASS_WORST = blend(WHITE, 0.62, PAGE_WORST);
/** Where `backdrop-filter` does not exist and the pane becomes a flat card instead. */
const GLASS_FALLBACK = token('--glass-solid');

describe('theme tokens', () => {
  it('keeps every legacy token name resolving, so no screen had to be renamed', () => {
    for (const name of ['--bg', '--surface', '--line', '--text', '--muted', '--accent',
      '--danger', '--warn', '--radius', '--tabbar-h', '--sticky-bar-h']) {
      expect(TOKENS.get(name), name).toBeTruthy();
    }
    // The aliases point at the new palette rather than at a second copy of the old one.
    expect(TOKENS.get('--text')).toBe(TOKENS.get('--ink'));
    expect(TOKENS.get('--muted')).toBe(TOKENS.get('--ink-2'));
    expect(TOKENS.get('--accent')).toBe(TOKENS.get('--brand-ink'));
    expect(TOKENS.get('--surface')).toBe(TOKENS.get('--glass-bg'));
  });

  it('is the light palette Monad reads as', () => {
    expect(TOKENS.get('--brand')).toBe('#836EF9');
    expect(CSS).toMatch(/color-scheme:\s*light/);
    // Light enough to be a tint rather than a colour of its own.
    expect(luminance(token('--bg'))).toBeGreaterThan(0.8);
    expect(luminance(token('--bg-deep'))).toBeGreaterThan(0.75);
  });

  it.each([
    ['--ink', 4.5],
    ['--ink-2', 4.5],
    ['--brand-ink', 4.5],
    ['--danger', 4.5],
    ['--warn', 4.5],
    ['--success', 4.5],
  ])('%s clears %s:1 on glass, over the purplest part of the page', (name, floor) => {
    expect(contrast(token(name), GLASS_WORST)).toBeGreaterThanOrEqual(floor);
    expect(contrast(token(name), GLASS_FALLBACK)).toBeGreaterThanOrEqual(floor);
  });

  /**
   * The reason `--brand` never carries words: white on it is 3.8:1. The filled button is a
   * gradient, and a gradient is only as readable as its lightest pixel — which is why it runs
   * from `--brand-soft` and not from `--brand`.
   */
  it('keeps white legible on every filled purple', () => {
    expect(contrast(WHITE, token('--brand'))).toBeLessThan(4.5);
    expect(CSS).toMatch(/--brand-grad:\s*linear-gradient\(135deg, var\(--brand-soft\) 0%, var\(--brand-strong\) 100%\)/);
    expect(contrast(WHITE, token('--brand-soft'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(WHITE, token('--brand-strong'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(WHITE, token('--danger'))).toBeGreaterThanOrEqual(4.5);
  });

  /**
   * The tab bar's pressed pill: `--brand-tint-strong` (a 20% wash of the accent) on the bar's
   * own heavier glass, with `--brand-ink` lettering on top. Three translucent layers deep is
   * exactly where a palette stops being legible by inspection, so it is computed.
   */
  it('keeps the active tab label legible on its pill', () => {
    const bar = blend(WHITE, 0.78, PAGE_WORST);
    const pill = blend(token('--brand'), 0.2, bar);
    expect(contrast(token('--brand-ink'), pill)).toBeGreaterThanOrEqual(4.5);
  });

  it('respects a phone: 16px fields, 44px targets, safe areas and reduced motion', () => {
    expect(TOKENS.get('--t-input')).toBe('16px');
    expect(TOKENS.get('--tap')).toBe('44px');
    expect(TOKENS.get('--sab')).toBe('env(safe-area-inset-bottom, 0px)');
    expect(CSS).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    // The three things pinned to the bottom of the screen all pad for the home bar.
    for (const rule of ['.tabbar', '.fab', '.sticky-bar']) {
      const block = new RegExp(`\\${rule}\\s*\\{[^}]*var\\(--sab\\)`).test(CSS);
      expect(block, `${rule} pads for the safe area`).toBe(true);
    }
  });

  it('gives glass an opaque fallback where backdrop-filter is missing', () => {
    expect(CSS).toMatch(/@supports not \(\(backdrop-filter: blur\(1px\)\) or \(-webkit-backdrop-filter: blur\(1px\)\)\)/);
    expect(TOKENS.get('--glass-blur')).toBe('blur(16px) saturate(140%)');
    expect(TOKENS.get('--glass-border')).toBe('rgba(255, 255, 255, 0.60)');
    expect(TOKENS.get('--glass-shadow')).toBe('0 8px 24px rgba(131, 110, 249, 0.12)');
  });

  /**
   * A list row is a flat card, not glass. Discover, the tickets list and the organiser home each
   * stack 20+ `.event-list > li`, and one `backdrop-filter` per row is 20+ live blur layers over
   * the page — so the row is off the recipe and takes the opaque `--glass-solid` instead.
   */
  it('keeps list rows off the blur recipe, so a long list is not a stack of blur layers', () => {
    // The glass recipe is the one rule that sets the pane background and the blur together.
    const recipe = /([^{}]*)\{\s*background:\s*var\(--glass-bg\);\s*-webkit-backdrop-filter:\s*var\(--glass-blur\)/.exec(CSS);
    expect(recipe, 'the glass recipe rule is still in theme.css').not.toBeNull();
    expect(recipe?.[1]).not.toMatch(/\.event-list\s*>\s*li/);
    // The row is still a card: the flat opaque surface the fallback gives every pane.
    expect(CSS).toMatch(/\.event-list\s*>\s*li\s*\{[^}]*background:\s*var\(--glass-solid\)/);
  });
});

/**
 * Tap-target floors (expert-4 D1/D6). jsdom measures nothing, so — like the contrast tests above —
 * these read the geometry out of `theme.css` rather than off a rendered node. `--tap` is 44px.
 */
describe('tap targets on a phone (expert-4 D1/D6)', () => {
  /** A rule's declaration block, by its exact selector. */
  function rule(selector: string): string {
    const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`${esc}\\s*\\{([^}]*)\\}`).exec(CSS);
    if (match?.[1] === undefined) throw new Error(`theme.css has no rule for ${selector}`);
    return match[1];
  }

  it('makes the whole explore card the tap target, not the 20px title link', () => {
    const card = rule('.event-card');
    expect(card).toMatch(/position:\s*relative/);
    expect(card).toMatch(/min-height:\s*var\(--tap\)/);
    // The title link is stretched over the card, so the picture and body are live too.
    const stretch = rule('.event-card__title a::after');
    expect(stretch).toMatch(/position:\s*absolute/);
    expect(stretch).toMatch(/inset:\s*0/);
  });

  it('holds the price badge and the kind edit button to the 44px target', () => {
    expect(rule('.tier-preview__badge')).toMatch(/min-height:\s*var\(--tap\)/);
    const edit = rule('.tier-card__head .btn');
    expect(edit).toMatch(/height:\s*var\(--tap\)/);
    expect(edit).not.toMatch(/36px/);
  });
});
