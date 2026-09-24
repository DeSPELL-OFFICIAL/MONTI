import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Alert, Button, Field, Screen, Spinner, StickyBar, Toggle } from '../../shared/ui';
import { fmt, useCopy, useLocale } from '../../shared/i18n';
import { THEME_CODES, themeLabels } from '../../shared/eventThemes';
import { useOrganizerCopy } from '../copy';
import { UnsponsoredNotice } from '../Unsponsored';
import { useEventDraft } from '../useEventDraft';
import { KR_REGIONS } from './regions';
import { fromLocalInput, toLocalInput } from './datetime';
import { PosterCard } from './PosterCard';
import { SaveStatus } from './SaveStatus';
import { TicketExtras, TicketSection } from './TicketSection';
import { usePublish } from './usePublish';
import {
  MAX_BODY_CHARS, MAX_TAGS, MAX_TAG_CHARS, MAX_TITLE_CHARS, MAX_VENUE_CHARS,
  PROBLEM_SECTION, charCount, endsAtOf, eventProblems, normalizeTags, paidTiers, tierProblems,
  type EventProblem,
} from './draftRules';

/**
 * The fields behind `더 설정하기`. A problem in one of them opens the fold before the scroll —
 * a sentence nobody can see is worse than no sentence at all.
 */
const FOLDED_PROBLEMS: ReadonlySet<EventProblem> = new Set<EventProblem>([
  'tags', 'body', 'endsAt', 'schedule',
]);

/**
 * The creation scene — the event **and** its tickets, as one scroll and one button.
 *
 * It was two screens until the founder's phone test (plan section B-1): `/org/new/:draftId` for
 * the event and `/org/new/:draftId/tickets` for the kinds, with 다음 between them. Pressing
 * 다음 and then 행사 만들기 is two taps for one intention, so the second screen is a section of
 * this one now and `만들기` is the only button. None of the rules moved: `eventProblems`,
 * `tierProblems` and `usePublish` are the same three they were.
 *
 * `만들기` is never disabled for an empty field. An organiser who has not filled one in yet is
 * scrolled to it and shown one line under it; they are not stopped, because a half-written
 * draft that cannot move is a draft that gets abandoned on the field it was stuck on — which is
 * the whole complaint the six-step wizard was replaced over. A paid kind is the one exception:
 * that is a choice to undo, not a field to fill in, and it does disable the button.
 */

