import type { Page, Response } from '@playwright/test';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { recordPersona } from './scenario-state';

/**
 * Passive capture for the RELAYED submission paths (task F1) — the single relay-path capture util,
 * replacing the retired sponsored-op capture.
 *
 * No write on the web sends a transaction of its own any more: a ticket claim signs a `ClaimAuth`
 * and calls the `relayClaim` callable, while a transfer / override / organizer write signs a
 * `ForwardRequest` and calls the `relayAction` callable. Either way the MONTI relayer pays and the
 * app follows `relays/{relayId}` (저장→확인→완료 on screen). This watches both callables.
 *
 * It does two jobs, both best-effort and never throwing into the flow:
 *  1. records the persona's smart-account address from the callable REQUEST body — `data.auth.account`
 *     on a claim, `data.req.from` on an action — now that no submission carries an on-chain `sender`;
 *  2. on a failure, writes the callable's refusal — the same `{ code, nonce? }` a `relays/{id}`
 *     doc's `error` carries, surfaced here as the callable's `HttpsError` — verbatim to the artifacts
 *     (`e2e/.artifacts/relay-errors/…`) and the friction log, so a failure leaves the diagnostic the
 *     trace used to hide.
 *
 * Firebase onCall v2 wire format: request POST body `{ data: { mode, auth, deviceSig } }`; success
 * response `{ result: { relayId, status, txHash?, tokenId? } }`; error response
 * `{ error: { status, message, details? } }`. Only the response HOST is recorded, never the full URL.
 */
const ARTIFACT_DIR = 'e2e/.artifacts';
export const RELAY_ERRORS_DIR = `${ARTIFACT_DIR}/relay-errors`;
export const RELAY_ERRORS_PATH = `${RELAY_ERRORS_DIR}/relay-errors.jsonl`;
export const FRICTION_LOG_PATH = `${ARTIFACT_DIR}/friction.jsonl`;

/** The callables this capture follows. `relayCheckIn` (staff) is deliberately not matched here. */
const RELAY_CALLABLES = ['relayclaim', 'relayaction'] as const;

export interface CapturedRelayError {
  persona: string;
  eventId?: string;
  /** The contract/relay reason code (`details.code`, e.g. SOLD_OUT/LIMIT), else the gRPC status. */
  code?: string;
  /** The server's short uppercase reason (`error.message`). */
  message?: string;
  /** The gRPC status the callable rejected with (e.g. `FAILED_PRECONDITION`). */
  status?: string;
  /** The persona's smart-account address, read off the request body when it was there. */
  account?: string;
  host?: string;
  /** The raw callable `error` object, verbatim. */
  error: unknown;
  at: string;
}

/** A successful relay submission, kept so a scenario/report can read the relayId and minted token. */
export interface RelaySubmission {
  persona: string;
  eventId?: string;
  relayId?: string;
  status?: string;
  txHash?: string;
  /** The minted tokenId (big-number string) on a confirmed claim. */
  tokenId?: string;
  account?: string;
  at: string;
}

export interface RelayCapture {
  /** Every `relayClaim` refusal seen while attached. */
  readonly errors: CapturedRelayError[];
  /** Every successful `relayClaim` answer (sent/confirmed) seen while attached. */
  readonly submissions: RelaySubmission[];
  detach(): void;
  /**
   * Write the captured relay refusal(s) to the artifacts and the friction log. Records a bare
   * "no relay error" friction line when nothing was seen (e.g. a client-side timeout or a `sent`
   * relay that later failed only in its `relays/{id}` doc), so a failed claim always leaves a
   * breadcrumb. Safe to call once.
   */
  flushFailure(note?: string): void;
}

interface Ctx {
  persona: string;
  eventId?: string;
}

interface CallableBody {
  result?: { relayId?: string; status?: string; txHash?: string; tokenId?: string };
  error?: { status?: string; message?: string; details?: { code?: string; nonce?: string } };
}

