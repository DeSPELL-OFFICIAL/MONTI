import { describe, expect, it } from 'vitest';
import { buildTicketSvg, escapeXml, fitLine, textWidth, wrapTitle } from './ticketArt/buildTicketSvg';
import { TICKET_BACKDROPS } from './ticketArt/presets';

/**
 * The wrap is the one part of a ticket that can be wrong in a way nobody notices until a long
 * Korean title is already on somebody's phone, and the only part that can be checked without a
 * browser at all — SVG `<text>` does not wrap, so this function *is* the layout.
 *
 * A generous width is used below where the assertion is about breaking rather than about the
 * exact count, so these tests keep saying what they mean if the frame's padding ever changes.
 */
describe('wrapTitle', () => {
  it('counts Korean as a full em and ASCII as a little over half of one', () => {
    expect(textWidth('재즈')).toBeCloseTo(2);
    expect(textWidth('jazz')).toBeCloseTo(2.2);
    // Mixed: three Korean, one space, four ASCII.
    expect(textWidth('재즈나이 jazz')).toBeCloseTo(4 + 0.55 * 5);
  });

  it('keeps a title that fits on one line', () => {
    expect(wrapTitle('재즈 나이트', 12)).toEqual(['재즈 나이트']);
  });

  it('breaks pure Korean where the line runs out, since Korean has no spaces to prefer', () => {
    // Ten characters of room, twelve characters of title.
    expect(wrapTitle('한여름밤의재즈페스티벌입니다', 10, 2)).toEqual(['한여름밤의재즈페스티', '벌입니다']);
  });

  it('breaks pure ASCII at a space rather than inside a word', () => {
    // 'Midsummer N' would fit in six ems; the break moves back to the space instead.
    expect(wrapTitle('Midsummer Night Jazz', 6, 2)).toEqual(['Midsummer', 'Night Jazz']);
  });

  it('breaks a mixed title without losing the boundary between the two scripts', () => {
    expect(wrapTitle('한여름 밤의 Midsummer Jazz', 8, 2)).toEqual(['한여름 밤의', 'Midsummer Jazz']);
  });

  it('fills exactly two lines when that is exactly what there is', () => {
    const lines = wrapTitle('가나다라마바사아자차카타', 6, 2);
    expect(lines).toEqual(['가나다라마바', '사아자차카타']);
    expect(lines.every((line) => textWidth(line) <= 6)).toBe(true);
  });

  /** Two lines and an ellipsis, never a third line and never a frame the title grows out of. */
  it('ellipsises what will not fit in two lines', () => {
    const lines = wrapTitle('가나다라마바사아자차카타파하거너더러', 6, 2);
    expect(lines).toHaveLength(2);
    expect(lines[1]?.endsWith('…')).toBe(true);
    expect(lines.every((line) => textWidth(line) <= 6)).toBe(true);
  });

  it('draws nothing for a title that is empty or only whitespace', () => {
    expect(wrapTitle('', 12)).toEqual([]);
    expect(wrapTitle('   \n ', 12)).toEqual([]);
  });

  /** A single character wider than the whole line still has to move the cursor, or this loops. */
  it('terminates on a line too narrow for even one character', () => {
    expect(wrapTitle('가나다라', 0.5, 2)).toEqual(['가', '…']);
  });
});

/**
 * The two strings the layout gives one line each and no line beneath: the ticket kind and the
 * name on the stub. Both start at the left margin (72) of a 1000-unit frame, so both have 928
 * units and nothing to wrap into — and both have a cap that is comfortably past 928 in Korean.
 */
describe('fitLine', () => {
  /** `MAX_DISPLAY_NAME_CHARS` is 24 and the name is drawn at 46: `24 x 46 = 1104`. */
  it('ellipsises a display name at its cap and keeps it inside the frame', () => {
    const fitted = fitLine('가'.repeat(24), 46);
    expect(fitted.endsWith('…')).toBe(true);
    expect(textWidth(fitted) * 46).toBeLessThanOrEqual(928);
  });

  /** The kind is drawn at 34 with 4 of tracking, so every character costs 38: `40 x 38 = 1520`. */
  it('ellipsises a ticket kind at its cap, tracking included', () => {
    const fitted = fitLine('종'.repeat(40), 34, 4);
    expect(fitted.endsWith('…')).toBe(true);
    expect(textWidth(fitted) * (34 + 4)).toBeLessThanOrEqual(928);
  });

  it('leaves a name and a kind that already fit exactly as they are', () => {
    expect(fitLine('김태완', 46)).toBe('김태완');
    expect(fitLine('일반', 34, 4)).toBe('일반');
    expect(fitLine('Taewan Kim', 46)).toBe('Taewan Kim');
  });

  /** An empty string is no line at all, and must not become a lone ellipsis. */
  it('leaves an empty string empty', () => {
    expect(fitLine('', 46)).toBe('');
  });
});

