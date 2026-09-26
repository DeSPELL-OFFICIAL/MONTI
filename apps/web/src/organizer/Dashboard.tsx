import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { AttendeeRow } from '@monti/shared';
import { Alert, Button, Screen, Spinner } from '../shared/ui';
import { api } from '../shared/api/functions';
import { readTicket } from '../shared/chain/reads';
import { gql } from '../shared/envio/client';
import { EVENT_QUERY, type EnvioEvent, type EnvioTier } from '../shared/envio/queries';
import { fetchEventMetadata } from '../shared/envio/ipfs';
import { useEventRequests } from '../shared/envio/claimRequests';
import { Announce } from './Announce';
import { useOrganizerCopy } from './copy';
import { EventArt } from './EventArt';
import { cancelEvent, publishEvent, type LifecycleResult } from './lifecycle';
import { UnsponsoredNotice } from './Unsponsored';

/** Which confirmation is open, if any. Neither write happens without one. */
type Pending = '' | 'publish' | 'cancel';

/**
 * The result of a lifecycle write, with the write that produced it.
 *
 * `which` is what the confirmation sentence is chosen from, never the event's `status`: the
 * refetch that follows a write races the indexer's own `EventStatusChanged`, so for the
 * seconds it is behind, `status` still says what the event *was* — and an organiser who just
 * cancelled would read 발행했어요. The action that ran is not in doubt.
 */
type Outcome = LifecycleResult & { which: Exclude<Pending, ''> };

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
  // The pending count beside the 신청 관리 link. Only an approvalRequired event has any, so an
  // ordinary event's empty answer (or an indexer that has not caught up) simply hides the count.
  const { requests: pendingRequests } = useEventRequests(eventId, 'Pending');

  const [event, setEvent] = useState<EnvioEvent | null>(null);
  const [tiers, setTiers] = useState<EnvioTier[]>([]);
  const [attendees, setAttendees] = useState<AttendeeRow[]>([]);
  const [title, setTitle] = useState('');
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState<Pending>('');
  const [outcome, setOutcome] = useState<Outcome | null>(null);
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

  // The event's readable name, for the ticket pictures below — the only thing on this screen
  // that needs it. It is asked for after the indexer answers because the CID comes from there,
  // and it never gates the screen: a gateway that will not answer costs the preview its title
  // and nothing else.
  const imageCid = event?.imageCid ?? '';
  useEffect(() => {
    if (imageCid === '') return undefined;
    let cancelled = false;
    void fetchEventMetadata(imageCid)
      .then((meta) => {
        if (!cancelled) setTitle(meta.title);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [imageCid]);

  async function run(which: Exclude<Pending, ''>): Promise<void> {
    setBusy(true);
    setOutcome(null);
    // The organisation comes from the chain, not from the indexer: the paymaster is paid per
    // organisation and an indexer running behind would sponsor the wrong one.
    const orgId = await readTicket()
      .eventOrg(BigInt(eventId))
      .catch(() => null);
    if (orgId === null || orgId === 0n) {
      setOutcome({ state: 'refused', problem: 'failed', which });
      setBusy(false);
      setPending('');
      return;
    }
    const result =
      which === 'publish' ? await publishEvent(BigInt(eventId), orgId) : await cancelEvent(BigInt(eventId), orgId);
    setOutcome({ ...result, which });
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
      {/* Both reads answered, and the indexer simply has no row: a number that was mistyped on
          the home screen, or an event created a moment ago. Neither is a failure, and neither
          is a blank screen with no writes offered and no reason given. */}
      {!failed && event === null ? <Alert tone="warn">{dash.notIndexed}</Alert> : null}

      {outcome?.state === 'unsponsored' ? <UnsponsoredNotice /> : null}
      {outcome?.state === 'confirming' ? <Alert tone="info">{life.confirming}</Alert> : null}
      {outcome?.state === 'refused' ? <Alert tone="error">{life[outcome.problem]}</Alert> : null}
      {/* The sentence comes from the write that ran, not from an indexer that may be behind. */}
      {outcome?.state === 'done' ? (
        <Alert tone="info">{outcome.which === 'cancel' ? life.cancelled : life.published}</Alert>
      ) : null}
      {busy ? <Alert tone="info">{life.working}</Alert> : null}

      {pending === '' ? (
        <>
          {/* Editing closes the moment the event is published — `updateEventMeta` reverts
              `NotDraft` (`Ticket.sol:235`) — so the way in is offered only while it is open. */}
          {status === 'Draft' ? (
            <p>
              <Link to={`/org/events/${eventId}/edit`}>{dash.edit}</Link>
            </p>
          ) : null}
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

      {/* Shown whatever the status is: the picture is the one part of a ticket that stays
          editable once the event is public, which is exactly why it is not on the chain. */}
      <EventArt
        eventId={eventId}
        tiers={tiers}
        title={title === '' ? dash.art.untitled : title}
        startsAt={Number(event?.startsAt ?? 0)}
      />

      <Announce eventId={eventId} />

      <p>
        <Link to={`/org/events/${eventId}/gates`}>{dash.gates}</Link>
      </p>

      {/* Only an approvalRequired event has a request queue; the count rides along when there is one. */}
      {event?.approvalRequired ? (
        <p>
          <Link to={`/org/events/${eventId}/requests`}>
            {dash.requests}
            {pendingRequests.length > 0 ? ` (${pendingRequests.length})` : ''}
          </Link>
        </p>
      ) : null}
    </Screen>
  );
}
