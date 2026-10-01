import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { AttendeeRow } from '@monti/shared';
import { Alert, Button, Screen, Sheet, Spinner } from '../shared/ui';
import { fmt, useLocale } from '../shared/i18n';
import { api } from '../shared/api/functions';
import { readTicket } from '../shared/chain/reads';
import { gql } from '../shared/envio/client';
import { EVENT_QUERY, type EnvioEvent, type EnvioTier } from '../shared/envio/queries';
import { fetchEventMetadata, type EventMetadata } from '../shared/envio/ipfs';
import { useEventRequests } from '../shared/envio/claimRequests';
import { Announce } from './Announce';
import { SettlementSection } from './settlement/SettlementSection';
import { useOrganizerCopy } from './copy';
import { EventArt } from './EventArt';
import { cancelEvent, publishEvent, type LifecycleResult } from './lifecycle';
import { createdDraftFor } from './useEventDraft';
import { useEventStatusWithFallback } from './useEventStatusWithFallback';
import { KR_REGIONS } from './scene/regions';

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
  const locale = useLocale();
  // The pending count beside the 신청 관리 link. Only an approvalRequired event has any, so an
  // ordinary event's empty answer (or an indexer that has not caught up) simply hides the count.
  const { requests: pendingRequests } = useEventRequests(eventId, 'Pending');
  // The status the 발행/취소 actions gate on, from the indexer when it has the row and from the
  // chain while it lags — so a just-created event offers 발행 before the indexer has caught up.
  const chainStatus = useEventStatusWithFallback(eventId);

  const [event, setEvent] = useState<EnvioEvent | null>(null);
  const [tiers, setTiers] = useState<EnvioTier[]>([]);
  const [attendees, setAttendees] = useState<AttendeeRow[]>([]);
  const [title, setTitle] = useState('');
  // The full metadata, kept for the publish summary sheet — venue, region and the two hide flags
  // that decide what a summary may show before the event goes public (plan §2b).
  const [meta, setMeta] = useState<EventMetadata | null>(null);
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
      .then((loaded) => {
        if (!cancelled) {
          setMeta(loaded);
          setTitle(loaded.title);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [imageCid]);

  async function run(which: Exclude<Pending, ''>): Promise<void> {
    setBusy(true);
    setOutcome(null);
    // The organisation is read off the chain, not the indexer, so a lagging indexer cannot feed
    // a stale org into the write.
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
    if (result.state === 'done') {
      setReload((count) => count + 1);
      // The chain has moved; re-read it so the actions reflect the new status even while the
      // indexer is still behind (otherwise a just-published event still offers 발행).
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

  // The publish summary, best-effort from what the indexer and the gateway gave. It is the
  // organiser's own view, so it shows the full start time; place follows the hide flag — the
  // region alone when the venue is for ticket holders (plan §2b).
  const startsAtMs = Number(event?.startsAt ?? draftFallback?.startsAt ?? 0) * 1000;
  const publishDate = Number.isFinite(startsAtMs) && startsAtMs > 0
    ? new Date(startsAtMs).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' })
    : '';
  const region = KR_REGIONS.find((entry) => entry.code === meta?.region);
  const regionLabel = region ? (locale === 'en' ? region.labelEn : region.labelKo) : (meta?.region ?? '');
  const publishPlace = meta?.venueHidden
    ? fmt(life.summary.placeRegionOnly, { region: regionLabel })
    : (meta?.venue || regionLabel);

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
      ) : pending === 'publish' ? (
        // 발행 요약 시트: 무엇을 공개하는지 먼저 보여주고, 그 뒤에 되돌릴 수 없다는 확인(계획 §2b).
        <Sheet label={life.summary.heading}>
          <h2>{life.summary.heading}</h2>
          <dl className="publish-summary">
            <div>
              <dt>{life.summary.title}</dt>
              <dd>{title || draftFallback?.title || dash.art.untitled}</dd>
            </div>
            <div>
              <dt>{life.summary.date}</dt>
              <dd>{publishDate}</dd>
            </div>
            <div>
              <dt>{life.summary.place}</dt>
              <dd>{publishPlace}</dd>
            </div>
            <div>
              <dt>{life.summary.tiers}</dt>
              <dd>{fmt(life.summary.tiersValue, { count: tiers.length })}</dd>
            </div>
            <div>
              <dt>{life.summary.kyc}</dt>
              <dd>{event?.requireKyc ? life.summary.kycOn : life.summary.kycOff}</dd>
            </div>
          </dl>
          <p>{life.publishConfirm}</p>
          <Button disabled={busy} onClick={() => void run('publish')}>{life.confirm}</Button>
          <Button variant="ghost" disabled={busy} onClick={() => setPending('')}>{life.back}</Button>
        </Sheet>
      ) : (
        <Alert tone="warn">
          {life.cancelConfirm}
          <Button disabled={busy} onClick={() => void run('cancel')}>
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
        title={title || draftFallback?.title || dash.art.untitled}
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
    </Screen>
  );
}
