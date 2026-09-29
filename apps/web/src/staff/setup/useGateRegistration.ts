import { useCallback, useEffect, useRef, useState } from 'react';
import type { Address } from 'viem';

import { callableFailure, submitPendingGate, type PendingGateSubmission } from '../../shared/api/functions';
import { gateAccountAddress } from '../../shared/chain/gateAccount';
import { readOrganizers, readTicket } from '../../shared/chain/reads';
import { GATE_REGISTRATION_POLL_MS } from '../constants';
import { ensureGateKey, gateKeyCoordinates } from '../gate/gateKey';

export type { PendingGateSubmission };

/**
 * 단말기가 키를 만든 뒤 `submitPendingGate` 로 **등록 신청을 직접 보낸다**(스태프 전화 인증
 * 세션). 관리자는 자기 화면에서 신청 목록을 보고 `Organizers.registerGate` 를 부른다. QR·텍스트
 * 는 신청이 도달하지 못했을 때를 위한 폴백 표시로만 남는다. 등록 여부의 진실은 언제나 체인의
 * `gateOf` 다(스펙 §5.7-1, §9.4).
 *
 * 신청은 **스태프가 행사를 확인한 뒤에만** 나간다. `eventId` 가 없으면 이 훅은 폴링만 한다:
 * 잘못된 행사로 승인된 게이트는 되돌릴 수 없다(`Organizers.registerGate` 는
 * `GateAccountInUse` 로 같은 계정을 두 번 받지 않고, `revokeGate` 는 `_gateOf` 를 비우지 않는다).
 */

/**
 * The four states a staff member can be standing in front of. They are not a progress bar:
 * `waiting` is where a device spends almost all of its life, and the only thing that leaves
 * it is an organizer's transaction landing on chain.
 */
export const GATE_SETUP_STATUSES = ['creating', 'submitting', 'waiting', 'registered'] as const;
export type GateSetupStatus = (typeof GATE_SETUP_STATUSES)[number];

/**
 * Every way this screen can be stuck, as a code rather than a sentence — the copy files own
 * the sentence, in both locales.
 *
 * The middle four are the server's own reason codes, carried through unchanged
 * (`functions/src/functions/pendingGates.ts`), because each one has a different answer:
 * sign in, ask the organizer whose device this already is, clear an old application, fix the
 * event number. Collapsing them into one "could not send" would send a staff member looking
 * for a network problem when the answer is on the screen in front of them.
 *
 * `UNKNOWN_EVENT` is declared although `submitPendingGate` cannot raise it today — it only
 * checks that the event id is a digit string, so a number with no event behind it is queued
 * in silence. The day the server does look, the sentence is already written.
 */
export const GATE_SETUP_ERRORS = [
  'KEY_UNAVAILABLE',
  'AUTH_REQUIRED',
  'NOT_YOUR_GATE',
  'TOO_MANY_PENDING',
  'UNKNOWN_EVENT',
  'SUBMIT_REJECTED',
  'CHAIN_UNREACHABLE',
] as const;
export type GateSetupError = (typeof GATE_SETUP_ERRORS)[number];

/** The server reason codes that are shown as themselves. Anything else is `SUBMIT_REJECTED`. */
const PASSED_THROUGH: ReadonlySet<string> = new Set<GateSetupError>([
  'AUTH_REQUIRED',
  'NOT_YOUR_GATE',
  'TOO_MANY_PENDING',
  'UNKNOWN_EVENT',
]);

export interface GateRegistration {
  status: GateSetupStatus;
  /** The counterfactual gate account (Task 13). Present as soon as the device key exists. */
  address?: Address;
  /**
   * Exactly what was sent, kept so the fallback can show it. The QR and the text lines are
   * rendered from this object and nothing else: an organizer who types in what the screen
   * shows must end up with the same four values the server already holds.
   */
  payload?: PendingGateSubmission;
  gateId?: bigint;
  /** The event the **chain** says this gate belongs to, which is not necessarily the one submitted. */
  eventId?: bigint;
  orgId?: bigint;
  open: boolean;
  revoked: boolean;
  submitted: boolean;
  /** When the application was accepted, for the "waiting for N seconds" line. */
  submittedAt?: number;
  error?: GateSetupError;
  /** Sends the same application again. Safe: the server keys the row by the account. */
  resubmit: () => void;
}

export interface UseGateRegistrationParams {
  /** 스태프가 확인한 행사. 있으면 등록 신청을 보낸다. 없으면 폴링만 한다. */
  eventId?: string;
  pollMs?: number;
}

/**
 * The scheme tag on the fallback code, in the shape this codebase already uses for the
 * attendee QR (`QR_PREFIX = 'MONTI1:'`). An organizer's scanner keys on it rather than
 * guessing at bare JSON, and the `1` is what lets a second version exist later.
 */
export const GATE_QR_PREFIX = 'MONTI-GATE1:';

/** The QR and the copyable text are this string. One spelling, so the two cannot disagree. */
export function gatePayloadText(payload: PendingGateSubmission): string {
  return `${GATE_QR_PREFIX}${JSON.stringify(payload)}`;
}

/**
 * The inverse, for whoever reads the code on the organizer's side. It answers `null` rather
 * than throwing or half-filling: a scan that produced anything but our own four fields is a
 * scan of something else, and registering a gate from it would bind an address nobody holds.
 */