describe('escapeXml', () => {
  it('escapes every character that could end an attribute or open an element', () => {
    expect(escapeXml('<script>alert("x" & \'y\')</script>')).toBe(
      '&lt;script&gt;alert(&quot;x&quot; &amp; &apos;y&apos;)&lt;/script&gt;',
    );
  });

  it('escapes the ampersand first, so an escape is never escaped twice', () => {
    expect(escapeXml('&lt;')).toBe('&amp;lt;');
  });
});

describe('buildTicketSvg', () => {
  const base = { title: '재즈 나이트', tierName: '일반' };

  it('draws one document per preset and no two of the twelve alike', () => {
    const drawings = Object.keys(TICKET_BACKDROPS).map((preset) =>
      buildTicketSvg({ ...base, preset: preset as 'a' }));
    expect(drawings).toHaveLength(12);
    expect(new Set(drawings).size).toBe(12);
  });

  it('names the letter it drew, so a stored preset can be read back off the picture', () => {
    expect(buildTicketSvg({ ...base, preset: 'g' })).toContain('data-preset="g"');
  });

  /** A picture the organiser uploaded is the backdrop; there is no letter to name. */
  it('places an uploaded picture as the backdrop and names no preset', () => {
    const svg = buildTicketSvg({ ...base, imageHref: 'https://gw.test/bafkmine' });
    expect(svg).toContain('<image href="https://gw.test/bafkmine"');
    expect(svg).not.toContain('data-preset');
  });

  it('carries the event, the kind, the holder and the date', () => {
    const svg = buildTicketSvg({ ...base, holder: '김태완', dateText: '2026. 10. 13.' });
    for (const text of ['재즈 나이트', '일반', '김태완', '2026. 10. 13.']) {
      expect(svg).toContain(`>${text}</text>`);
    }
  });

  /** Both at their caps: neither may reach the frame's right edge and be cut mid-character. */
  it('cuts a capped holder and a capped kind rather than running them off the frame', () => {
    const holder = '가'.repeat(24);
    const tierName = '종'.repeat(40);
    const svg = buildTicketSvg({ title: '재즈 나이트', tierName, holder });
    expect(svg).not.toContain(`>${holder}</text>`);
    expect(svg).not.toContain(`>${tierName}</text>`);
    const drawn = [...svg.matchAll(/>([^<>]+)<\/text>/g)].map((hit) => hit[1] as string);
    const holderLine = drawn.find((text) => text.startsWith('가'));
    const tierLine = drawn.find((text) => text.startsWith('종'));
    expect(holderLine?.endsWith('…')).toBe(true);
    expect(tierLine?.endsWith('…')).toBe(true);
    expect(textWidth(holderLine ?? '') * 46).toBeLessThanOrEqual(928);
    expect(textWidth(tierLine ?? '') * (34 + 4)).toBeLessThanOrEqual(928);
  });

  it('draws no line at all for a holder or a date that is not there', () => {
    const svg = buildTicketSvg({ ...base, holder: '', dateText: '' });
    // Four `<text>` runs would be the wordmark, the kind and one title line — the two missing
    // strings leave nothing behind, not an empty box and not a placeholder.
    expect(svg.match(/<text /g)).toHaveLength(3);
  });

  it('greys the backdrop and bands the ticket only once it has been used', () => {
    const clean = buildTicketSvg({ ...base, usedLabel: '사용됨' });
    expect(clean).not.toContain('grayscale');
    expect(clean).not.toContain('사용됨');

    const spent = buildTicketSvg({ ...base, used: true, usedLabel: '사용됨' });
    expect(spent).toContain('filter: grayscale(1) contrast(.9)');
    expect(spent).toContain('사용됨');
  });

  /** The words are white on all twelve backdrops; the scrim is what makes that legible. */
  it('always lays a scrim and a tear line under the words', () => {
    const svg = buildTicketSvg(base);
    expect(svg).toContain('ticket-art__scrim');
    expect(svg).toContain('ticket-art__perforation');
    expect(svg).toContain('ticket-art__stub');
  });

  it('names the Korean fallback chain on every string it draws', () => {
    const svg = buildTicketSvg({ ...base, holder: '김태완', dateText: '2026. 10. 13.' });
    const faces = svg.match(/font-family="[^"]+"/g) ?? [];
    expect(faces.length).toBeGreaterThan(0);
    expect(new Set(faces).size).toBe(1);
    expect(faces[0]).toContain("'Apple SD Gothic Neo'");
    expect(faces[0]).toContain("'Noto Sans KR'");
  });

  /**
   * The title, the kind and the name are all user input and the result goes straight into
   * `dangerouslySetInnerHTML`. This is the assertion that keeps that safe.
   */
  it('escapes every interpolated string', () => {
    const svg = buildTicketSvg({
      title: '<script>alert(1)</script>',
      tierName: 'A & B',
      holder: '"quoted"',
      dateText: "it's today",
      imageHref: 'https://gw.test/a"onerror="x',
    });
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
    expect(svg).toContain('A &amp; B');
    expect(svg).toContain('&quot;quoted&quot;');
    expect(svg).toContain('it&apos;s today');
    expect(svg).toContain('href="https://gw.test/a&quot;onerror=&quot;x"');
  });

  /** Twelve letters, because the server's `ART_PRESETS` and the Firestore rule both say `a`-`l`. */
  it('bundles exactly the twelve letters the stored preset may hold', () => {
    expect(Object.keys(TICKET_BACKDROPS)).toHaveLength(12);
    expect(Object.keys(TICKET_BACKDROPS).join('')).toBe('abcdefghijkl');
  });

  /**
   * A still ticket carries neither the marker class nor the `<style>` — which is what keeps a
   * page of thumbnails still while one large preview animates: the keyframes are document-global,
   * but the rules that use them are scoped under `.ta-live`, and a still ticket has no `.ta-live`.
   */
  it('is still, with no marker and no style, unless animation is asked for', () => {
    const svg = buildTicketSvg({ ...base, preset: 'a' });
    expect(svg).not.toContain('ta-live');
    expect(svg).not.toContain('<style>');
  });

  it('leaves the still document byte-for-byte what it was when animation is off', () => {
    // `animated: false` is the default, so passing it must change nothing at all.
    expect(buildTicketSvg({ ...base, preset: 'g', animated: false }))
      .toBe(buildTicketSvg({ ...base, preset: 'g' }));
  });

  it('marks the root and injects the scoped style once animation is on', () => {
    const svg = buildTicketSvg({ ...base, preset: 'a', animated: true });
    expect(svg).toContain('class="ticket-art__svg ta-live"');
    expect(svg).toContain('<style>');
    expect(svg).toContain('@keyframes ta-a-');
    // Every rule is scoped under the marker, so a still ticket beside it cannot pick it up.
    expect(svg).toContain('.ta-live .ta-a-veil-1');
  });

  it('animates no more than two layers on any backdrop that moves', () => {
    for (const preset of ['a', 'c', 'e', 'g', 'i', 'k'] as const) {
      const svg = buildTicketSvg({ ...base, preset, animated: true });
      const rules = svg.match(/animation:/g) ?? [];
      expect(rules.length).toBeGreaterThanOrEqual(1);
      expect(rules.length).toBeLessThanOrEqual(2);
    }
  });

  it('leaves a backdrop with no animation still even when animation is on', () => {
    // `b` has no `anim`, so asking to animate it adds neither a marker nor a style.
    const svg = buildTicketSvg({ ...base, preset: 'b', animated: true });
    expect(svg).not.toContain('ta-live');
    expect(svg).not.toContain('<style>');
  });

  it('never animates an uploaded picture, whatever the flag says', () => {
    const svg = buildTicketSvg({ ...base, imageHref: 'https://gw.test/bafkmine', animated: true });
    expect(svg).not.toContain('ta-live');
    expect(svg).not.toContain('<style>');
  });
});
