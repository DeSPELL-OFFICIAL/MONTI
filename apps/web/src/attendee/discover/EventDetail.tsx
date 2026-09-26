import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, KycBadge, Screen, Spinner } from '../../shared/ui';
import { fmt, useCopy, useLocale } from '../../shared/i18n';
import type { Copy } from '../../shared/copy/index';
import { gql } from '../../shared/envio/client';
import { describeFailure } from '../../shared/errors';
import { EVENT_QUERY, type EnvioEvent, type EnvioTier } from '../../shared/envio/queries';
import { fetchEventMetadata, type EventMetadata } from '../../shared/envio/ipfs';
import { api } from '../../shared/api/functions';
import { getConfig } from '../../shared/config';
import { useSession } from '../../shared/session';
import { useKycLevel } from '../me/useKycLevel';
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

export function EventDetail() {
  const copy = useCopy();
  const locale = useLocale();
  const { eventId = '' } = useParams();
  // This screen is public, so the badge asks whether there is anybody to have a status first.
  const signedIn = useSession().status === 'signedIn';
  const { kycLevel } = useKycLevel();

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
  const canShare = canOpenShareSheet();
  const record = `${getConfig().explorerUrl}/address/${getConfig().addresses.ticket}`;
  const region = metadata ? regionLabel(metadata.region, copy) : '';
  // The venue the organiser hid is not in the pinned document at all; it comes back from the
  // callable or it does not come back.
  const venue = metadata?.venueHidden ? (priv.data?.venue ?? '') : (metadata?.venue ?? '');
  const timeHidden = metadata?.timeHidden === true && !maySeePrivate;
  // The callable has a cold start, so only the line that is waiting on it says so.
  const venueWaiting = metadata?.venueHidden === true && signedIn && priv.isLoading;

  return (
    <Screen title={metadata?.title || copy.discover.untitled}>
      {metadata?.image ? <img className="event-hero" src={metadata.image} alt="" /> : null}
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
        ) : null}
        {metadata?.venueHidden && venue === '' ? (
          <p className="muted">
            {region === '' ? '' : `${region} · `}
            {venueWaiting ? copy.discover.privateLoading : copy.discover.venueHidden}
          </p>
        ) : null}
      </Card>

      {/* What is left, and at what price. Its own pane because it is the one part of this
          screen that changes while somebody is looking at it. */}
      <Card>
        <ul className="tier-list">
          {tiers.map((tier) => {
            const left = Number(tier.supply) - Number(tier.minted);
            return (
              <li key={tier.id}>
                <span>{tier.name}</span>
                <span className="muted">
                  {left > 0 ? fmt(copy.discover.remaining, { count: left }) : copy.discover.soldOut}
                </span>
              </li>
            );
          })}
        </ul>
      </Card>

      {event.status === CANCELLED ? (
        <Alert tone="warn">{copy.discover.cancelled}</Alert>
      ) : (
        <Link to={`/claim/${event.id}`} className="btn btn--primary btn--link">
          {copy.discover.getTicket}
        </Link>
      )}

      {canShare ? (
        <Button variant="ghost" onClick={() => void shareThisPage()}>
          {copy.discover.share}
        </Button>
      ) : null}

      <p className="muted">
        <a href={record}>{copy.discover.publicRecord}</a>
      </p>
    </Screen>
  );
}
