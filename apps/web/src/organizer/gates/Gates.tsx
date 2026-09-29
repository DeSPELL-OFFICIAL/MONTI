import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { encodeFunctionData } from 'viem';
import type { Hex } from 'viem';
import { Alert, Button, Field, Screen, Spinner } from '../../shared/ui';
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
import { UnsponsoredNotice } from '../Unsponsored';
import { readGateKey } from './gateKey';

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
 * lists that queue and puts a chosen entry on the event's allowlist with `registerGate`, then
 * opens and closes it. Nothing is granted before that write lands — a queued row has no
 * permission of any kind.
 *
 * The typed-in form beside the queue is the fallback for the evening when the staff app cannot
 * reach the backend: the same three values, read off the terminal's own screen, through the
 * same validation and the same write.
 */
export function Gates() {
  const { eventId = '' } = useParams();
  const organizer = useOrganizerCopy();
  const copy = organizer.gates;
  // The one sentence for "it is still on its way", shared with the lifecycle screens.
  const lifecycle = organizer.lifecycle;

  const [orgId, setOrgId] = useState<bigint | null>(null);
  const [mayManage, setMayManage] = useState<boolean | null>(null);
  const [pending, setPending] = useState<PendingGate[]>([]);
  const [registered, setRegistered] = useState<EnvioGate[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<GateProblem | ''>('');
  const [confirming, setConfirming] = useState(false);
  const [unsponsored, setUnsponsored] = useState(false);
  const [paste, setPaste] = useState(EMPTY_PASTE);
  const [reload, setReload] = useState(0);

  // The queue is members-only and the indexer is public, so neither failure may take the other
  // down: an organiser with a sleeping indexer must still be able to approve a terminal.
  useEffect(() => {
    if (eventId === '') return undefined;
    let cancelled = false;

    void (async () => {
      setLoading(true);
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
      setRegistered(gates.Gate);
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
      setConfirming(false);
      setUnsponsored(false);
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
      setUnsponsored(false);
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
      {confirming ? <Alert tone="info">{lifecycle.confirming}</Alert> : null}
      {unsponsored ? <UnsponsoredNotice /> : null}
      {busy ? <Alert tone="info">{copy.working}</Alert> : null}

      {mayManage === false ? <Alert tone="error">{copy.problems.notAllowed}</Alert> : null}

      {mayManage ? (
        <section>
          <h2>{copy.pending}</h2>
          {pending.length === 0 ? <p>{copy.none}</p> : null}
          <ul style={{ listStyle: 'none', padding: 0 }}>
            {pending.map((gate) => (
              <li key={gate.gateAccount} style={{ marginBottom: 12 }}>
                <p style={{ wordBreak: 'break-all' }}>
                  {copy.account} {gate.gateAccount}
                </p>
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
              <p style={{ wordBreak: 'break-all' }}>
                {copy.gateId} {gate.id} · {gate.account}
              </p>
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
                      {copy.open}
                    </Button>
                  )}
                  <Button variant="danger" disabled={busy} onClick={() => void send('revokeGate', [BigInt(gate.id)])}>
                    {copy.revoke}
                  </Button>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      {mayManage ? (
        <section>
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
        </section>
      ) : null}
    </Screen>
  );
}
