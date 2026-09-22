import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, KycBadge, Screen, Spinner } from '../../shared/ui';
import { fmt, useCopy, useLocale } from '../../shared/i18n';
import { gql } from '../../shared/envio/client';
import { describeFailure } from '../../shared/errors';
import { EVENT_QUERY, type EnvioEvent, type EnvioTier } from '../../shared/envio/queries';
import { fetchEventMetadata } from '../../shared/envio/ipfs';
import { getConfig } from '../../shared/config';
import { useSession } from '../../shared/session';
import { useKycLevel } from '../me/useKycLevel';
import { formatEventDate } from './useEvents';

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

  const { event, tiers, metadata } = data;
  const canShare = canOpenShareSheet();
  const record = `${getConfig().explorerUrl}/address/${getConfig().addresses.ticket}`;

  return (
    <Screen title={metadata?.title || copy.discover.untitled}>
      {metadata?.image ? <img className="event-hero" src={metadata.image} alt="" /> : null}
      <KycBadge required={event.requireKyc} level={kycLevel} signedIn={signedIn} />
      {metadata?.description ? <p>{metadata.description}</p> : null}
      <p className="muted">{formatEventDate(event.startsAt, locale)}</p>
      {metadata?.venue ? (
        <p>
          <a href={`https://maps.google.com/?q=${encodeURIComponent(metadata.venue)}`}>
            {metadata.venue} · {copy.discover.map}
          </a>
        </p>
      ) : null}

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
