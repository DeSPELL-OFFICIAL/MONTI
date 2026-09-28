import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Alert, Button, Fab, Field, KycBadge, Screen } from '../../shared/ui';
import { isThemeCode, themeLabels } from '../../shared/eventThemes';
import { fmt, useCopy, useLocale } from '../../shared/i18n';
import { LIST_STAGGER, m, useReducedMotion } from '../../shared/motion';
import { describeFailure } from '../../shared/errors';
import { useSession } from '../../shared/session';
import { useKycLevel } from '../me/useKycLevel';
import { Filters } from './Filters';
import {
  applyFilters,
  DEFAULT_FILTERS,
  formatEventDate,
  formatEventDay,
  loadFilters,
  saveFilters,
  useEvents,
  type DiscoverFilters,
} from './useEvents';

/**
 * How many of an event's tags a card shows. The rest are counted into one `+N` chip rather
 * than wrapped onto a second line: a card is a title, a time and a badge, and five tags would
 * be the tallest thing on it. The detail screen shows all of them (plan section B-2).
 */
const CARD_TAGS = 2;


export function Discover() {
  const copy = useCopy();
  const locale = useLocale();
  // The organiser's list and this one are the same list (shared/eventThemes.ts), so the chip
  // on a card says the word the organiser picked and the filter above it offers.
  const themes = themeLabels(copy);
  const [filters, setFilters] = useState<DiscoverFilters>(loadFilters);
  // Asked once for the whole page, not once per card, and not at all for a signed-out visitor.
  const signedIn = useSession().status === 'signedIn';
  const { kycLevel } = useKycLevel();
  const navigate = useNavigate();
  // Held until the session is known: a tap mid-refresh would read an unresolved session and send a
  // signed-in organiser to /signup/phone (S5). It clears the moment the session resolves.
  const sessionLoading = useSession().status === 'loading';
  const { data, isLoading, isError, error, refetch } = useEvents();
  const items = applyFilters(data ?? [], filters);
  const reduce = useReducedMotion();
  // Reduced motion drops the stagger so the cards are all there at once (see LIST_STAGGER).
  const list = reduce ? {} : { variants: LIST_STAGGER.container, initial: 'hidden' as const, animate: 'show' as const };
  const item = reduce ? {} : { variants: LIST_STAGGER.item };

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

      {isLoading ? (
        // 스켈레톤 카드로 진입 1초 안에 화면이 살아 보이게 한다(계획 §2a) — 스피너 한 개는
        // '죽은 앱'처럼 읽혔다. 장식이라 스크린리더에서는 감춘다.
        <ul className="event-list event-list--skeleton" aria-hidden="true">
          {[0, 1, 2].map((row) => (
            <li key={row} className="event-card event-card--skeleton">
              <span className="event-card__art event-card__art--skeleton" />
              <div className="event-card__body">
                <span className="skeleton-bar skeleton-bar--title" />
                <span className="skeleton-bar" />
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {isError ? (
        <>
          <Alert tone="error">{describeFailure(error, copy)}</Alert>
          <Button onClick={() => void refetch()}>{copy.common.retry}</Button>
        </>
      ) : null}

      {!isLoading && !isError && items.length === 0 ? (
        (data ?? []).length === 0 ? (
          // 데이터 자체가 0건. 로그인한 사람에게는 첫 행사를 만들라 권하고(만들기 씬으로 직행),
          // 비로그인에게는 곧 올라온다고 안심시킨다 — 버튼 없이(계획 §2a).
          signedIn ? (
            <div className="empty-state">
              <p className="muted">{copy.discover.emptyHostCta}</p>
              <Button onClick={() => navigate('/org/new')}>{copy.discover.create}</Button>
            </div>
          ) : (
            <p className="muted">{copy.discover.emptySoon}</p>
          )
        ) : (
          // 행사는 있는데 필터가 다 걸러냈다. 필터를 지우면 다시 보인다.
          <div className="empty-state">
            <p className="muted">{copy.discover.emptyFiltered}</p>
            <Button variant="ghost" onClick={() => update(DEFAULT_FILTERS)}>
              {copy.discover.clearFilters}
            </Button>
          </div>
        )
      ) : null}

      <m.ul className="event-list" {...list}>
        {items.map(({ event, metadata }) => (
          <m.li key={event.id} className="event-card" {...item}>
            {/* The poster, at the size a thumbnail of an A4 page wants to be. `alt=""` on
                purpose: the title is the line beside it, and a screen reader reading the
                event's name twice per card is worse than not seeing the picture at all. */}
            {metadata?.image ? (
              <img className="event-card__art" src={metadata.image} alt="" loading="lazy" />
            ) : (
              <span className="event-card__art event-card__art--none" aria-hidden="true" />
            )}
            <div className="event-card__body">
              <p className="event-card__title">
                <Link to={`/events/${event.id}`}>{metadata?.title || copy.discover.untitled}</Link>
                <KycBadge required={event.requireKyc} level={kycLevel} signedIn={signedIn} />
              </p>
              {/* The same rule the detail screen keeps: an organiser who told only ticket
                  holders when their event starts must not have it printed to the minute on the
                  card everybody sees. The card already holds the document that says so. */}
              <p className="muted">
                {/* An event the chain gave a theme this app has no word for gets no chip
                    rather than an empty one — the indexer's numbers outlive this list. */}
                {isThemeCode(event.category) ? (
                  <><span className="chip chip--tiny">{themes[event.category]}</span>{' '}</>
                ) : null}
                {metadata?.timeHidden
                  ? formatEventDay(event.startsAt, locale)
                  : formatEventDate(event.startsAt, locale)}
              </p>
              {/* Reading only. Nothing filters on a tag and nothing here is pressable: the
                  indexer has no column for tags (`schema.graphql`), so filtering on them would
                  mean fetching every event's document before the first card could be drawn. */}
              {metadata !== null && metadata.tags.length > 0 ? (
                <ul className="tag-row tag-row--card">
                  {metadata.tags.slice(0, CARD_TAGS).map((tag) => (
                    <li key={tag}>{tag}</li>
                  ))}
                  {metadata.tags.length > CARD_TAGS ? (
                    <li>{fmt(copy.discover.tagsMore, { count: metadata.tags.length - CARD_TAGS })}</li>
                  ) : null}
                </ul>
              ) : null}
            </div>
          </m.li>
        ))}
      </m.ul>

      {/* Shown to everybody, signed out included: 만들기 always means "make an event", so it
          opens the creation scene straight away, and a visitor who is not signed in is sent to
          signing up rather than refused the button — hiding it is how a founder with a fresh
          account finds nothing at all. Held disabled until the session is known (S5). */}
      <Fab
        label={copy.discover.create}
        disabled={sessionLoading}
        onClick={() => navigate(signedIn ? '/org/new' : '/signup/phone')}
      />
    </Screen>
  );
}
