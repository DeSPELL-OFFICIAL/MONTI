import type { Page } from '@playwright/test';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Review screenshots. Off unless `E2E_SHOTS_DIR` is set: then every `shot()` writes a numbered
 * full-page PNG there (`NN-<name>.png`, counter starts at `E2E_SHOTS_START`, default 1) and, when
 * `E2E_SHOTS_TEXT` is set, appends the page's visible text to that JSONL file (copy review).
 * Never throws — a failed screenshot must not fail a live money run.
 */
const DIR = process.env.E2E_SHOTS_DIR ?? '';
const TEXT = process.env.E2E_SHOTS_TEXT ?? '';
let n = Number(process.env.E2E_SHOTS_START ?? 1);

export async function shot(page: Page, name: string): Promise<void> {
  if (!DIR) return;
  const file = `${String(n++).padStart(2, '0')}-${name}.png`;
  try {
    mkdirSync(DIR, { recursive: true });
    await page.screenshot({ path: join(DIR, file), fullPage: true });
    if (TEXT) {
      const text = await page.locator('body').innerText().catch(() => '');
      appendFileSync(TEXT, `${JSON.stringify({ file, url: page.url(), text })}\n`);
    }
  } catch { /* best effort */ }
}
