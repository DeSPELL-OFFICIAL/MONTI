import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { encodeFunctionData } from 'viem';
import type { Hex } from 'viem';
import { Alert, Button, CopyValue, Field, Screen, Spinner } from '../../shared/ui';
import { shortId } from '../../shared/shortId';
import { api, type PendingGate } from '../../shared/api/functions';
import { organizersAbi } from '../../shared/chain/abis';
import { getStaffAccount } from '../../shared/chain/accounts';
import { PERM_MANAGE_GATES } from '../../shared/chain/permissions';
import { readOrganizers, readTicket } from '../../shared/chain/reads';
import { sendAction } from '../../shared/relay/sendAction';
import { relayProblem } from '../../shared/relay/relayError';
import { gql } from '../../shared/envio/client';
import { GATES_QUERY, type EnvioGate } from '../../shared/envio/queries';
import { useOrganizerCopy, type OrganizerCopy } from '../copy';
import { fmt } from '../../shared/i18n';
import { readGateKey } from './gateKey';
import { useEventGatesWithFallback } from '../useEventGatesWithFallback';

type GateProblem = keyof OrganizerCopy['gates']['problems'];

/** Every refusal `Organizers` can answer these four writes with, against the rule it names. */
const GATE_REVERTS: ReadonlyArray<readonly [string, GateProblem]> = [
  ['GateAccountInUse', 'inUse'],
  ['InvalidGateKey', 'halfZero'],
  ['Unauthorized', 'notAllowed'],
  ['UnknownGate', 'unknownGate'],
  ['GateIsRevoked', 'alreadyRevoked'],
  ['ZeroAddress', 'account'],
  // `registerGate` raises this for an event that does not exist (`Organizers.sol:127`). Telling
  // the organiser to try again for a number that will never work is worse than saying nothing.
  ['UnknownOrganizer', 'unknownEvent'],
];

type GateWrite = 'registerGate' | 'openGate' | 'closeGate' | 'revokeGate';

const EMPTY_PASTE = { gateAccount: '', kx: '', ky: '' };

/**
 * The organiser's half of spec §5.7 step 1. The staff terminal makes its own key in its secure
 * chip and submits the public half through the backend (`submitPendingGate`); this screen
 * lists that queue and puts a chosen entry on the event's allowlist with `registerGate`, which
 * opens it in the same write (v2, design D3) — there is no separate 열기 step. 닫기 pauses a door
 * and 다시 열기 undoes only that; 폐기 is final. Nothing is granted before the register write
 * lands — a queued row has no permission of any kind.
 *
 * The typed-in form beside the queue is the fallback for the evening when the staff app cannot
 * reach the backend: the same three values, read off the terminal's own screen, through the
 * same validation and the same write.
 */
