import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** Where per-step timings are appended, one JSON object per line (JSONL). */
export const TIMINGS_PATH = 'e2e/.artifacts/timings.jsonl';

export interface StepTiming {
  persona: string;
  step: string;
  ms: number;
  ok: boolean;
  note?: string;
  at: string;
}

let ready = false;
function ensureDir(): void {
  if (ready) return;
  mkdirSync(dirname(TIMINGS_PATH), { recursive: true });
  ready = true;
}

/** Append one timing line. Timings are the point of the harness, so this never throws the test. */
export function record(t: Omit<StepTiming, 'at'>): void {
  try {
    ensureDir();
    appendFileSync(TIMINGS_PATH, JSON.stringify({ ...t, at: new Date().toISOString() }) + '\n');
  } catch {
    /* a timing that cannot be written is not a reason to fail a scenario */
  }
}

/** Time an action, record it, and re-throw on failure after recording the elapsed time. */
export async function timed<T>(persona: string, step: string, fn: () => Promise<T>, note?: string): Promise<T> {
  const started = Date.now();
  try {
    const result = await fn();
    record({ persona, step, ms: Date.now() - started, ok: true, note });
    return result;
  } catch (error) {
    record({ persona, step, ms: Date.now() - started, ok: false, note: `${note ?? ''} ${String(error).slice(0, 200)}`.trim() });
    throw error;
  }
}
