import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { AttendeeRow } from '@monti/shared';
import { Alert, Button, Screen, Spinner } from '../shared/ui';
import { api } from '../shared/api/functions';
import { readTicket } from '../shared/chain/reads';
import { gql } from '../shared/envio/client';
import { EVENT_QUERY, type EnvioEvent, type EnvioTier } from '../shared/envio/queries';
import { Announce } from './Announce';
import { useOrganizerCopy } from './copy';
import { cancelEvent, publishEvent, type LifecycleResult } from './lifecycle';
import { UnsponsoredNotice } from './Unsponsored';

/** Which confirmation is open, if any. Neither write happens without one. */
type Pending = '' | 'publish' | 'cancel';

/**
 * One event, from the indexer. Every number on this screen is a chain fact the indexer already
 * has — how many of each kind went out, how many came in — and the attendee list is
 * `listAttendees`, which is the indexer read the server is allowed to make on the organiser's
 * behalf. No phone number, no legal name and no photograph appears anywhere on this screen or
 * in anything it asks for; the only human-readable thing here is the nickname somebody chose.
 */
export function Dashboard() {
  const { eventId = '' } = useParams();
  const copy = useOrganizerCopy();
  const dash = copy.dashboard;
  const life = copy.lifecycle;

  const [event, setEvent] = useState<EnvioEvent | null>(null);
  const [tiers, setTiers] = useState<EnvioTier[]>([]);
  const [attendees, setAttendees] = useState<AttendeeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState<Pending>('');
  const [outcome, setOutcome] = useState<LifecycleResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (eventId === '') return undefined;
    let cancelled = false;

    void (async () => {
      setLoading(true);
      const [indexed, rows] = await Promise.all([
        gql<{ Event: EnvioEvent[]; Tier: EnvioTier[] }>(EVENT_QUERY, { id: eventId, eventId }).catch(() => null),
        api.listAttendees({ eventId }).catch(() => null),
      ]);
      if (cancelled) return;
      setEvent(indexed?.Event[0] ?? null);
      setTiers(indexed?.Tier ?? []);
      setAttendees(rows ?? []);
      setFailed(indexed === null && rows === null);
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [eventId, reload]);

  async function run(which: Exclude<Pending, ''>): Promise<void> {
    setBusy(true);
    setOutcome(null);
    // The organisation comes from the chain, not from the indexer: the paymaster is paid per
    // organisation and an indexer running behind would sponsor the wrong one.
    const orgId = await readTicket()
      .eventOrg(BigInt(eventId))
      .catch(() => null);
    if (orgId === null || orgId === 0n) {
      setOutcome({ state: 'refused', problem: 'failed' });
      setBusy(false);
      setPending('');
      return;
    }
    const result =
      which === 'publish' ? await publishEvent(BigInt(eventId), orgId) : await cancelEvent(BigInt(eventId), orgId);
    setOutcome(result);
    setBusy(false);
    setPending('');
    if (result.state === 'done') setReload((count) => count + 1);
  }

  if (loading) {
    return (
      <Screen title={dash.title}>
        <Spinner />
      </Screen>
    );
  }

  const entered = attendees.filter((row) => row.checkedIn).length;
  const status = event?.status ?? '';

  return (
    <Screen title={dash.title}>
      {failed ? <Alert tone="error">{dash.failed}</Alert> : null}

      {outcome?.state === 'unsponsored' ? <UnsponsoredNotice /> : null}
      {outcome?.state === 'confirming' ? <Alert tone="info">{life.confirming}</Alert> : null}
      {outcome?.state === 'refused' ? <Alert tone="error">{life[outcome.problem]}</Alert> : null}
      {outcome?.state === 'done' ? <Alert tone="info">{status === 'Cancelled' ? life.cancelled : life.published}</Alert> : null}
      {busy ? <Alert tone="info">{life.working}</Alert> : null}

      {pending === '' ? (
        <>
          {status === 'Draft' ? <Button onClick={() => setPending('publish')}>{life.publish}</Button> : null}
          {status === 'Draft' || status === 'Published' ? (
            <Button variant="danger" onClick={() => setPending('cancel')}>
              {life.cancel}
            </Button>
          ) : null}
        </>
      ) : (
        <Alert tone="warn">
          {pending === 'publish' ? life.publishConfirm : life.cancelConfirm}
          <Button disabled={busy} onClick={() => void run(pending)}>
            {life.confirm}
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => setPending('')}>
            {life.back}
          </Button>
        </Alert>
      )}

      <table>
        <tbody>
          {tiers.map((tier) => (
            <tr key={tier.id}>
              <td>{tier.name}</td>
              <td>
                {dash.sold} {tier.minted}
              </td>
              <td>
                {dash.remaining} {BigInt(tier.supply) - BigInt(tier.minted)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <p>
        {dash.checkins} {entered} / {attendees.length}
      </p>

      <h2>{dash.attendees}</h2>
      {attendees.length === 0 ? <p>{dash.none}</p> : null}
      <ul style={{ listStyle: 'none', padding: 0 }}>
        {attendees.map((row) => (
          <li key={row.tokenId}>
            {row.nickname} · {row.checkedIn ? dash.checkedIn : dash.notCheckedIn} · {dash.kyc}{' '}
            {row.kycLevel >= 1 ? dash.kycYes : dash.kycNo}
          </li>
        ))}
      </ul>

      <Announce eventId={eventId} />

      <p>
        <Link to={`/org/events/${eventId}/gates`}>{dash.gates}</Link>
      </p>
    </Screen>
  );
}