function isRelayCallable(url: string): boolean {
  const lower = url.toLowerCase();
  return RELAY_CALLABLES.some((callable) => lower.includes(callable));
}

/** The persona account from the request body: `auth.account` on a claim, `req.from` on an action. */
function accountOf(postData: string): string | undefined {
  try {
    const body = JSON.parse(postData) as { data?: { auth?: { account?: unknown }; req?: { from?: unknown } } };
    const account = body.data?.auth?.account ?? body.data?.req?.from;
    return typeof account === 'string' ? account : undefined;
  } catch {
    return undefined;
  }
}

function eventIdOf(postData: string): string | undefined {
  try {
    const body = JSON.parse(postData) as { data?: { auth?: { eventId?: unknown } } };
    const eventId = body.data?.auth?.eventId;
    return typeof eventId === 'string' ? eventId : undefined;
  } catch {
    return undefined;
  }
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

export function attachRelayCapture(page: Page, ctx: Ctx): RelayCapture {
  const errors: CapturedRelayError[] = [];
  const submissions: RelaySubmission[] = [];
  let recordedAccount: string | undefined;

  const onResponse = (response: Response): void => {
    void (async () => {
      try {
        const request = response.request();
        if (request.method() !== 'POST') return;
        if (!isRelayCallable(response.url())) return;
        const post = request.postData() ?? '';

        const account = accountOf(post);
        // The account is the persona's smart-account address — persist it once as the account half
        // of the persona map, now that a claim carries no on-chain `sender` to read (best-effort).
        if (account && account !== recordedAccount) {
          recordedAccount = account;
          recordPersona(ctx.persona, { account });
        }

        const text = await response.text().catch(() => '');
        let body: CallableBody | undefined;
        try {
          body = JSON.parse(text) as CallableBody;
        } catch {
          return;
        }
        if (body.result) {
          submissions.push({
            persona: ctx.persona,
            eventId: ctx.eventId ?? eventIdOf(post),
            relayId: body.result.relayId,
            status: body.result.status,
            txHash: body.result.txHash,
            tokenId: body.result.tokenId,
            account,
            at: new Date().toISOString(),
          });
        } else if (body.error) {
          errors.push({
            persona: ctx.persona,
            eventId: ctx.eventId ?? eventIdOf(post),
            code: body.error.details?.code ?? body.error.status,
            message: body.error.message,
            status: body.error.status,
            account,
            host: hostOf(response.url()),
            error: body.error,
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
    submissions,
    detach() {
      page.off('response', onResponse);
    },
    flushFailure(note?: string) {
      const at = new Date().toISOString();
      if (errors.length === 0) {
        appendLine(FRICTION_LOG_PATH, {
          kind: 'claim-failed',
          persona: ctx.persona,
          eventId: ctx.eventId,
          relayError: null,
          note:
            note ??
            'no relayClaim error in the network log (a client-side timeout, or a relay that failed only in its relays/{id} doc)',
          at,
        });
        return;
      }
      for (const e of errors) {
        appendLine(RELAY_ERRORS_PATH, e);
        appendLine(FRICTION_LOG_PATH, {
          kind: 'claim-failed',
          persona: e.persona,
          eventId: e.eventId,
          relayError: { code: e.code, message: e.message, status: e.status, account: e.account, host: e.host },
          note,
          at,
        });
      }
      // Also drop the verbatim error(s) as a standalone artifact file for this failure.
      try {
        mkdirSync(RELAY_ERRORS_DIR, { recursive: true });
        const stamp = at.replace(/[:.]/g, '-');
        const file = `${RELAY_ERRORS_DIR}/${ctx.persona}-${ctx.eventId ?? 'event'}-${stamp}.json`;
        writeFileSync(file, JSON.stringify(errors, null, 2));
      } catch {
        /* the JSONL append above is the durable record; the per-failure file is a convenience */
      }
    },
  };
}
