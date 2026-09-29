import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { encodeFunctionData } from 'viem';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, EmptyState, OpProgress, Screen, Spinner } from '../../shared/ui';
import { fmt } from '../../shared/i18n';
import { gql } from '../../shared/envio/client';
import {
  EVENT_QUERY,
  IDENTITY_NAMES_QUERY,
  type EnvioEvent,
  type EnvioIdentityAccount,
  type EnvioTier,
} from '../../shared/envio/queries';
import { useEventRequests } from '../../shared/envio/claimRequests';
import { ticketAbi } from '../../shared/chain/abis';
import { sendAction } from '../../shared/relay/sendAction';
import { useMyOrgs } from '../useMyOrgs';
import { useOrganizerCopy } from '../copy';

/**
 * approveClaims/rejectClaims take a `uint256[]` of request ids. Each approval mints, and the
 * contracts report measured ~20 mints as a comfortable batch under the block gas limit, so a
 * selection larger than this goes out as several sponsored ops rather than one that would run out.
 */
const BATCH_SIZE = 20;
/** How often the open 신청 관리 screen re-reads the pending list, so a lagging ClaimRequest and a
 *  decision made elsewhere both surface without a reload. Paused while the tab is hidden. */
const REQUESTS_POLL_MS = 10_000;
/** `wait` gave up before the op landed — not a failure, it may still be on its way. */
const STILL_CONFIRMING = 'TIMEOUT';

function chunk<T>(items: readonly T[], size: number): T[][] {
  const groups: T[][] = [];
  for (let index = 0; index < items.length; index += size) groups.push(items.slice(index, index + size));
  return groups;
}

/**
 * `0x1234…abcd` for an account that never chose a nickname — still recognisable without showing all
 * 42 characters. It is the only thing shown for such a requester: the indexer holds no phone number
 * and no legal name, and this screen shows neither.
 */
function maskAccount(account: string): string {
  return account.length > 12 ? `${account.slice(0, 6)}…${account.slice(-4)}` : account;
}

/**
 * 신청 관리 — an organiser approves or rejects the requests waiting on an approvalRequired event.
 * The list is the indexer's pending set; a decision goes on chain in batches and the list refetches
 * to the truth afterwards. The screen is gated on the same three roles the contract accepts: the
 * owner, an admin holding PERM_APPROVE_CLAIM, or a manager with canApprove.
 */