export function parseGatePayloadText(text: string): PendingGateSubmission | null {
  if (!text.startsWith(GATE_QR_PREFIX)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(GATE_QR_PREFIX.length));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { eventId, gateAccount, kx, ky } = parsed as Record<string, unknown>;
  if (typeof eventId !== 'string' || typeof gateAccount !== 'string') return null;
  if (typeof kx !== 'string' || typeof ky !== 'string') return null;
  return { eventId, gateAccount: gateAccount as `0x${string}`, kx: kx as `0x${string}`, ky: ky as `0x${string}` };
}

type State = Omit<GateRegistration, 'resubmit'>;

const INITIAL: State = { status: 'creating', open: false, revoked: false, submitted: false };

/**
 * A reason code this screen shows as itself, or `SUBMIT_REJECTED` for everything else.
 * `callableFailure` already hands back the server's uppercase `reason`; the gRPC `code` is
 * only consulted for the one case a caller can hit without ever reaching our handler.
 */
function submitError(failure: unknown): GateSetupError {
  const { code, reason } = callableFailure(failure);
  if (PASSED_THROUGH.has(reason)) return reason as GateSetupError;
  return code === 'unauthenticated' ? 'AUTH_REQUIRED' : 'SUBMIT_REJECTED';
}

/** A read that succeeded clears a read that failed, and leaves a submit failure standing. */
function withoutReadError(error: GateSetupError | undefined): GateSetupError | undefined {
  return error === 'CHAIN_UNREACHABLE' ? undefined : error;
}

/** Everything one application produces, with no React state touched along the way. */
interface Application {
  address: Address;
  payload?: PendingGateSubmission;
  submitted: boolean;
  submittedAt?: number;
  error?: GateSetupError;
}

/**
 * The key, the address, and — only when a staff member has confirmed an event — the one
 * application. Kept out of the effect so it can be memoised: StrictMode runs every effect
 * twice, and a second application per mount would be a second row in the organizer's queue.
 */
async function apply(eventId: string | undefined): Promise<Application> {
  // The key first: the address is a pure function of it (`gateAccountAddress`), so a device that
  // cannot hold a key has no account either and there is nothing to show or submit.
  const key = gateKeyCoordinates(await ensureGateKey());
  const address = gateAccountAddress(key.kx, key.ky);
  if (eventId === undefined) return { address, submitted: false };

  const payload: PendingGateSubmission = { eventId, gateAccount: address, ...key };
  try {
    await submitPendingGate(payload);
    return { address, payload, submitted: true, submittedAt: Date.now() };
  } catch (failure) {
    // 신청이 막히면 QR 폴백으로 관리자가 직접 입력한다. 폴링은 계속한다.
    return { address, payload, submitted: false, error: submitError(failure) };
  }
}

export function useGateRegistration(params: UseGateRegistrationParams = {}): GateRegistration {
  const { eventId, pollMs = GATE_REGISTRATION_POLL_MS } = params;
  const [state, setState] = useState<State>(INITIAL);
  // Bumped by `resubmit`, which is the only thing that sends a second application for the
  // same event: `attempt` is half of the memo key below, so pressing the button is the only
  // way past it.
  const [attempt, setAttempt] = useState(0);
  const sent = useRef<{ key: string; application: Promise<Application> } | null>(null);

  useEffect(() => {
    const key = `${attempt}\u0000${eventId ?? ''}`;
    // Set synchronously, before any await, so StrictMode's second run of this effect finds
    // the first run's promise rather than starting a second application of its own. Both
    // runs then await the same answer and whichever is still alive renders it.
    if (sent.current?.key !== key) sent.current = { key, application: apply(eventId) };
    const application = sent.current.application;

    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const organizers = readOrganizers();
    const ticket = readTicket();

    const poll = async (address: Address): Promise<void> => {
      try {
        const gateId = await organizers.gateOf(address);
        if (!alive) return;
        if (gateId !== 0n) {
          // `gateOf` answers with this device's gate id. Nothing here assumes the seeded 1 —
          // a second gate on the same event gets a different id and the same screen.
          const info = await organizers.gateInfo(gateId);
          if (!alive) return;
          const orgId = await ticket.eventOrg(info.eventId);
          if (!alive) return;
          setState((previous) => ({
            ...previous,
            status: 'registered',
            gateId,
            eventId: info.eventId,
            orgId,
            open: info.open,
            revoked: info.revoked,
            error: withoutReadError(previous.error),
          }));
          // Registration is final: the organizer signed it and this device is now a gate.
          // Polling past it would keep a radio busy for an answer that cannot change.
          return;
        }
        setState((previous) => ({
          ...previous,
          status: 'waiting',
          gateId: undefined,
          open: false,
          revoked: false,
          error: withoutReadError(previous.error),
        }));
      } catch {
        if (!alive) return;
        // A dropped read is not a refusal. The screen says so and the next tick tries again.
        setState((previous) => ({ ...previous, error: 'CHAIN_UNREACHABLE' }));
      }
      timer = setTimeout(() => void poll(address), pollMs);
    };

    if (eventId !== undefined) setState((previous) => ({ ...previous, status: 'submitting' }));

    void (async () => {
      let result: Application;
      try {
        result = await application;
      } catch {
        if (!alive) return;
        setState((previous) => ({ ...previous, status: 'creating', error: 'KEY_UNAVAILABLE' }));
        return;
      }
      if (!alive) return;
      setState((previous) => ({
        ...previous,
        address: result.address,
        payload: result.payload,
        submitted: result.submitted,
        submittedAt: result.submittedAt,
        status: 'waiting',
        error: result.error,
      }));
      void poll(result.address);
    })();

    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [eventId, pollMs, attempt]);

  const resubmit = useCallback(() => setAttempt((previous) => previous + 1), []);

  return { ...state, resubmit };
}
