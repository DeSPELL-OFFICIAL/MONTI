import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { AttendeeRow } from '@monti/shared';
import { Alert, Button, Screen, Spinner } from '../shared/ui';
import { api } from '../shared/api/functions';
import { gql } from '../shared/envio/client';
import { EVENT_QUERY, type EnvioEvent, type EnvioTier } from '../shared/envio/queries';
import { fetchEventMetadata } from '../shared/envio/ipfs';
import { useEventRequests } from '../shared/envio/claimRequests';
import { Announce } from './Announce';
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
  const [title, setTitle] = useState('');
  // The metadata read has answered (either way) — until then a missing title is "loading", not
  // "unnamed".
  const [metaSettled, setMetaSettled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  // The cancel confirmation; nothing is sent without it.
  const [confirmingCancel, setConfirmingCancel] = useState(false);
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
      setIndexerTiers(indexed?.Tier ?? []);
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
    setMetaSettled(false);
    void fetchEventMetadata(imageCid)
      .then((loaded) => {
        if (!cancelled) setTitle(loaded.title);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setMetaSettled(true);
      });
    return () => {
      cancelled = true;
    };
  }, [imageCid]);

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

  if (loading) {
    return (
      <Screen title={dash.title}>
        <Spinner />
      </Screen>
    );
  }

  const entered = attendees.filter((row) => row.checkedIn).length;
  // The indexer's status when it has the row, the chain's while it lags. `chainStatus` already
  // applies the precedence (the indexer wins once it is not older than the chain), so it is the
  // source of truth for the actions even before the indexer's own row has reached this screen.
  const status = chainStatus.status || event?.status || '';
  // For an event the indexer has no row for yet, the readable title and start time are not on the
  // chain — they are in the organiser's own draft of the event they just made.
  const draftFallback = event === null ? createdDraftFor(eventId) : null;
  // While the indexer or the title document is still on its way, say so rather than "unnamed".
  const titleLoading = loading || (imageCid !== '' && !metaSettled);
  const shownTitle = title || draftFallback?.title || (titleLoading ? dash.art.titleLoading : dash.art.untitled);

  return (
    <Screen title={dash.title}>
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
        title={shownTitle}
        startsAt={Number(event?.startsAt ?? draftFallback?.startsAt ?? 0)}
      />

      {/* 정산 설정 (Batch D): per-tier price + revenue split, set before publish and read-only once the
          first ticket sells. Hidden by SettlementSection itself unless the feature is wired. */}
      <SettlementSection eventId={eventId} tiers={tiers} />

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
    </Screen>
  );
}
