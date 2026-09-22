import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Button, Field, KycBadge, Screen, Spinner } from '../../shared/ui';
import { useCopy, useLocale } from '../../shared/i18n';
import { useSession } from '../../shared/session';
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
  const { data, isLoading, isError, refetch } = useEvents();
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
          <Alert tone="error">{copy.common.error}</Alert>
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
    </Screen>
  );
}