export function CreateEvent() {
  const copy = useOrganizerCopy().scene;
  const themes = themeLabels(useCopy());
  const locale = useLocale();
  const navigate = useNavigate();
  // `/org/new/<id>` names a draft to carry on with — where SCENE 2's back link comes from.
  const { draftId: wanted } = useParams();
  // `/org/new?org=<id>` is how the organiser home and the explore FAB name the organisation.
  const asked = useSearchParams()[0].get('org') ?? '';
  const { draft, draftId, resumed, status, savedAt, patch, save, discard } = useEventDraft(asked, wanted);
  const [tag, setTag] = useState('');
  // `더 설정하기`. Closed to begin with — the five fields above it are the whole of an event
  // that works — and opened by hand, or by a problem hiding inside it.
  const [more, setMore] = useState(false);
  // Nothing is marked wrong until `만들기` has been pressed once: a scene that reddens a field
  // the moment it is opened is a scene that starts by telling the organiser off.
  const [checked, setChecked] = useState(false);

  // A draft opened from an event that already exists (T-EV-W12). The way out then leads back
  // to that event, and `처음부터` is hidden: on an edit it would throw the event's own fields
  // away and leave an empty draft that makes a *second* event.
  const editing = draft.editingEventId !== '';
  const problems = eventProblems(draft);
  const tiersWrong = tierProblems(draft);
  const blocked = paidTiers(draft).length > 0;
  const wrong = (key: EventProblem) =>
    (checked && problems.includes(key) ? <p className="problem">{copy.problems[key]}</p> : null);

  const { phase, problem, unsponsored, publish } = usePublish({
    draft,
    draftId,
    patch,
    save,
    discard,
    // The title and the poster travel in the navigation because there is nowhere left to read
    // them from: the indexer has not seen the event and, when everything landed, the draft is
    // gone. `plan`/`done`/`draftId` go too — they are what makes the retry on that screen real.
    // `onCreated` is never called without an id; that branch stays here and says so.
    onCreated: (created) => {
      // An event that already existed has a screen of its own to go back to, and the done
      // screen's words ("행사를 만들었어요") would be the wrong ones for an edit.
      if (editing) {
        navigate(`/org/events/${created.eventId}`);
        return;
      }
      navigate(`/org/new/done/${created.eventId}`, {
        state: {
          posterCid: created.posterCid,
          title: created.title,
          followUpFailed: created.followUpFailed,
          draftId: created.draftId,
          plan: created.plan,
          done: created.done,
        },
      });
    },
  });

  // `confirming` deliberately leaves the button pressable: that press is what asks the bundler
  // what became of an operation whose `wait` gave up, and it never sends a second one.
  const working = phase === 'pinning' || phase === 'sending' || phase === 'finishing';

  function scrollTo(section: string): void {
    // jsdom has no `scrollIntoView`, and neither does an older browser; the line under the
    // field is the part that has to work, so the scroll is offered rather than relied on.
    document.getElementById(`scene-${section}`)?.scrollIntoView?.({
      behavior: 'smooth', block: 'center',
    });
  }

  function create(): void {
    setChecked(true);
    const first = problems[0];
    if (first !== undefined) {
      if (FOLDED_PROBLEMS.has(first)) setMore(true);
      scrollTo(PROBLEM_SECTION[first]);
      return;
    }
    if (tiersWrong.length > 0) {
      scrollTo('tickets');
      return;
    }
    void publish();
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

        <section id="scene-time">
          <h2>{copy.timeLabel}</h2>
          <Field label={copy.startsAt}>
            <input
              type="datetime-local"
              value={toLocalInput(draft.startsAt)}
              onChange={(event) => patch({ startsAt: fromLocalInput(event.target.value) })}
            />
          </Field>
          {wrong('startsAt')}
        </section>

        <section id="scene-venue">
          <h2>{copy.placeLabel}</h2>
          <div className="field-pair">
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
          </div>
          {wrong('region')}
          {wrong('venue')}
          {wrong('venueTooLong')}
        </section>

        <TicketSection
          draft={draft}
          patch={patch}
          problems={checked ? tiersWrong : []}
          blocked={blocked}
        />

        {/* Everything an event can do without. It is closed on arrival: five fields and one
            button is the whole of making an event, and a screen that opens with fourteen of
            them is the screen the founder could not finish (plan section B-2). */}
        <details
          className="more"
          open={more}
          onToggle={(event) => setMore(event.currentTarget.open)}
        >
          <summary>{copy.more}</summary>

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

          <section id="scene-tags">
            {/* One list, shared with the 탐색 filter, so a theme an organiser picks is a theme
                an attendee can find (shared/eventThemes.ts). */}
            <Field label={copy.themeLabel}>
              <select
                value={String(draft.category)}
                onChange={(event) => patch({ category: Number(event.target.value) })}
              >
                {THEME_CODES.map((code) => (
                  <option key={code} value={String(code)}>
                    {themes[code]}
                  </option>
                ))}
              </select>
            </Field>

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

          <section>
            <h2>{copy.timeLabel}</h2>
            {/* Two hours after the start until somebody says otherwise, and the derived value
                is what this box shows — so opening the fold never blanks the field. */}
            <Field label={copy.endsAt}>
              <input
                type="datetime-local"
                value={toLocalInput(endsAtOf(draft))}
                onChange={(event) => patch({ endsAt: fromLocalInput(event.target.value) })}
              />
            </Field>
            <p className="muted">{copy.endsAtHelp}</p>
            <Toggle
              label={copy.holdersOnly}
              checked={draft.timeHidden}
              onChange={(on) => patch({ timeHidden: on })}
              help={copy.timeHiddenHelp}
            />
            <p className="muted">{copy.saleHelp}</p>
            {wrong('endsAt')}
            {wrong('schedule')}
          </section>

          <section>
            <h2>{copy.placeLabel}</h2>
            <Toggle
              label={copy.holdersOnly}
              checked={draft.venueHidden}
              onChange={(on) => patch({ venueHidden: on })}
              help={`${copy.venueHiddenHelp} · ${copy.venueHiddenOneWay}`}
            />
          </section>

          <TicketExtras draft={draft} patch={patch} />
        </details>

        {unsponsored ? <UnsponsoredNotice /> : null}
        {problem !== '' ? <Alert tone="error">{copy.publishProblems[problem]}</Alert> : null}
        {/* `confirming` covers two things — an operation still in flight, and one that landed
            without naming its event. The second says so itself, so only one line shows. */}
        {phase === 'confirming' && problem === '' ? (
          <Alert tone="info">{editing ? copy.publish.confirmingEdit : copy.publish.confirming}</Alert>
        ) : null}
        {phase === 'pinning' || phase === 'sending' || phase === 'finishing' ? (
          <p className="working">
            <Spinner />
            {editing && phase === 'sending' ? copy.publish.updating : copy.publish[phase]}
          </p>
        ) : null}
        <p className="muted">{copy.tiers.feeNote}</p>
      </div>

      <StickyBar status={<SaveStatus status={status} savedAt={savedAt} />}>
        <Button disabled={blocked || working} onClick={create}>
          {editing ? copy.tiers.save : copy.tiers.create}
        </Button>
      </StickyBar>
    </Screen>
  );
}
