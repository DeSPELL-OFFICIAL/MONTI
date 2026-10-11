import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  Button, Card, Field, Screen, Spinner, Steps, StickyBar, Toast, Toggle,
} from '../../shared/ui';
import { fmt, useCopy, useLocale } from '../../shared/i18n';
import { AnimatePresence } from '../../shared/motion';
import { THEME_CODES, themeLabels } from '../../shared/eventThemes';
import { useOrganizerCopy } from '../copy';
import { useEventDraft } from '../useEventDraft';
import { KR_REGIONS } from './regions';
import { fromLocalInput, toLocalInput } from './datetime';
import { PosterCard } from './PosterCard';
import { usePosterUpload } from './usePosterUpload';
import { ResumeSheet } from './ResumeSheet';
import { SaveStatus } from './SaveStatus';
import { TicketExtras, TicketSection } from './TicketSection';
import {
  MAX_BODY_CHARS, MAX_TAGS, MAX_TAG_CHARS, MAX_TITLE_CHARS, MAX_VENUE_CHARS,
  PROBLEM_SECTION, charCount, endsAtOf, eventProblems, normalizeTags, tierProblems,
  type EventProblem,
} from './draftRules';

/**
 * The fields behind `더 설정하기`. A problem in one of them opens the fold before the scroll —
 * a sentence nobody can see is worse than no sentence at all.
 */
const FOLDED_PROBLEMS: ReadonlySet<EventProblem> = new Set<EventProblem>([
  'tags', 'endsAt', 'schedule',
]);

