import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { AttendeeRow } from '@monti/shared';
import { Alert, Button, Screen, Spinner } from '../shared/ui';
import { api } from '../shared/api/functions';
import { gql } from '../shared/envio/client';
import { EVENT_QUERY, type EnvioEvent, type EnvioTier } from '../shared/envio/queries';
import { useEventTitles } from '../shared/envio/useEventTitles';
import { fmt } from '../shared/i18n';
import { useEventRequests } from '../shared/envio/claimRequests';
import { Announce } from './Announce';
import { attendeeLabel } from './attendeeLabel';
import { SettlementSection } from './settlement/SettlementSection';
import { useOrganizerCopy } from './copy';
import { EventArt } from './EventArt';
import { cancelEvent, type LifecycleResult } from './lifecycle';
import { createdDraftFor } from './useEventDraft';
import { useEventStatusWithFallback } from './useEventStatusWithFallback';
import { useEventTiersWithFallback } from './useEventTiersWithFallback';

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
  // The status 취소 gates on, from the indexer when it has the row and from the chain while it
  // lags — so a just-published event can be cancelled before the indexer has caught up.
  const chainStatus = useEventStatusWithFallback(eventId);

  const [event, setEvent] = useState<EnvioEvent | null>(null);
  const [indexerTiers, setIndexerTiers] = useState<EnvioTier[]>([]);
  const [attendees, setAttendees] = useState<AttendeeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [attendeesLoading, setAttendeesLoading] = useState(true);
  // Both reads failing is the one outage worth an alert; either alone leaves the other half usable.
  const [indexFailed, setIndexFailed] = useState(false);
  const [attendeesFailed, setAttendeesFailed] = useState(false);
  const failed = indexFailed && attendeesFailed;
  // The cancel confirmation; nothing is sent without it.
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [outcome, setOutcome] = useState<LifecycleResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);

  // The indexer row and the attendee list are two independent reads, and the callable is the
  // slow one (a cold start runs to seconds). The screen waits on the indexer only: the event,
  // its title read and the notices start as soon as it answers, and the attendee list fills in
  // on its own when the callable does.
  useEffect(() => {
    if (eventId === '') return undefined;
    let cancelled = false;
    setLoading(true);
    setAttendeesLoading(true);
    setIndexFailed(false);
    setAttendeesFailed(false);

    void gql<{ Event: EnvioEvent[]; Tier: EnvioTier[] }>(EVENT_QUERY, { id: eventId, eventId })
      .catch(() => null)
      .then((indexed) => {
        if (cancelled) return;
        setEvent(indexed?.Event[0] ?? null);
        setIndexerTiers(indexed?.Tier ?? []);
        setIndexFailed(indexed === null);
        setLoading(false);
      });
    void api
      .listAttendees({ eventId })
      .catch(() => null)
      .then((rows) => {
        if (cancelled) return;
        setAttendees(rows ?? []);
        setAttendeesFailed(rows === null);
        setAttendeesLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [eventId, reload]);

  // The event's readable name, for the header and the ticket pictures. The CID comes from the
  // indexer, and the read is the one the organiser home already made for its list (same query
  // key), so arriving from there names the event at once. It never gates the screen: a gateway
  // that will not answer costs the header its name and nothing else.
  const imageCid = event?.imageCid ?? '';
  const titleState = useEventTitles([{ eventId, imageCid }])(eventId);
  const title = titleState.title;

  // 정산 설정's price inputs are keyed to the tiers, and the tiers exist on the chain the moment
  // the event is created — but the hosted indexer can lag it by minutes. Read them from the chain
  // while the indexer has no Tier row yet, so a fresh event's price fields appear and the policy
  // can be confirmed; the indexer's (richer) rows take over the moment they arrive.
  const { tiers } = useEventTiersWithFallback(eventId, loading ? undefined : indexerTiers);

  async function cancel(): Promise<void> {
    setBusy(true);
    setOutcome(null);
    const result = await cancelEvent(BigInt(eventId));
    setOutcome(result);
    setBusy(false);
    setConfirmingCancel(false);
    if (result.state === 'done') {
      setReload((count) => count + 1);
      // The chain has moved; re-read it so 취소 disappears even while the indexer is behind.
      chainStatus.refetch();
    }
  }

  // Until the name resolves the event goes by its number, never by a blank header.
  const placeholder = fmt(copy.home.eventFallback, { id: eventId });

  const entered = attendees.filter((row) => row.checkedIn).length;
  // The indexer's status when it has the row, the chain's while it lags. `chainStatus` already
  // applies the precedence (the indexer wins once it is not older than the chain), so it is the
  // source of truth for the actions even before the indexer's own row has reached this screen.
  const status = chainStatus.status || event?.status || '';
  // For an event the indexer has no row for yet, the readable title and start time are not on the
  // chain — they are in the organiser's own draft of the event they just made.
  const draftFallback = event === null ? createdDraftFor(eventId) : null;
  // While the indexer or the title document is still on its way, say so rather than "unnamed".
  const titleLoading = imageCid !== '' && titleState.status === 'loading';
  const shownTitle = title || draftFallback?.title || (titleLoading ? dash.art.titleLoading : dash.art.untitled);

  return (
    <Screen title={title || draftFallback?.title || placeholder}>
      {/* Everything above the notices waits on the indexer row. The notices do not: they are their
          own callable, and mounting them only after the indexer answered queued their read behind
          it (and behind a cold start), which kept "Loading the notices" up for seconds. They sit at
          one fixed place in the tree so the indexer answering never remounts them. */}
      {loading ? (
        <Spinner />
      ) : (
        <>
          {failed ? <Alert tone="error">{dash.failed}</Alert> : null}
          {/* The indexer has no row and the chain has no such event either: a number that was mistyped
              on the home screen. When the chain *does* have it (an event created a moment ago), the row
              below is rendered from the chain status instead — no warning, and the writes are offered. */}
          {!failed && event === null && chainStatus.source === 'none' && !chainStatus.loading ? (
            <Alert tone="warn">{dash.notIndexed}</Alert>
          ) : null}

          {outcome?.state === 'refused' ? <Alert tone="error">{life[outcome.problem]}</Alert> : null}
          {/* The sentence comes from the write that ran, not from an indexer that may be behind. */}
          {outcome?.state === 'done' ? <Alert tone="info">{life.cancelled}</Alert> : null}
          {busy ? <Alert tone="info">{life.working}</Alert> : null}

          <h2>{dash.title}</h2>
          <table className="status-table">
            <tbody>
              {tiers.map((tier) => (
                <tr key={tier.id}>
                  <td title={tier.name}>{tier.name}</td>
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

          {attendeesLoading ? null : (
            <p>
              {dash.checkins} {entered} / {attendees.length}
            </p>
          )}

          <h2>{dash.attendees}</h2>
          {attendeesLoading ? <Spinner /> : null}
          {!attendeesLoading && attendees.length === 0 ? <p>{dash.none}</p> : null}
          <ul className="event-list attendee-list">
            {attendees.map((row) => {
              const label = attendeeLabel(row, dash.guest);
              return (
                <li key={row.tokenId} className="attendee-row">
                  <span className="attendee-row__name" title={label}>
                    {label}
                  </span>
                  <span className="attendee-row__chips">
                    <span className={`badge${row.checkedIn ? ' badge--ok' : ''}`}>
                      {row.checkedIn ? dash.checkedIn : dash.notCheckedIn}
                    </span>
                    <span className={`badge${row.kycLevel >= 1 ? ' badge--ok' : ''}`}>
                      {dash.kyc} {row.kycLevel >= 1 ? dash.kycYes : dash.kycNo}
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>

          {/* Shown whatever the status is: the picture is the one part of a ticket that stays
              editable once the event is public, which is exactly why it is not on the chain. */}
          <EventArt
            eventId={eventId}
            tiers={tiers}
            title={shownTitle}
            startsAt={Number(event?.startsAt ?? draftFallback?.startsAt ?? 0)}
          />

          {/* 정산 설정 (Batch D): per-tier price + revenue split, set before publish and read-only once the
              first ticket sells. Hidden by SettlementSection itself unless the feature is wired. */}
          <SettlementSection eventId={eventId} tiers={tiers} />
        </>
      )}

      <Announce eventId={eventId} />

      {loading ? null : (
        <>
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

          {/* 행사 취소 is the one irreversible write here, so it sits at the very foot as a quiet
              button, and asks before it sends anything. */}
          {!confirmingCancel && status === 'Published' ? (
            <Button variant="ghost" onClick={() => setConfirmingCancel(true)}>
              {life.cancel}
            </Button>
          ) : null}
          {confirmingCancel ? (
            <Alert tone="warn">
              {life.cancelConfirm}
              <Button variant="danger" disabled={busy} onClick={() => void cancel()}>
                {life.confirm}
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => setConfirmingCancel(false)}>
                {life.back}
              </Button>
            </Alert>
          ) : null}
        </>
      )}
    </Screen>
  );
}
