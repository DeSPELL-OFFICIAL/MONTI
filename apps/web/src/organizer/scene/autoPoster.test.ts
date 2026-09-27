import { describe, expect, it } from 'vitest';
import { buildPosterSvg } from './autoPoster';

/**
 * `buildPosterSvg` is pure and needs no browser — the raster half (`renderAutoPoster`) is the
 * part with a canvas, and it is stubbed wherever the publish path is under test. What matters
 * here is that the A4 frame, the escaped title and the chosen theme backdrop all reach the SVG.
 */
describe('buildPosterSvg', () => {
  it('draws an A4 frame with the escaped title', () => {
    const svg = buildPosterSvg('재즈 & 나이트', 'c');
    expect(svg).toContain('viewBox="0 0 1240 1754"');
    // The title goes through escapeXml, the one reason handing this to a rasteriser is safe.
    expect(svg).toContain('재즈 &amp; 나이트');
    expect(svg).toContain('<text');
  });

  it('reflects the chosen preset and folds an unknown one back to a', () => {
    expect(buildPosterSvg('x', 'a')).not.toBe(buildPosterSvg('x', 'c'));
    // @ts-expect-error — an unknown preset folds back to the first backdrop, never a blank frame.
    expect(buildPosterSvg('x', 'zz')).toBe(buildPosterSvg('x', 'a'));
  });
});