export function Requests() {
  const copy = useOrganizerCopy().requests;
  const { eventId = '' } = useParams();

  // The event, for its organisation: the paymaster is paid per organisation and the gate is per
  // organisation, so both need the orgId this event belongs to. Its org never changes, so the
  // indexer's value is safe to sponsor with (unlike a status that can race a fresh write).
  const { data: eventData, isLoading: eventLoading } = useQuery({
    queryKey: ['event', eventId],
    queryFn: () => gql<{ Event: EnvioEvent[]; Tier: EnvioTier[] }>(EVENT_QUERY, { id: eventId, eventId }),
    enabled: eventId !== '',
  });
  const event = eventData?.Event[0];
  const orgId = event?.orgId;

  const { orgs, isLoading: orgsLoading } = useMyOrgs();
  const mayApprove = orgId !== undefined && orgs.some((org) => org.orgId === orgId && org.canApprove);

  const { requests, isLoading, isError, refetch } = useEventRequests(eventId, 'Pending');

  // One round trip resolves every waiting requester to a nickname; anyone the index has no name for
  // falls back to the masked account below.
  const accounts = useMemo(() => [...new Set(requests.map((request) => request.requester))], [requests]);
  const { data: nameRows } = useQuery({
    queryKey: ['identityNames', accounts.join(',')],
    queryFn: async () => {
      const { IdentityAccount } = await gql<{ IdentityAccount: EnvioIdentityAccount[] }>(
        IDENTITY_NAMES_QUERY,
        { accounts },
      );
      return IdentityAccount;
    },
    enabled: accounts.length > 0,
  });
  const names = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of nameRows ?? []) if (row.nickname) map.set(row.id.toLowerCase(), row.nickname);
    return map;
  }, [nameRows]);

  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [done, setDone] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');

  // Optimistically hidden the moment a decision is sent; the refetch below then reconciles.
  const visible = requests.filter((request) => !done.has(request.requestId));

  const act = useCallback(
    async (ids: readonly string[], functionName: 'approveClaims' | 'rejectClaims') => {
      if (!event || ids.length === 0) return;
      setBusy(true);
      setError('');
      setConfirming(false);
      setDone((prev) => new Set([...prev, ...ids]));
      try {
        // ≤ BATCH_SIZE ids per relayed action — a bigger selection goes out in several in turn.
        for (const group of chunk(ids, BATCH_SIZE)) {
          await sendAction(
            functionName,
            'ticket',
            encodeFunctionData({ abi: ticketAbi, functionName, args: [BigInt(eventId), group.map((id) => BigInt(id))] }),
          );
        }
        setSelected(new Set());
      } catch {
        // A refusal: the rows never moved, so let them back into the list at once. (sendAction
        // follows the relay doc to a settled answer, so there is no in-flight timeout to keep.)
        setError(copy.failed);
        setDone((prev) => new Set([...prev].filter((id) => !ids.includes(id))));
      } finally {
        setBusy(false);
        // The indexer lags the decision, so a single refetch would show the rows still pending and
        // undo the optimistic hide. Refresh now for the fast path; the 10s poll and the reconcile
        // effect below keep the acted rows hidden until the flip actually lands.
        void refetch().catch(() => []);
      }
    },
    [event, eventId, refetch, copy.failed],
  );

  const toggle = (requestId: string): void =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(requestId)) next.delete(requestId);
      else next.add(requestId);
      return next;
    });

  // Keep the pending list fresh while the screen is open: a new request (which can lag the chain by
  // minutes) appears on its own, and a decision reconciles here. Polled through a ref so react-query
  // handing back a fresh refetch each render does not reset the timer; paused while the tab is hidden.
  const refetchRef = useRef(refetch);
  refetchRef.current = refetch;
  useEffect(() => {
    if (!mayApprove || eventId === '') return undefined;
    let live = true;
    let handle: ReturnType<typeof setTimeout> | undefined;
    const tick = async (): Promise<void> => {
      if (!live) return;
      if (!document.hidden) await refetchRef.current().catch(() => []);
      if (live) handle = setTimeout(() => void tick(), REQUESTS_POLL_MS);
    };
    handle = setTimeout(() => void tick(), REQUESTS_POLL_MS);
    return () => {
      live = false;
      if (handle !== undefined) clearTimeout(handle);
    };
  }, [mayApprove, eventId]);

  // Reconcile the optimistic hide against the indexer: a row stays hidden only while it is still in
  // the pending set. Once a decision is indexed the row leaves that set and is dropped from `done`;
  // a refused op left the row in the set, so it comes back on its own.
  useEffect(() => {
    setDone((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set([...prev].filter((id) => requests.some((request) => request.requestId === id)));
      return next.size === prev.size ? prev : next;
    });
  }, [requests]);

  if (eventLoading || orgsLoading) {
    return (
      <Screen title={copy.title}>
        <Spinner />
      </Screen>
    );
  }

  if (!mayApprove) {
    return (
      <Screen title={copy.title}>
        <p>
          <Link to={`/org/events/${eventId}`}>{copy.back}</Link>
        </p>
        <Alert tone="warn">{copy.noPermission}</Alert>
      </Screen>
    );
  }

  return (
    <Screen title={copy.title}>
      <p>
        <Link to={`/org/events/${eventId}`}>{copy.back}</Link>
      </p>

      {isError ? (
        <>
          <Alert tone="error">{copy.loadFailed}</Alert>
          <Button variant="ghost" onClick={() => void refetch()}>
            {copy.retry}
          </Button>
        </>
      ) : null}
      {confirming ? <Alert tone="info">{copy.confirming}</Alert> : null}
      {error ? <Alert tone="error">{error}</Alert> : null}
      {/* The determinate wait for approve/reject, in place of a bare "처리하고 있어요" (plan §2c). */}
      {busy ? <OpProgress phase="saving" /> : null}
      {/* The list re-reads itself every few seconds, so a lagging request and a decision made
          elsewhere both surface without a reload. */}
      {/* The re-poll hint belongs beside a list that is being watched — not stranded over an
          empty screen, where the centred empty state says all there is to say (visual R1-4). */}
      {visible.length > 0 ? <p className="muted">{copy.checking}</p> : null}

      {isLoading ? <Spinner /> : null}
      {!isLoading && visible.length === 0 ? <EmptyState>{copy.empty}</EmptyState> : null}

      {visible.length > 0 ? (
        <>
          <Card>
            <ul style={{ listStyle: 'none', padding: 0 }}>
              {visible.map((request) => (
                <li key={request.requestId}>
                  <label>
                    <input
                      type="checkbox"
                      checked={selected.has(request.requestId)}
                      onChange={() => toggle(request.requestId)}
                    />
                    {names.get(request.requester) ?? maskAccount(request.requester)}
                    <span className="muted"> · {fmt(copy.tier, { tier: request.tier + 1 })}</span>
                  </label>
                </li>
              ))}
            </ul>
          </Card>

          <Button disabled={busy || selected.size === 0} onClick={() => void act([...selected], 'approveClaims')}>
            {copy.approveSelected}
          </Button>
          <Button disabled={busy} onClick={() => void act(visible.map((request) => request.requestId), 'approveClaims')}>
            {copy.approveAll}
          </Button>
          <Button
            variant="danger"
            disabled={busy || selected.size === 0}
            onClick={() => void act([...selected], 'rejectClaims')}
          >
            {copy.reject}
          </Button>
        </>
      ) : null}
    </Screen>
  );
}
