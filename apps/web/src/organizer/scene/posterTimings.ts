import type { CropTimings } from '../../shared/ui';

/** Every stage a poster goes through between the file picker and a CID. */
export type PosterStage = 'decode' | 'crop' | 'rescue' | 'base64' | 'upload';

/** A finished poster's whole journey, in milliseconds, plus what came out of it. */
export interface PosterTimings extends CropTimings {
  /** The `pinEventImage` round trip: base64 up to us-east1, Pinata, and a CID back. */
  uploadMs: number;
  /** The encoded blob's size, because the upload figure means nothing without it. */
  bytes: number;
}

/** Nothing was measured — a stubbed crop in a test, or a browser without `performance`. */
const NONE: CropTimings = { decodeMs: 0, encodeMs: 0, rescueMs: 0, base64Ms: 0 };

/**
 * The crop's own clocks and the upload's, in one record. Pure, and deliberately so: the
 * question T-UX2-10 exists to answer — which stage dominates — is a question about numbers,
 * and a test should be able to ask it without spying on a console.
 */
export function posterTimings(
  crop: CropTimings | undefined, uploadMs: number, bytes: number,
): PosterTimings {
  return { ...(crop ?? NONE), uploadMs, bytes };
}

export function totalMs(timings: PosterTimings): number {
  return timings.decodeMs + timings.encodeMs + timings.rescueMs + timings.base64Ms
    + timings.uploadMs;
}

/**
 * The one stage that took longest. This is the whole point of the measurement: the plan ranked
 * the suspects by reading the code and said plainly that the ranking was not a measurement
 * (section D-2), and T-UX2-19 — dropping the encode quality — is only to be started if the
 * encoding is what dominates.
 */
export function slowestStage(timings: PosterTimings): PosterStage {
  const stages: ReadonlyArray<readonly [PosterStage, number]> = [
    ['decode', timings.decodeMs],
    ['crop', timings.encodeMs],
    ['rescue', timings.rescueMs],
    ['base64', timings.base64Ms],
    ['upload', timings.uploadMs],
  ];
  return stages.reduce((slowest, stage) => (stage[1] > slowest[1] ? stage : slowest))[0];
}

function ms(value: number): string {
  return `${Math.round(value)}ms`;
}

/** One line, so three photos on a real phone are three lines that can be read side by side. */
export function posterTimingLine(timings: PosterTimings): string {
  return [
    `poster ${ms(totalMs(timings))}`,
    `decode ${ms(timings.decodeMs)}`,
    `crop ${ms(timings.encodeMs)}`,
    `rescue ${ms(timings.rescueMs)}`,
    `base64 ${ms(timings.base64Ms)}`,
    `upload ${ms(timings.uploadMs)}`,
    `${Math.round(timings.bytes / 1024)}KB`,
    `slowest ${slowestStage(timings)}`,
  ].join(' · ');
}

/**
 * Prints the line — in a development build and nowhere else. A production bundle has no
 * business narrating itself to an organiser's console, and `import.meta.env.DEV` is a literal
 * the bundler folds away, so the call and the line-building behind it leave the build entirely.
 */
export function reportPosterTimings(timings: PosterTimings): void {
  if (!import.meta.env.DEV) return;
  console.info(posterTimingLine(timings));
}