/**
 * The creation scene — the event **and** its tickets, as one scroll and one button.
 *
 * v2 (design §5): this screen never touches the chain. `다음` saves the draft and moves on to
 * `/org/new/:draftId/publish`, where the split rules (for a paid event) and 공개하기 — the one
 * on-chain write — live. A paid kind is allowed here: its price goes on chain at publish.
 *
 * `다음` is never disabled for an empty field. An organiser who has not filled one in yet is
 * scrolled to it and shown one line under it; they are not stopped, because a half-written
 * draft that cannot move is a draft that gets abandoned on the field it was stuck on. The one
 * exception is an event whose end time has already passed — a value that is set and wrong —
 * and that sentence is on screen from the start rather than after a press.
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
    draft, draftId, resumed, resumedAt, status, savedAt,
    patch, saveNow, startNew,
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
  // Tapping the title on a ticket preview takes the organiser here, to the one box that owns it.
  const titleRef = useRef<HTMLInputElement>(null);
  // `더 설정하기`. Closed to begin with — the five fields above it are the whole of an event
  // that works — and opened by hand, or by a problem hiding inside it.
  const [more, setMore] = useState(false);
  // Nothing is marked wrong until `만들기` has been pressed once: a scene that reddens a field
  // the moment it is opened is a scene that starts by telling the organiser off.
  const [checked, setChecked] = useState(false);

  /**
   * Only a genuine resume is worth a question (plan section F-3). `/org/new/<id>` named the
   * draft, so the address has already answered this one.
   */
  // Not gated on `!loading` any more: a resumed draft is known from the device mirror on the first
  // paint, so the question is asked before the scene can be typed into rather than after (계획 §2d).
  const asking = !decided && resumed && wanted === undefined;
  /**
   * The poster's own life, owned here rather than by the card, because `다음` has to be able
   * to wait for it. `patch` is the whole of what it reports: the draft carries the CID and
   * never the bytes — a Firestore document stops at 1 MiB and a 600 KB JPEG is 800 KB as
   * base64 — and the bytes themselves stay in memory behind an object URL.
   */
  const poster = usePosterUpload((cid) => patch({ posterCid: cid }));
  // The poster is optional (plan B-2): a blank one is filled at publish with a default A4 poster,
  // so it is never a problem the organiser has to fix. An in-flight manual upload is still waited
  // on below rather than overwritten.
  const problems = eventProblems(draft);
  const tiersWrong = tierProblems(draft);
  /**
   * The draft written days ago and opened again today. `saleWindow` derives 지금 -> `endsAt`,
   * so a passed end time is a sign-up window that runs backwards and a publish that reverts
   * `InvalidSchedule()` (task-create-failure-2 report §0). Nothing on the screen looks wrong,
   * so the sentence is shown without waiting for a press.
   */
  const past = problems.includes('eventPast');
  const wrong = (key: EventProblem) =>
    (checked && problems.includes(key) ? <p className="problem">{copy.problems[key]}</p> : null);
  // `min` on the start box, so a time already gone is refused by the picker inline rather than
  // by the `eventPast` rule after 만들기. Only the start gets it: the end lives behind the fold
  // and derives from the start, so a floor on it would fight `endsAtOf`.
  const nowLocal = toLocalInput(Math.floor(Date.now() / 1000));

  // `다음` pressed while the poster was still going up: the move waits here for the upload, so the
  // CID is on the draft before the publish screen reads it.
  const [waiting, setWaiting] = useState(false);

  /** Writes the draft out (the device mirror already has it) and moves to the publish screen. */
  const goPublish = useCallback(async (): Promise<void> => {
    await saveNow();
    navigate(`/org/new/${draftId}/publish`);
  }, [draftId, navigate, saveNow]);

  useEffect(() => {
    if (!waiting || poster.busy) return;
    setWaiting(false);
    // The upload came back refused. The sentence and the `다시 올리기` chip are under the
    // picture already.
    if (poster.problem !== '') return;
    void goPublish();
  }, [waiting, poster.busy, poster.problem, goPublish]);

  function scrollTo(section: string): void {
    // jsdom has no `scrollIntoView`, and neither does an older browser; the line under the
    // field is the part that has to work, so the scroll is offered rather than relied on.
    document.getElementById(`scene-${section}`)?.scrollIntoView?.({
      behavior: 'smooth', block: 'center',
    });
  }

  // Tapping the title region of a ticket preview: scroll to the title card and put the cursor in
  // it, so the preview is where the editing starts and the box is where it lands.
  function editTitle(): void {
    scrollTo('title');
    titleRef.current?.focus();
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
    // Everything else is filled in and the only thing left is the upload. Wait for it.
    if (poster.busy) {
      setWaiting(true);
      return;
    }
    void goPublish();
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
      {/* The resume decision sits above the scene and blocks it (계획 §2d): the device mirror shows
          it on the first paint, so a late sheet can never drop over input, and the scene is `inert`
          until the question is answered — a decision made before anything can be typed. */}
      <AnimatePresence>
        {asking ? (
          <ResumeSheet
            key="resume"
            title={draft.title}
            at={resumedAt}
            onResume={() => setDecided(true)}
            onFresh={() => {
              setDecided(true);
              void startNew();
            }}
          />
        ) : null}
      </AnimatePresence>
      <div className="scene" inert={asking}>
        <p>
          <Link to="/org">{copy.leave}</Link>
        </p>
        {/* 만들기 ≠ 공개: 생성 씬은 1단계(초안), 공개 화면이 2단계다(설계 §5). */}
        <Steps labels={[copy.stepCreate, copy.stepPublish]} at={0} />

        <Card title={copy.poster} id="scene-poster">
          <PosterCard posterCid={draft.posterCid} upload={poster} />
          {draft.posterCid === '' && poster.localUrl === ''
            ? <p className="muted">{copy.posterEmpty}</p> : null}
        </Card>

        {/* No heading: the box's own label is the only word this pane needs. */}
        <Card id="scene-title">
          <Field label={copy.titleLabel}>
            <input
              ref={titleRef}
              value={draft.title}
              maxLength={MAX_TITLE_CHARS}
              placeholder={copy.titlePlaceholder}
              onChange={(event) => patch({ title: event.target.value })}
            />
          </Field>
          {wrong('title')}
        </Card>

        {/* 소개는 항상 보이지만 이제 선택이다(계획 B-4): 빈값 허용, placeholder 예시로 안내한다.
            서버·씬 모두 빈 소개를 받는다 — 남은 규칙은 2000자 상한(body)뿐이다. */}
        <Card id="scene-body">
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
        </Card>

        <Card title={copy.timeLabel} id="scene-time">
          <Field label={copy.startsAt}>
            <input
              type="datetime-local"
              min={nowLocal}
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
          {wrong('venueTooLong')}
        </Card>

        <TicketSection
          draft={draft}
          patch={patch}
          problems={checked ? tiersWrong : []}
          onEditTitle={editTitle}
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

        {waiting ? <p className="working"><Spinner />{copy.posterWaiting}</p> : null}
      </div>

      <StickyBar status={<SaveStatus status={status} savedAt={savedAt} />}>
        <div className="sticky-bar__buttons">
          <Button variant="ghost" disabled={asking} onClick={() => void saveDraft()}>{copy.saveDraft}</Button>
          <Button disabled={past || waiting || asking} onClick={create}>
            {copy.tiers.next}
          </Button>
        </div>
      </StickyBar>
      <AnimatePresence>
        {toast === '' ? null : (
          <Toast key="toast" text={toast} dismiss={shared.common.close} onDone={() => setToast('')} />
        )}
      </AnimatePresence>
    </Screen>
  );
}