export function Gates() {
  const { eventId = '' } = useParams();
  const organizer = useOrganizerCopy();
  const copy = organizer.gates;

  const [orgId, setOrgId] = useState<bigint | null>(null);
  const [mayManage, setMayManage] = useState<boolean | null>(null);
  const [pending, setPending] = useState<PendingGate[]>([]);
  const [indexerGates, setIndexerGates] = useState<EnvioGate[] | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<GateProblem | ''>('');
  const [paste, setPaste] = useState(EMPTY_PASTE);
  const [reload, setReload] = useState(0);
  // The gate whose 폐기 is waiting on its confirmation, or null.
  const [revoking, setRevoking] = useState<string | null>(null);

  // 인덱서가 0행으로 정착하면 체인 로그(GateRegistered)에서 등록된 단말기를 직접 세운다 — 방금
  // 등록한 게이트의 열기 버튼이 인덱서(Envio)를 기다리지 않게. 인덱서에 행이 있으면 그대로 쓴다.
  const { gates: registered } = useEventGatesWithFallback(eventId, indexerGates);

  // The queue is members-only and the indexer is public, so neither failure may take the other
  // down: an organiser with a sleeping indexer must still be able to approve a terminal.
  useEffect(() => {
    if (eventId === '') return undefined;
    let cancelled = false;

    void (async () => {
      setLoading(true);
      setIndexerGates(undefined);
      // The staff console bootstrap reads the same `eventOrg` to pass `orgId` into sub-plan
      // 04's `useGate`; the permission bit is the one `registerGate` itself demands.
      const org = await readTicket()
        .eventOrg(BigInt(eventId))
        .catch(() => null);
      if (cancelled) return;
      setOrgId(org);

      // The signed-in passkey account, which is the same one the session carries; reading it
      // here rather than from the session store keeps this screen testable on its own.
      const account = await getStaffAccount()
        .then((staff) => staff.address as Hex)
        .catch(() => null);
      const allowed =
        org === null || org === 0n || account === null
          ? false
          : await readOrganizers()
              .hasPermission(org, account, PERM_MANAGE_GATES)
              .catch(() => false);
      if (cancelled) return;
      setMayManage(allowed);

      const [queue, gates] = await Promise.all([
        allowed ? api.listPendingGates({ eventId }).catch(() => [] as PendingGate[]) : Promise.resolve([]),
        gql<{ Gate: EnvioGate[] }>(GATES_QUERY, { eventId }).catch(() => ({ Gate: [] as EnvioGate[] })),
      ]);
      if (cancelled) return;
      setPending(queue);
      setIndexerGates(gates.Gate);
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [eventId, reload]);

  const send = useCallback(
    async (functionName: GateWrite, args: readonly unknown[]): Promise<void> => {
      if (orgId === null) return;
      setBusy(true);
      setProblem('');
      try {
        await sendAction(functionName, 'organizers', encodeFunctionData({ abi: organizersAbi, functionName, args }));
        setPaste(EMPTY_PASTE);
        setReload((count) => count + 1);
      } catch (cause) {
        // The relayer bubbles the target's Solidity error name; `relayProblem` maps it, and a
        // refusal that names nothing falls through to one sentence. The list is reloaded either
        // way, so whatever did land shows up in it.
        setProblem(relayProblem(cause, GATE_REVERTS) ?? 'failed');
        setReload((count) => count + 1);
      } finally {
        setBusy(false);
      }
    },
    [orgId],
  );

  function register(input: { gateAccount: string; kx: string; ky: string }): void {
    const read = readGateKey(input);
    if ('problem' in read) {
      setProblem(read.problem);
      return;
    }
    void send('registerGate', [BigInt(eventId), read.args.gateAccount, read.args.kx, read.args.ky]);
  }

  if (loading) {
    return (
      <Screen title={copy.title}>
        <Spinner />
      </Screen>
    );
  }

  return (
    <Screen title={copy.title}>
      {problem === '' ? null : <Alert tone="error">{copy.problems[problem]}</Alert>}
      {busy ? <Alert tone="info">{copy.working}</Alert> : null}

      {mayManage === false ? <Alert tone="error">{copy.problems.notAllowed}</Alert> : null}

      {mayManage ? (
        <section>
          <h2>{copy.pending}</h2>
          <p className="muted">{copy.registerHelp}</p>
          {pending.length === 0 ? <p>{copy.none}</p> : null}
          <ul style={{ listStyle: 'none', padding: 0 }}>
            {pending.map((gate) => (
              <li key={gate.gateAccount} style={{ marginBottom: 12 }}>
                {/* A short name to match against the terminal's own screen; the full value is under 상세. */}
                <p data-gate-account={gate.gateAccount}>
                  {copy.pendingLabel} · <span className="mono">{shortId(gate.gateAccount)}</span>
                </p>
                <details className="more">
                  <summary>{copy.gateDetails}</summary>
                  <p>{copy.account}</p>
                  <CopyValue value={gate.gateAccount} copyLabel={copy.copyValue} copiedLabel={copy.copiedValue} />
                </details>
                <p style={{ color: 'var(--muted)', fontSize: 13 }}>
                  {copy.submittedAt} {new Date(gate.submittedAt).toLocaleString()}
                </p>
                <Button disabled={busy} onClick={() => register(gate)}>
                  {copy.register}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section>
        <h2>{copy.registered}</h2>
        {registered.length === 0 ? <p>{copy.noneRegistered}</p> : null}
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {registered.map((gate) => (
            <li key={gate.id} style={{ marginBottom: 12 }}>
              {/* The number a person can say out loud; the raw address waits under 상세. */}
              <p data-gate-account={gate.account}>
                {fmt(copy.gateLabel, { n: gate.id })} · <span className="mono">{shortId(gate.account)}</span>
              </p>
              <details className="more">
                <summary>{copy.gateDetails}</summary>
                <p>{copy.account}</p>
                <CopyValue value={gate.account} copyLabel={copy.copyValue} copiedLabel={copy.copiedValue} />
              </details>
              {/* The indexer's column is `isOpen`, after the contract view `isOpenGate`. */}
              <p>{gate.revoked ? copy.isRevoked : gate.isOpen ? copy.isOpen : copy.isClosed}</p>
              {mayManage && !gate.revoked ? (
                <>
                  {gate.isOpen ? (
                    <Button variant="ghost" disabled={busy} onClick={() => void send('closeGate', [BigInt(gate.id)])}>
                      {copy.close}
                    </Button>
                  ) : (
                    <Button disabled={busy} onClick={() => void send('openGate', [BigInt(gate.id)])}>
                      {copy.reopen}
                    </Button>
                  )}
                  {/* 폐기 cannot be undone, so it asks first (the same in-place warning 행사 취소 uses). */}
                  {revoking === gate.id ? (
                    <Alert tone="warn">
                      {copy.revokeConfirm}
                      <Button
                        variant="danger"
                        disabled={busy}
                        onClick={() => {
                          setRevoking(null);
                          void send('revokeGate', [BigInt(gate.id)]);
                        }}
                      >
                        {copy.revoke}
                      </Button>
                      <Button variant="ghost" disabled={busy} onClick={() => setRevoking(null)}>
                        {copy.revokeKeep}
                      </Button>
                    </Alert>
                  ) : (
                    <Button variant="danger" disabled={busy} onClick={() => setRevoking(gate.id)}>
                      {copy.revoke}
                    </Button>
                  )}
                </>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      {mayManage ? (
        // The typed-in fallback is folded away: on a normal evening the queue above is the way in,
        // and three empty hex boxes up front read as the job.
        <details className="more">
          <summary>{copy.manualSummary}</summary>
          <p style={{ color: 'var(--muted)', fontSize: 13 }}>{copy.manualHelp}</p>
          <Field label={copy.account}>
            <input
              value={paste.gateAccount}
              inputMode="text"
              autoComplete="off"
              onChange={(event) => setPaste({ ...paste, gateAccount: event.target.value })}
            />
          </Field>
          <Field label={copy.kx}>
            <input
              value={paste.kx}
              inputMode="text"
              autoComplete="off"
              onChange={(event) => setPaste({ ...paste, kx: event.target.value })}
            />
          </Field>
          <Field label={copy.ky}>
            <input
              value={paste.ky}
              inputMode="text"
              autoComplete="off"
              onChange={(event) => setPaste({ ...paste, ky: event.target.value })}
            />
          </Field>
          <Button disabled={busy} onClick={() => register(paste)}>
            {copy.manual}
          </Button>
        </details>
      ) : null}
    </Screen>
  );
}
