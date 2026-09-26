import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Alert, Button, Card, Field, Screen, Spinner, StickyBar, Toast, Toggle } from '../../shared/ui';
import { fmt, useCopy, useLocale } from '../../shared/i18n';
import { THEME_CODES, themeLabels } from '../../shared/eventThemes';
import { useDisplayName } from '../../shared/displayName';
import { useOrganizerCopy } from '../copy';
import { useMyOrgs } from '../useMyOrgs';
import { isGoodOrgName, ORG_NAME_MAX } from '../orgName';
import { UnsponsoredNotice } from '../Unsponsored';
import { useEventDraft } from '../useEventDraft';
import { KR_REGIONS } from './regions';
import { fromLocalInput, toLocalInput } from './datetime';
import { PosterCard } from './PosterCard';
import { usePosterUpload } from './usePosterUpload';
import { ResumeSheet } from './ResumeSheet';
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
 * the whole complaint the six-step wizard was replaced over. There are two exceptions, and both
 * are a value that is set and wrong rather than a box that is empty: a paid kind, and an event
 * whose end time has already passed. Both would be refused by the chain every single time, so
 * the button says so instead of spending twenty seconds finding out — and because neither is
 * reached by pressing it, both sentences are on screen from the start rather than after a press.
 */

export function CreateEvent() {
  const copy = useOrganizerCopy().scene;
  const shared = useCopy();
  const themes = themeLabels(shared);
  const locale = useLocale();
  const navigate = useNavigate();
  // `/org/new/<id>` names a draft to carry on with — where SCENE 2's back link comes from.
  const { draftId: wanted } = useParams();
  // `/org/new?org=<id>` is how the organiser home and the explore FAB name the organisation.
  const asked = useSearchParams()[0].get('org') ?? '';
  const {
    draft, draftId, loading, resumed, resumedAt, status, savedAt,
    patch, save, saveNow, startNew, discard,
  } = useEventDraft(asked, wanted);
  const [tag, setTag] = useState('');
  /** The one sentence 임시 저장 leaves behind, and `''` when there is none on screen. */
  const [toast, setToast] = useState('');
  /**
   * The resume question, answered once per visit. It is a separate flag from `resumed` because
   * `이어서 작성하기` changes nothing about the draft — it is the same scene carrying on — so
   * there would be nothing else for the sheet to close on.
   */
  const [decided, setDecided] = useState(false);
  const myOrgs = useMyOrgs();
  const displayName = useDisplayName();
  /**
   * The organiser name, when this person has none yet. It is one line above the button rather
   * than a screen of its own: making an organisation is not a thing anybody sets out to do, it
   * is a field on the way to an event (plan section B-4). It is prefilled with the name they
   * already gave, so the whole of it is usually just pressing 만들기.
   */
  const [orgName, setOrgName] = useState('');
  const orgTyped = useRef(false);
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
  /**
   * Only a genuine resume is worth a question (plan section F-3). `/org/new/<id>` named the
   * draft, so the address has already answered this one; an edit draft is never resumed at this
   * entry point at all, and the hook is what makes sure of that.
   */
  const asking = !decided && !loading && resumed && wanted === undefined && !editing;
  // Only when there is nothing to pick from: one organisation is used without asking, and two
  // or more are chosen in `더 설정하기` — neither is a question worth a box on this screen.
  const needsOrg = !editing && !myOrgs.isLoading && myOrgs.orgs.length === 0 && draft.orgId === '';
  const orgNameWrong = needsOrg && !isGoodOrgName(orgName);
  /**
   * The poster's own life, owned here rather than by the card, because `만들기` has to be able
   * to wait for it. `patch` is the whole of what it reports: the draft carries the CID and
   * never the bytes — a Firestore document stops at 1 MiB and a 600 KB JPEG is 800 KB as
   * base64 — and the bytes themselves stay in memory behind an object URL.
   */
  const poster = usePosterUpload((cid) => patch({ posterCid: cid }));
  // A poster that is halfway to the server is not a missing poster. Dropping the problem here
  // rather than at the button is what keeps the red line from appearing under a picture the
  // organiser is looking at (plan section D-3).
  const problems = eventProblems(draft).filter((key) => !(key === 'poster' && poster.busy));
  const tiersWrong = tierProblems(draft);
  /**
   * The draft written days ago and opened again today. `saleWindow` derives 지금 -> `endsAt`,
   * so a passed end time is a sign-up window that runs backwards and a `createEvent` that
   * reverts `InvalidSchedule()` while it is still being estimated — which is the founder's
   * "행사를 만들지 못했어요" (task-create-failure-2 report §0). Nothing on the screen looks
   * wrong, so the sentence is shown without waiting for a press.
   */
  const past = problems.includes('eventPast');
  const blocked = paidTiers(draft).length > 0;
  const wrong = (key: EventProblem) =>
    (checked && problems.includes(key) ? <p className="problem">{copy.problems[key]}</p> : null);

  useEffect(() => {
    if (orgTyped.current) return;
    // A name a previous attempt wrote down outranks the profile's: it may already be the name
    // of an organisation that exists.
    const prefill = draft.orgPendingName || displayName;
    if (prefill !== '') setOrgName(prefill);
  }, [displayName, draft.orgPendingName]);

  // `만들기` pressed while the poster was still going up. The publish is not started from the
  // click but from here, once the upload is over, and deliberately so: `publish` is closed
  // over `draft`, and the thing being waited for *is* a change to `draft`. Awaiting inside the
  // handler and then calling the `publish` that handler captured would send the draft as it
  // was before the CID landed — which `usePublish` would silently drop on its own
  // `eventProblems` guard.
  const [waiting, setWaiting] = useState(false);

  const { phase, problem, unsponsored, publish } = usePublish({
    draft,
    draftId,
    myOrgs,
    orgName,
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

  useEffect(() => {
    if (!waiting || poster.busy) return;
    setWaiting(false);
    // The upload came back refused. The sentence and the `다시 올리기` chip are under the
    // picture already; starting a publish with no poster on it would only add a second one.
    if (poster.problem !== '') return;
    void publish();
  }, [waiting, poster.busy, poster.problem, publish]);

  // `confirming` deliberately leaves the button pressable: that press is what asks the bundler
  // what became of an operation whose `wait` gave up, and it never sends a second one.
  const working = waiting
    || phase === 'org' || phase === 'pinning' || phase === 'sending' || phase === 'finishing';

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
    if (orgNameWrong) {
      scrollTo('org');
      return;
    }
    // Everything else is filled in and the only thing left is the upload. Wait for it.
    if (poster.busy) {
      setWaiting(true);
      return;
    }
    void publish();
  }

  /**
   * 임시 저장. The write is forced rather than debounced — the press is the whole point, and a
   * button that decides for itself that it had nothing to do is a button nobody presses twice.
   * The sentence only appears for a write that landed; a refused one is already being said on
   * the left of the same bar, and two sentences that disagree would be worse than one.
   */
  async function saveDraft(): Promise<void> {
    if (await saveNow()) setToast(copy.saved);
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
        {asking ? (
          <ResumeSheet
            title={draft.title}
            at={resumedAt}
            onResume={() => setDecided(true)}
            onFresh={() => {
              setDecided(true);
              void startNew();
            }}
          />
        ) : null}

        <Card title={copy.poster} id="scene-poster">
          <PosterCard posterCid={draft.posterCid} upload={poster} />
          {draft.posterCid === '' && poster.localUrl === ''
            ? <p className="muted">{copy.posterEmpty}</p> : null}
          {wrong('poster')}
        </Card>

        {/* No heading: the box's own label is the only word this pane needs. */}
        <Card id="scene-title">
          <Field label={copy.titleLabel}>
            <input
              value={draft.title}
              maxLength={MAX_TITLE_CHARS}
              placeholder={copy.titlePlaceholder}
              onChange={(event) => patch({ title: event.target.value })}
            />
          </Field>
          {wrong('title')}
        </Card>

        <Card title={copy.timeLabel} id="scene-time">
          <Field label={copy.startsAt}>
            <input
              type="datetime-local"
              value={toLocalInput(draft.startsAt)}
              onChange={(event) => patch({ startsAt: fromLocalInput(event.target.value) })}
            />
          </Field>
          {wrong('startsAt')}
          {past ? <p className="problem">{copy.problems.eventPast}</p> : null}
        </Card>

        <Card title={copy.placeLabel} id="scene-venue">
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
        </Card>

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

        {needsOrg ? (
          <Card id="scene-org">
            <Field label={copy.org.label}>
              <input
                value={orgName}
                maxLength={ORG_NAME_MAX}
                placeholder={copy.org.placeholder}
                onChange={(event) => {
                  orgTyped.current = true;
                  setOrgName(event.target.value);
                }}
              />
            </Field>
            <p className="muted">{copy.org.help}</p>
            {checked && orgNameWrong ? <p className="problem">{copy.publishProblems.orgName}</p> : null}
          </Card>
        ) : null}

        {unsponsored ? <UnsponsoredNotice /> : null}
        {problem !== '' ? <Alert tone="error">{copy.publishProblems[problem]}</Alert> : null}
        {/* `confirming` covers two things — an operation still in flight, and one that landed
            without naming its event. The second says so itself, so only one line shows. */}
        {phase === 'confirming' && problem === '' ? (
          <Alert tone="info">{editing ? copy.publish.confirmingEdit : copy.publish.confirming}</Alert>
        ) : null}
        {waiting ? <p className="working"><Spinner />{copy.posterWaiting}</p> : null}
        {phase === 'org' || phase === 'pinning' || phase === 'sending' || phase === 'finishing' ? (
          <p className="working">
            <Spinner />
            {editing && phase === 'sending' ? copy.publish.updating : copy.publish[phase]}
          </p>
        ) : null}
        <p className="muted">{copy.tiers.feeNote}</p>
      </div>

      <StickyBar status={<SaveStatus status={status} savedAt={savedAt} />}>
        <div className="sticky-bar__buttons">
          <Button variant="ghost" onClick={() => void saveDraft()}>{copy.saveDraft}</Button>
          <Button disabled={blocked || past || working} onClick={create}>
            {editing ? copy.tiers.save : copy.tiers.create}
          </Button>
        </div>
      </StickyBar>
      {toast === '' ? null : (
        <Toast text={toast} dismiss={shared.common.close} onDone={() => setToast('')} />
      )}
    </Screen>
  );
}
