import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Button, Chip, Field, Screen, StickyBar, Toggle } from '../../shared/ui';
import { fmt, useLocale } from '../../shared/i18n';
import { useOrganizerCopy, type OrganizerCopy } from '../copy';
import { useEventDraft } from '../useEventDraft';
import { KR_REGIONS } from './regions';
import { fromLocalInput, toLocalInput } from './datetime';
import { PosterCard } from './PosterCard';
import { SaveStatus } from './SaveStatus';
import {
  MAX_BODY_CHARS, MAX_TAGS, MAX_TAG_CHARS, MAX_TITLE_CHARS, MAX_VENUE_CHARS,
  PROBLEM_SECTION, THEME_CODES, charCount, eventProblems, normalizeTags, type EventProblem,
} from './draftRules';

/**
 * SCENE 1 — the event itself, as one scroll rather than five steps. The sections are in the
 * order of the plan's section A-2 with the poster card fixed at the top, and the bar at the
 * foot carries the save state and the one way on.
 *
 * `다음` is never disabled. An organiser who has not filled a field in yet is scrolled to it
 * and shown one line under it; they are not stopped, because a half-written draft that cannot
 * move is a draft that gets abandoned on the step it was stuck on — which is the whole
 * complaint the six-step wizard was replaced over.
 */

/** The theme copy is four flat keys rather than a map, so a missing locale fails the build. */
function themeLabel(copy: OrganizerCopy['scene'], code: number): string {
  if (code === 1) return copy.theme1;
  if (code === 2) return copy.theme2;
  if (code === 3) return copy.theme3;
  return copy.theme0;
}

