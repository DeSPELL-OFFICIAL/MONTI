import type { Page, Response } from '@playwright/test';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { recordPersona } from './scenario-state';

/**
 * Passive bundler-error capture for the claim path (task-claim-failure-report §1, §4).
 *
 * When a second attendee's `eth_sendUserOperation` is rejected by the bundler precheck, the app
 * only shows "티켓을 받지 못했어요…" — the diagnostic JSON-RPC error (e.g. `-32000 precheck
 * failed: paymaster deposit is … but must be at least …`) lived only in the trace. This attaches
 * a response listener to the page, notices any `eth_sendUserOperation` /
 * `eth_estimateUserOperationGas` response that carries a JSON-RPC `error`, and on a failed claim
 * writes that error verbatim to the artifacts (`e2e/.artifacts/bundler-errors/…`) and to the
 * automated friction log (`e2e/.artifacts/friction.jsonl`).
 *
 * Only the bundler *host* is recorded, never the full URL — the Alchemy API key lives in the URL
 * path and must never be written to an artifact. The request body carries no secret.
 */
const ARTIFACT_DIR = 'e2e/.artifacts';
export const BUNDLER_ERRORS_DIR = `${ARTIFACT_DIR}/bundler-errors`;
export const BUNDLER_ERRORS_PATH = `${BUNDLER_ERRORS_DIR}/bundler-errors.jsonl`;
export const FRICTION_LOG_PATH = `${ARTIFACT_DIR}/friction.jsonl`;

const OP_METHODS = ['eth_sendUserOperation', 'eth_estimateUserOperationGas'] as const;

export interface CapturedRpcError {
  persona: string;
  eventId?: string;
  method: string;
  code?: number;
  message?: string;
  /** The userOp sender (the persona's smart-account address) when it could be read. */
  sender?: string;
  host?: string;
  /** The raw JSON-RPC `error` object, verbatim. */
  error: unknown;
  at: string;
}

export interface BundlerCapture {
  /** Every op-method error seen while attached (send and estimate). */
  readonly errors: CapturedRpcError[];
  detach(): void;
  /**
   * Write the captured send-op error(s) — or, absent those, any captured error — to the artifacts
   * and the friction log. Records a bare "no bundler error" friction line when nothing was seen
   * (e.g. a client-side timeout), so a failed claim always leaves a breadcrumb. Safe to call once.
   */
  flushFailure(note?: string): void;
}

interface Ctx {
  persona: string;
  eventId?: string;
}

/** Parse a JSON-RPC body that is either a single response object or a batch array. */
function rpcEntries(text: string): Array<{ id?: unknown; error?: { code?: number; message?: string } }> {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) return parsed as Array<{ id?: unknown; error?: { code?: number; message?: string } }>;
    if (parsed && typeof parsed === 'object') return [parsed as { id?: unknown; error?: { code?: number; message?: string } }];
  } catch {
    /* not JSON we can read */
  }
  return [];
}

/** Which op method this request carried. Real bundler traffic is one method per POST. */
function methodOf(postData: string): string {
  for (const m of OP_METHODS) if (postData.includes(`"${m}"`)) return m;
  return 'eth_sendUserOperation';
}

/** The userOp sender address, read straight off the request body (avoids deep-parsing the op). */
function senderOf(postData: string): string | undefined {
  return /"sender"\s*:\s*"(0x[0-9a-fA-F]{40})"/.exec(postData)?.[1];
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

function appendLine(path: string, obj: unknown): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(obj) + '\n');
  } catch {
    /* a breadcrumb that cannot be written is not a reason to fail a scenario */
  }
}

export function attachBundlerCapture(page: Page, ctx: Ctx): BundlerCapture {
  const errors: CapturedRpcError[] = [];
  let recordedSender: string | undefined;

  const onResponse = (response: Response): void => {
    void (async () => {
      try {
        const request = response.request();
        if (request.method() !== 'POST') return;
        const post = request.postData() ?? '';
        if (!OP_METHODS.some((m) => post.includes(`"${m}"`))) return;

        const sender = senderOf(post);
        // The userOp sender is the persona's smart-account address — persist it once as the
        // account half of the phone→uid/account map (best-effort; never blocks the claim).
        if (sender && sender !== recordedSender) {
          recordedSender = sender;
          recordPersona(ctx.persona, { account: sender });
        }

        const text = await response.text().catch(() => '');
        if (!text.includes('"error"')) return;
        for (const entry of rpcEntries(text)) {
          if (!entry.error) continue;
          errors.push({
            persona: ctx.persona,
            eventId: ctx.eventId,
            method: methodOf(post),
            code: entry.error.code,
            message: entry.error.message,
            sender,
            host: hostOf(response.url()),
            error: entry.error,
            at: new Date().toISOString(),
          });
        }
      } catch {
        /* capture must never throw into the claim */
      }
    })();
  };

  page.on('response', onResponse);

  return {
    errors,
    detach() {
      page.off('response', onResponse);
    },
    flushFailure(note?: string) {
      const send = errors.filter((e) => e.method === 'eth_sendUserOperation');
      const chosen = send.length ? send : errors;
      const at = new Date().toISOString();
      if (chosen.length === 0) {
        appendLine(FRICTION_LOG_PATH, {
          kind: 'claim-failed',
          persona: ctx.persona,
          eventId: ctx.eventId,
          bundlerError: null,
          note: note ?? 'no eth_sendUserOperation error in the network log (likely a client-side timeout)',
          at,
        });
        return;
      }
      for (const e of chosen) {
        appendLine(BUNDLER_ERRORS_PATH, e);
        appendLine(FRICTION_LOG_PATH, {
          kind: 'claim-failed',
          persona: e.persona,
          eventId: e.eventId,
          bundlerError: { code: e.code, message: e.message, sender: e.sender, host: e.host },
          note,
          at,
        });
      }
      // Also drop the verbatim error(s) as a standalone artifact file for this failure.
      try {
        mkdirSync(BUNDLER_ERRORS_DIR, { recursive: true });
        const stamp = at.replace(/[:.]/g, '-');
        const file = `${BUNDLER_ERRORS_DIR}/${ctx.persona}-${ctx.eventId ?? 'event'}-${stamp}.json`;
        writeFileSync(file, JSON.stringify(chosen, null, 2));
      } catch {
        /* the JSONL append above is the durable record; the per-failure file is a convenience */
      }
    },
  };
}
