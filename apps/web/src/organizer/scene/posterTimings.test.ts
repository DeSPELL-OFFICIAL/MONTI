import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  posterTimingLine, posterTimings, reportPosterTimings, slowestStage, totalMs,
} from './posterTimings';

/**
 * The plan ranked the reasons a poster feels slow by reading the code and said so plainly:
 * that ranking is not a measurement (section D-2). These are the numbers that settle it, and
 * they are a value rather than a console line so this can check them without a spy.
 */
const CROP = { decodeMs: 340.4, encodeMs: 180.2, rescueMs: 0, base64Ms: 12.6 };

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('posterTimings', () => {
  it('carries the crop clocks through and adds the upload beside them', () => {
    const timings = posterTimings(CROP, 690.9, 512 * 1024);
    expect(timings).toEqual({ ...CROP, uploadMs: 690.9, bytes: 512 * 1024 });
    expect(totalMs(timings)).toBeCloseTo(340.4 + 180.2 + 0 + 12.6 + 690.9, 6);
  });

  /** A stubbed crop reports nothing rather than reporting a wrong zero as a real measurement. */
  it('reads an unmeasured crop as zeros rather than throwing', () => {
    expect(posterTimings(undefined, 12, 34)).toEqual({
      decodeMs: 0, encodeMs: 0, rescueMs: 0, base64Ms: 0, uploadMs: 12, bytes: 34,
    });
  });

  /** The one number T-UX2-19 turns on: the encode quality drops only if encoding dominates. */
  it('names the stage that dominated', () => {
    expect(slowestStage(posterTimings(CROP, 690.9, 1))).toBe('upload');
    expect(slowestStage(posterTimings(CROP, 10, 1))).toBe('decode');
    expect(slowestStage(posterTimings({ ...CROP, encodeMs: 4000 }, 10, 1))).toBe('crop');
    expect(slowestStage(posterTimings({ ...CROP, rescueMs: 9000 }, 10, 1))).toBe('rescue');
  });

  it('says every stage, the total and the winner on one line', () => {
    const line = posterTimingLine(posterTimings(CROP, 690.9, 512 * 1024));
    expect(line).toBe(
      'poster 1224ms · decode 340ms · crop 180ms · rescue 0ms · base64 13ms · upload 691ms'
      + ' · 512KB · slowest upload',
    );
  });
});

describe('reportPosterTimings', () => {
  it('prints the line once in a development build', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    reportPosterTimings(posterTimings(CROP, 690.9, 512 * 1024));
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]?.[0]).toContain('slowest upload');
  });

  /**
   * A production bundle has no business narrating itself to an organiser's console — and
   * `import.meta.env.DEV` is a literal the bundler folds away, so the line never ships.
   */
  it('prints nothing at all when the build is not a development one', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.stubEnv('DEV', false);
    reportPosterTimings(posterTimings(CROP, 690.9, 512 * 1024));
    expect(info).not.toHaveBeenCalled();
  });
});
