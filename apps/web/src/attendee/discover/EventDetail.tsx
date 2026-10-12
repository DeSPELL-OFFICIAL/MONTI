import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, KycBadge, Screen, Spinner, StickyBar, TicketArt } from '../../shared/ui';
import type { TicketArtSource } from '../../shared/ui';
import { AnimatePresence } from '../../shared/motion';
import { ClaimFlow } from '../claim/ClaimFlow';
import { fmt, useCopy, useLocale } from '../../shared/i18n';
import type { Copy } from '../../shared/copy/index';
import { gql } from '../../shared/envio/client';
import { describeFailure } from '../../shared/errors';
import { EVENT_QUERY, type EnvioEvent, type EnvioTier } from '../../shared/envio/queries';
import { fetchEventMetadata, type EventMetadata } from '../../shared/envio/ipfs';
import { api } from '../../shared/api/functions';
import { getSettlement, loadEventArt } from '../../shared/api/firestore';
import { settlementEnabled } from '../../shared/config';
import { formatUsdCents } from '../../shared/money';
import { useSession } from '../../shared/session';
import { useKycLevel } from '../me/useKycLevel';
import { useMyTickets } from '../tickets/useTickets';
import { formatEventDate, formatEventDay } from './useEvents';

const CANCELLED = 'Cancelled';

/**
 * Most desktops have no share sheet, so the button only appears where one exists rather than
 * doing nothing when pressed.
 */
function canOpenShareSheet(): boolean {
  return typeof navigator.share === 'function';
}

async function shareThisPage(): Promise<void> {
  try {
    await navigator.share({ url: window.location.href });
  } catch {
    // Dismissing the sheet rejects with AbortError, and a share that fails any other way has
    // nothing to tell the attendee either — the address is still in the bar.
  }
}

/**
 * The readable name of an ISO region, or `''` for one this app has never had a word for. The
 * region is the **public band** of an event whose venue is hidden, so it is the one part of
 * the place that is shown whatever the organiser chose.
 */
function regionLabel(region: string, copy: Copy): string {
  const regions: Record<string, string> = copy.discover.regions;
  return regions[region] ?? '';
}

/**
 * The part of an event that only ticket holders see. The callable is the whole authorisation:
 * it asks the chain on every call, so it answers for somebody holding a ticket and for the
 * organiser, and refuses everybody else — including somebody who has just handed their ticket
 * on. That makes a successful answer the test for the **time** as well, which needs no storage
 * of its own because the chain already carries the real one.
 */
function usePrivateDetails(eventId: string, wanted: boolean) {
  const signedIn = useSession().status === 'signedIn';
  return useQuery({
    queryKey: ['eventPrivate', eventId],
    queryFn: () => api.getEventPrivate({ eventId }),
    enabled: signedIn && wanted && eventId !== '',
    // `NOT_HOLDER` is an answer, not an outage: retrying it costs a round trip and changes
    // nothing. The screen reads "did this resolve", so a retry would only delay the fallback.
    retry: false,
  });
}

/**
 * The event's face at the top of the screen, sized for a 390px phone (visual R1-7). First choice is
 * the ticket picture an organiser chose for the first tier (`eventArt/{eventId}`), drawn as the same
 * premium ticket a holder carries with the event name laid over it; with none, the pinned poster;
 * with neither, a plain brand-colour block so the screen is never text on white. The ticket art
 * animates and, like every animation, freezes under reduced motion through the global killswitch in
 * theme.css — nothing here has to ask.
 */
function EventHero({ art, poster, title, tierName }: {
  art: TicketArtSource | undefined;
  poster: string;
  title: string;
  tierName: string;
}) {
  if (art) {
    return (
      <div className="event-hero-art">
        <TicketArt art={art} title={title} tierName={tierName} animated />
      </div>
    );
  }
  if (poster !== '') return <img className="event-hero" src={poster} alt="" />;
  return <div className="event-hero event-hero--placeholder" aria-hidden="true" />;
}

