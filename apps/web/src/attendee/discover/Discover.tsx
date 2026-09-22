import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Alert, Button, Fab, Field, KycBadge, Screen, Spinner } from '../../shared/ui';
import { useCopy, useLocale } from '../../shared/i18n';
import { describeFailure } from '../../shared/errors';
import { useSession } from '../../shared/session';
import { useOrganizerEntry } from '../../organizer/useOrganizerEntry';
import { useKycLevel } from '../me/useKycLevel';
import { Filters } from './Filters';
import {
  applyFilters,
  formatEventDate,
  loadFilters,
  saveFilters,
  useEvents,
  type DiscoverFilters,
} from './useEvents';

export function Discover() {
  const copy = useCopy();
  const locale = useLocale();
  const [filters, setFilters] = useState<DiscoverFilters>(loadFilters);
  // Asked once for the whole page, not once per card, and not at all for a signed-out visitor.
  const signedIn = useSession().status === 'signedIn';
  const { kycLevel } = useKycLevel();
  const navigate = useNavigate();
  // Shown to everybody, signed out included. The one decision about where it goes is
  // `useOrganizerEntry`'s, and it sends a visitor to signing up rather than refusing them:
  // hiding the button is exactly how a founder with a fresh account finds nothing at all.
  const organizer = useOrganizerEntry();
  const { data, isLoading, isError, error, refetch } = useEvents();
  const items = applyFilters(data ?? [], filters);

  function update(next: DiscoverFilters): void {
    setFilters(next);
    saveFilters(next);
  }

  return (
    <Screen title={copy.discover.title}>
      <Field label={copy.discover.searchPlaceholder}>
        <input
          type="search"
          placeholder={copy.discover.searchPlaceholder}
          value={filters.search}
          onChange={(event) => update({ ...filters, search: event.target.value })}
        />
      </Field>

      <Filters value={filters} onChange={update} />

      {isLoading ? <Spinner /> : null}

      {isError ? (
        <>
          <Alert tone="error">{describeFailure(error, copy)}</Alert>
          <Button onClick={() => void refetch()}>{copy.common.retry}</Button>
        </>
      ) : null}

      {!isLoading && !isError && items.length === 0 ? <p className="muted">{copy.discover.empty}</p> : null}

      <ul className="event-list">
        {items.map(({ event, metadata }) => (
          <li key={event.id}>
            <Link to={`/events/${event.id}`}>{metadata?.title || copy.discover.untitled}</Link>
            <KycBadge required={event.requireKyc} level={kycLevel} signedIn={signedIn} />
            <p className="muted">{formatEventDate(event.startsAt, locale)}</p>
          </li>
        ))}
      </ul>

      <Fab label={copy.discover.create} onClick={() => navigate(organizer.to)} />
    </Screen>
  );
}