export function CreateEvent() {
  const copy = useOrganizerCopy().scene;
  const locale = useLocale();
  const navigate = useNavigate();
  // `/org/new/<id>` names a draft to carry on with — where SCENE 2's back link comes from.
  const { draftId: wanted } = useParams();
  // `/org/new?org=<id>` is how the organiser home and the explore FAB name the organisation.
  const asked = useSearchParams()[0].get('org') ?? '';
  const { draft, draftId, resumed, status, savedAt, patch, discard } = useEventDraft(asked, wanted);
  const [tag, setTag] = useState('');
  // Nothing is marked wrong until `다음` has been pressed once: a scene that reddens a field
  // the moment it is opened is a scene that starts by telling the organiser off.
  const [checked, setChecked] = useState(false);

  // A draft opened from an event that already exists (T-EV-W12). The way out then leads back
  // to that event, and `처음부터` is hidden: on an edit it would throw the event's own fields
  // away and leave an empty draft that makes a *second* event.
  const editing = draft.editingEventId !== '';
  const problems = eventProblems(draft);
  const wrong = (key: EventProblem) =>
    (checked && problems.includes(key) ? <p className="problem">{copy.problems[key]}</p> : null);

  function onNext(): void {
    setChecked(true);
    const first = problems[0];
    if (first === undefined) {
      navigate(`/org/new/${draftId}/tickets`);
      return;
    }
    // jsdom has no `scrollIntoView`, and neither does an older browser; the line under the
    // field is the part that has to work, so the scroll is offered rather than relied on.
    document.getElementById(`scene-${PROBLEM_SECTION[first]}`)?.scrollIntoView?.({
      behavior: 'smooth', block: 'center',
    });
  }

  function addTag(): void {
    const next = normalizeTags([...draft.tags, tag]);
    if (next.length !== draft.tags.length) patch({ tags: next });
    setTag('');
  }

  return (
    <Screen title={copy.title}>
      <div className="scene">
        <p>
          <Link to={editing ? `/org/events/${draft.editingEventId}` : '/org'}>{copy.leave}</Link>
        </p>
        {resumed && !editing ? (
          <p className="muted">
            {copy.resumed} ·{' '}
            <Button variant="ghost" onClick={() => void discard()}>
              {copy.startOver}
            </Button>
          </p>
        ) : null}

        <section id="scene-poster">
          <h2>{copy.poster}</h2>
          <PosterCard posterCid={draft.posterCid} onPinned={(cid) => patch({ posterCid: cid })} />
          {draft.posterCid === '' ? <p className="muted">{copy.posterEmpty}</p> : null}
          {wrong('poster')}
        </section>

        <section id="scene-title">
          <Field label={copy.titleLabel}>
            <input
              value={draft.title}
              maxLength={MAX_TITLE_CHARS}
              placeholder={copy.titlePlaceholder}
              onChange={(event) => patch({ title: event.target.value })}
            />
          </Field>
          {wrong('title')}
        </section>

        <section id="scene-tags">
          <h2>{copy.themeLabel}</h2>
          <div className="chip-row">
            {THEME_CODES.map((code) => (
              <Chip
                key={code}
                label={themeLabel(copy, code)}
                selected={draft.category === code}
                onClick={() => patch({ category: code })}
              />
            ))}
          </div>

          <h2>{copy.tagsLabel}</h2>
          <p className="muted">{copy.tagsHelp}</p>
          <div className="chip-row">
            {draft.tags.map((entry) => (
              <button
                key={entry}
                type="button"
                className="chip chip--on"
                aria-label={fmt(copy.tagRemove, { tag: entry })}
                onClick={() => patch({ tags: draft.tags.filter((kept) => kept !== entry) })}
              >
                {entry}
              </button>
            ))}
          </div>
          <Field label={copy.tagAdd}>
            <input
              value={tag}
              maxLength={MAX_TAG_CHARS}
              placeholder={copy.tagPlaceholder}
              disabled={draft.tags.length >= MAX_TAGS}
              onChange={(event) => setTag(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                addTag();
              }}
            />
          </Field>
          <Button variant="ghost" disabled={draft.tags.length >= MAX_TAGS} onClick={addTag}>
            {copy.tagAdd}
          </Button>
          {wrong('tags')}
        </section>

        <section id="scene-body">
          <Field label={copy.bodyLabel}>
            <textarea
              value={draft.description}
              rows={6}
              maxLength={MAX_BODY_CHARS}
              placeholder={copy.bodyPlaceholder}
              onChange={(event) => patch({ description: event.target.value })}
            />
          </Field>
          <p className="muted">
            {fmt(copy.count, { count: charCount(draft.description), max: MAX_BODY_CHARS })}
          </p>
          {wrong('body')}
        </section>

        <section id="scene-venue">
          <h2>{copy.placeLabel}</h2>
          <Field label={copy.regionLabel}>
            <select value={draft.regionCode} onChange={(event) => patch({ regionCode: event.target.value })}>
              {KR_REGIONS.map((region) => (
                <option key={region.code} value={region.code}>
                  {locale === 'en' ? region.labelEn : region.labelKo}
                </option>
              ))}
            </select>
          </Field>
          <Field label={copy.placeLabel}>
            <input
              value={draft.venue}
              maxLength={MAX_VENUE_CHARS}
              placeholder={copy.venuePlaceholder}
              onChange={(event) => patch({ venue: event.target.value })}
            />
          </Field>
          <Toggle
            label={copy.holdersOnly}
            checked={draft.venueHidden}
            onChange={(on) => patch({ venueHidden: on })}
            help={`${copy.venueHiddenHelp} · ${copy.venueHiddenOneWay}`}
          />
          {wrong('region')}
          {wrong('venue')}
          {wrong('venueTooLong')}
        </section>

        <section id="scene-time">
          <h2>{copy.timeLabel}</h2>
          <Field label={copy.startsAt}>
            <input
              type="datetime-local"
              value={toLocalInput(draft.startsAt)}
              onChange={(event) => patch({ startsAt: fromLocalInput(event.target.value) })}
            />
          </Field>
          <Field label={copy.endsAt}>
            <input
              type="datetime-local"
              value={toLocalInput(draft.endsAt)}
              onChange={(event) => patch({ endsAt: fromLocalInput(event.target.value) })}
            />
          </Field>
          <Toggle
            label={copy.holdersOnly}
            checked={draft.timeHidden}
            onChange={(on) => patch({ timeHidden: on })}
            help={copy.timeHiddenHelp}
          />
          <p className="muted">{copy.saleHelp}</p>
          {wrong('startsAt')}
          {wrong('endsAt')}
          {wrong('schedule')}
        </section>
      </div>

      <StickyBar status={<SaveStatus status={status} savedAt={savedAt} />}>
        <Button onClick={onNext}>{copy.next}</Button>
      </StickyBar>
    </Screen>
  );
}