export function EventDetail() {
  const copy = useCopy();
  const locale = useLocale();
  const { eventId = '' } = useParams();
  // This screen is public, so the badge asks whether there is anybody to have a status first.
  const signedIn = useSession().status === 'signedIn';
  const { kycLevel } = useKycLevel();
  // 상세에 받기 흡수(plan B1): 티켓 받기를 누르면 라우트 홉 없이 이 화면 위 인라인 시트가 열린다.
  const [claiming, setClaiming] = useState(false);
  // The ticket type the sheet opens on: the first unless a type row was tapped.
  const [claimTier, setClaimTier] = useState(0);
  // 내가 이미 이 행사 티켓을 들고 있는지 — 이른 리턴 앞에서 읽어야 바가 그 티켓으로 돌려보낼 수 있다
  // (visual R1-5). enabled 가드가 걸려 있어 로그아웃 상태에서는 요청이 나가지 않는다.
  const { data: myTickets } = useMyTickets();

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['event', eventId],
    queryFn: async () => {
      // `id` is the text primary key, `eventId` the numeric column the tiers hang off.
      const result = await gql<{ Event: EnvioEvent[]; Tier: EnvioTier[] }>(EVENT_QUERY, {
        id: eventId,
        eventId,
      });
      const event = result.Event[0];
      if (!event) throw new Error('EVENT_NOT_FOUND');
      return {
        event,
        tiers: result.Tier.filter((tier) => String(tier.eventId) === String(event.id)),
        metadata: await fetchEventMetadata(event.imageCid).catch(() => null),
      };
    },
  });

  // The ticket picture an organiser chose for this event, for the hero (visual R1-7). Keyed by the
  // event so it shares the answer with the ticket screens' `useEventArt` — opening a ticket from
  // here reads nothing again. A missing document or a failed read is just "no art", and the hero
  // falls back to the poster, so the failure is swallowed here the way that screen swallows it.
  const { data: eventArt } = useQuery({
    queryKey: ['eventArt', eventId],
    queryFn: () => loadEventArt(eventId).catch(() => [] as TicketArtSource[]),
    enabled: eventId !== '',
  });

  // The per-kind price, from the same settlement mirror the claim sheet reads (Batch F). A free
  // event — or a build without settlement — has none, and the list shows no price at all.
  const { data: settlement } = useQuery({
    queryKey: ['settlement', eventId],
    queryFn: () => getSettlement(eventId),
    enabled: eventId !== '' && settlementEnabled(),
  });
  const priceOf = (idx: number): number | undefined => {
    const cents = settlement?.priceUsdCentsByTier?.[String(idx)];
    return cents !== undefined && cents > 0 ? cents : undefined;
  };

  const metadata: EventMetadata | null = data?.metadata ?? null;
  const hidden = metadata !== null && (metadata.venueHidden || metadata.timeHidden);
  const priv = usePrivateDetails(eventId, hidden);
  // Only a resolved call means this person may see the private half of the event.
  const maySeePrivate = priv.isSuccess;

  if (isError) {
    return (
      <Screen title={copy.discover.title}>
        <Alert tone="error">{describeFailure(error, copy)}</Alert>
        <Button onClick={() => void refetch()}>{copy.common.retry}</Button>
      </Screen>
    );
  }
  if (isLoading || !data) {
    return (
      <Screen title={copy.discover.title}>
        <Spinner />
      </Screen>
    );
  }

  const { event, tiers } = data;
  // The first tier's picture is the event's face; most events have none and fall through below.
  const heroArt = eventArt?.[0];
  const canShare = canOpenShareSheet();
  // 로그인했고 이 행사 티켓이 목록에 있으면 보유자다 — eventId 는 Event.id 와 같은 텍스트 키다.
  const held = signedIn ? (myTickets ?? []).find((ticket) => ticket.eventId === event.id) : undefined;
  const region = metadata ? regionLabel(metadata.region, copy) : '';
  // The venue the organiser hid is not in the pinned document at all; it comes back from the
  // callable or it does not come back.
  const venue = metadata?.venueHidden ? (priv.data?.venue ?? '') : (metadata?.venue ?? '');
  const timeHidden = metadata?.timeHidden === true && !maySeePrivate;
  // The callable has a cold start, so only the line that is waiting on it says so.
  const venueWaiting = metadata?.venueHidden === true && signedIn && priv.isLoading;
  // A paid event says so on the button, with the price the claim sheet opens on (its first kind) —
  // the same 결제하고 받기 $X the sheet shows. Approval events keep the free request path.
  const firstPrice = event.approvalRequired ? undefined : priceOf(tiers[0]?.idx ?? 0);
  const getLabel = event.approvalRequired
    ? copy.discover.requestTicket
    : firstPrice !== undefined
      ? `${copy.purchase.cta} ${formatUsdCents(firstPrice)}`
      : copy.discover.getTicket;

  return (
    <Screen title={metadata?.title || copy.discover.untitled}>
      <EventHero
        art={heroArt}
        poster={metadata?.image ?? ''}
        title={metadata?.title || copy.discover.untitled}
        tierName={tiers[0]?.name ?? ''}
      />
      <Card>
        <KycBadge required={event.requireKyc} level={kycLevel} signedIn={signedIn} />
        {metadata && metadata.tags.length > 0 ? (
          <ul className="tag-row">
            {metadata.tags.map((tag) => (
              <li key={tag}>{tag}</li>
            ))}
          </ul>
        ) : null}
        {metadata?.description ? <p>{metadata.description}</p> : null}

        <p className="muted">
          {timeHidden
            ? `${formatEventDay(event.startsAt, locale)} · ${copy.discover.timeHidden}`
            : formatEventDate(event.startsAt, locale)}
          {metadata?.timeHidden && maySeePrivate ? (
            <span className="badge">{copy.discover.privateOnly}</span>
          ) : null}
        </p>

        {venue !== '' ? (
          <p>
            <a href={`https://maps.google.com/?q=${encodeURIComponent(venue)}`}>
              {venue} · {copy.discover.map}
            </a>
            {metadata?.venueHidden ? <span className="badge">{copy.discover.privateOnly}</span> : null}
          </p>
        ) : metadata?.venueHidden ? (
          <p className="muted">
            {region === '' ? '' : `${region} · `}
            {venueWaiting ? copy.discover.privateLoading : copy.discover.venueHidden}
          </p>
        ) : (
          // 장소를 비운 공개 행사: 이제 장소는 선택이라 기본 라벨 "장소 미정"으로 읽힌다.
          <p className="muted">
            {region === '' ? '' : `${region} · `}
            {copy.discover.venueTbd}
          </p>
        )}
      </Card>

      {/* What is left, and at what price. Its own pane because it is the one part of this
          screen that changes while somebody is looking at it. */}
      <Card>
        <ul className="tier-list">
          {tiers.map((tier) => {
            const left = Number(tier.supply) - Number(tier.minted);
            const cents = priceOf(tier.idx);
            const row = (
              <>
                <span>{cents === undefined ? tier.name : `${tier.name} · ${formatUsdCents(cents)}`}</span>
                <span className="muted">
                  {left > 0 ? fmt(copy.discover.remaining, { count: left }) : copy.discover.soldOut}
                </span>
              </>
            );
            // A type with tickets left is a way in: it opens the same claim the bar does, with this
            // type already chosen. Someone already holding a ticket here is sent to it by the bar,
            // so their rows stay plain, as do sold-out types and a cancelled event.
            const tappable = left > 0 && !held && event.status !== CANCELLED;
            return (
              <li key={tier.id}>
                {!tappable ? (
                  row
                ) : signedIn ? (
                  <button
                    type="button"
                    className="tier-list__pick"
                    onClick={() => {
                      setClaimTier(tier.idx);
                      setClaiming(true);
                    }}
                  >
                    {row}
                  </button>
                ) : (
                  <Link to={`/claim/${event.id}?tier=${tier.idx}`} className="tier-list__pick">
                    {row}
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      </Card>

      {event.status === CANCELLED ? <Alert tone="warn">{copy.discover.cancelled}</Alert> : null}

      {/* 같은 화면 위에서 도는 T-SIMP-1 상태머신(진행 → 완료, 내구 해시 재개, 자동 재전송). */}
      <AnimatePresence>
        {claiming ? (
          <ClaimFlow
            key="claim"
            eventId={event.id}
            initialTier={claimTier}
            present={{ kind: 'sheet', onClose: () => setClaiming(false) }}
          />
        ) : null}
      </AnimatePresence>

      {/* 공유는 부차 행동이라 본문에 남는다 — 주행동만 하단 바로 내려간다(visual R1-5). */}
      {canShare ? (
        <Button variant="ghost" onClick={() => void shareThisPage()}>
          {copy.discover.share}
        </Button>
      ) : null}

      {/* 주행동은 하단 바로 내려가 화면 아래 절반이 비지 않게 한다(visual R1-5): 이미 가진 사람은
          내 티켓으로, 그 밖에는 받기/신청으로. 취소된 행사는 위의 안내만 있고 바는 없다. */}
      {event.status === CANCELLED ? null : (
        <StickyBar>
          {held ? (
            <Link to={`/tickets/${held.tokenId}`} className="btn btn--primary btn--link">
              {copy.discover.viewMyTicket}
            </Link>
          ) : signedIn ? (
            // 로그인한 사람은 이 자리에서 시트로 받는다 — 한 탭, 라우트 홉 없음(plan B1·여정 A).
            <Button
              onClick={() => {
                setClaimTier(tiers[0]?.idx ?? 0);
                setClaiming(true);
              }}
            >
              {getLabel}
            </Button>
          ) : (
            // 로그인 전에는 /claim 라우트로 보내 로그인을 먼저 마치게 하고, 그 뒤 라우트가 이어받는다.
            <Link to={`/claim/${event.id}`} className="btn btn--primary btn--link">
              {getLabel}
            </Link>
          )}
        </StickyBar>
      )}
    </Screen>
  );
}
