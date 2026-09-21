import { useCallback, useEffect, useState } from 'react';
import type { Address } from 'viem';

import { callableFailure, submitPendingGate, type PendingGateSubmission } from '../../shared/api/functions';
import { getGateAddress } from '../../shared/chain/gateAccount';
import { readOrganizers, readTicket } from '../../shared/chain/reads';
import { GATE_REGISTRATION_POLL_MS } from '../constants';
import { ensureGateKey, gateKeyCoordinates } from '../gate/gateKey';

export type { PendingGateSubmission };

/**
 * 단말기가 키를 만든 뒤 `submitPendingGate` 로 **등록 신청을 직접 보낸다**(스태프 전화 인증
 * 세션). 관리자는 자기 화면에서 신청 목록을 보고 `Organizers.registerGate` 를 부른다. QR·텍스트
 * 는 신청이 도달하지 못했을 때를 위한 폴백 표시로만 남는다. 등록 여부의 진실은 언제나 체인의
 * `gateOf` 다(스펙 §5.7-1, §9.4).
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
 * `AUTH_REQUIRED` is split out of `SUBMIT_REJECTED` because it is the only one with an action
 * the staff member can take on this phone: sign in. The other three are "tell the organizer",
 * "wait", and "use a different phone", and a screen that blurred them into one would send a
 * staff member looking for a network problem when the answer is a locked-down device.
 */
export const GATE_SETUP_ERRORS = [
  'KEY_UNAVAILABLE',
  'AUTH_REQUIRED',
  'SUBMIT_REJECTED',
  'CHAIN_UNREACHABLE',
] as const;
export type GateSetupError = (typeof GATE_SETUP_ERRORS)[number];

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
  /** 스태프가 고른 공연. 있으면 등록 신청을 보낸다. 없으면 폴링만 한다. */
  eventId?: string;
  pollMs?: number;
}

/** The QR and the copyable text are this string. One spelling, so the two cannot disagree. */
export function gatePayloadText(payload: PendingGateSubmission): string {
  return JSON.stringify(payload);
}

type State = Omit<GateRegistration, 'resubmit'>;

const INITIAL: State = { status: 'creating', open: false, revoked: false, submitted: false };

/**
 * `unauthenticated` is the one rejection this phone can fix by itself; everything else the
 * server refuses (a malformed event id, a key half at zero) is the organizer's to sort out.
 */
function submitError(failure: unknown): GateSetupError {
  return callableFailure(failure).code === 'unauthenticated' ? 'AUTH_REQUIRED' : 'SUBMIT_REJECTED';
}

/** A read that succeeded clears a read that failed, and leaves a submit failure standing. */
function withoutReadError(error: GateSetupError | undefined): GateSetupError | undefined {
  return error === 'CHAIN_UNREACHABLE' ? undefined : error;
}

export function useGateRegistration(params: UseGateRegistrationParams = {}): GateRegistration {
  const { eventId, pollMs = GATE_REGISTRATION_POLL_MS } = params;
  const [state, setState] = useState<State>(INITIAL);
  // Bumped by `resubmit`, which is the only thing that sends a second application within one
  // mount: the effect below submits exactly once per run, so a re-render cannot double it.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
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
          status: previous.status === 'submitting' ? previous.status : 'waiting',
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

    void (async () => {
      let payload: PendingGateSubmission | undefined;
      let address: Address;
      try {
        // The key first: `getGateAddress` is a pure function of it, so a device that cannot
        // hold a key has no account either and there is nothing to show or submit.
        const key = gateKeyCoordinates(await ensureGateKey());
        address = (await getGateAddress()) as Address;
        if (!alive) return;
        payload = eventId === undefined ? undefined : { eventId, gateAccount: address, ...key };
      } catch {
        if (!alive) return;
        setState((previous) => ({ ...previous, status: 'creating', error: 'KEY_UNAVAILABLE' }));
        return;
      }

      setState((previous) => ({
        ...previous,
        address,
        payload,
        status: payload === undefined ? 'waiting' : 'submitting',
        error: undefined,
      }));

      if (payload !== undefined) {
        try {
          await submitPendingGate(payload);
          if (!alive) return;
          setState((previous) => ({
            ...previous,
            submitted: true,
            submittedAt: Date.now(),
            status: 'waiting',
            error: undefined,
          }));
        } catch (failure) {
          if (!alive) return;
          // 신청이 막히면 QR 폴백으로 관리자가 직접 입력한다. 폴링은 계속한다.
          setState((previous) => ({
            ...previous,
            submitted: false,
            status: 'waiting',
            error: submitError(failure),
          }));
        }
      }

      if (!alive) return;
      void poll(address);
    })();

    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [eventId, pollMs, attempt]);

  const resubmit = useCallback(() => setAttempt((previous) => previous + 1), []);

  return { ...state, resubmit };
}
