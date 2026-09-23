import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Alert, Button, Field, Screen, Spinner, StickyBar, Toggle } from '../../shared/ui';
import type { EventDraftTier } from '../../shared/api/firestore';
import { useOrganizerCopy } from '../copy';
import { UnsponsoredNotice } from '../Unsponsored';
import { emptyEventDraftTier, useEventDraft } from '../useEventDraft';
import { TierCard } from './TierCard';
import { SaveStatus } from './SaveStatus';
import { usePublish } from './usePublish';
import { MAX_TIERS, eventProblems, paidTiers, tierProblems } from './draftRules';

/**
 * SCENE 2 — the ticket kinds, and the three rules that belong to the event rather than to a
 * kind. `행사 만들기` is the end of the flow: one `createEvent`, and the event exists as a
 * draft on chain that the organiser publishes from its own screen when they are ready.
 *
 * `양도 가능`, `양도 마감` and `본인 확인한 사람만` sit below the cards and not inside them
 * because `transferable`, `transferCutoffSeconds` and `requireKyc` are fields of `EventMeta`
 * and `Tier` has no room for any of them — a per-kind switch would be a screen that lies.
 */
export function TicketSettings() {
  const copy = useOrganizerCopy().scene;
  const navigate = useNavigate();
  const { draftId: wanted = '' } = useParams();
  const { draft, draftId, status, savedAt, patch, save, discard } = useEventDraft('', wanted);
  const [checked, setChecked] = useState(false);
  // A draft opened from an event that already exists (T-EV-W12). The scene is the same one;
  // what changes is the word on the button and where a save that landed goes next.
  const editing = draft.editingEventId !== '';
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

  const problems = tierProblems(draft);
  const blocked = paidTiers(draft);
  const incomplete = eventProblems(draft).length > 0;
  // Every reason `행사 만들기` cannot run, in the order the screen reads. A paid kind is the
  // only one that also disables the button: it is a choice to undo, not a field to fill in.
  const stopped = blocked.length > 0;
  // `confirming` deliberately leaves the button pressable: that press is what asks the bundler
  // what became of an operation whose `wait` gave up, and it never sends a second one.
  const working = phase === 'pinning' || phase === 'sending' || phase === 'finishing';

  function patchTier(index: number, next: Partial<EventDraftTier>): void {
    patch({ tiers: draft.tiers.map((tier, at) => (at === index ? { ...tier, ...next } : tier)) });
  }

  function create(): void {
    setChecked(true);
    if (incomplete) {
      // Nothing is sent: the fields that are missing are on the other scene, so that is where
      // the organiser is taken, rather than being told about them from here.
      navigate(`/org/new/${draftId}`);
      return;
    }
    if (problems.length > 0) return;
    void publish();
  }

  return (
    <Screen title={copy.tiers.title}>
      <div className="scene">
        <p>
          <Link to={`/org/new/${draftId}`}>{copy.back}</Link>
        </p>

        <ul className="tier-list-cards">
          {draft.tiers.map((tier, index) => (
            <TierCard
              // The index is the identity: `Tier.idx` is what `eventArt` is stored against,
              // and a kind has no id of its own until the chain gives it one.
              key={index}
              index={index}
              tier={tier}
              title={draft.title}
              removable={draft.tiers.length > 1}
              onPatch={(next) => patchTier(index, next)}
              onRemove={() => patch({ tiers: draft.tiers.filter((_, at) => at !== index) })}
            />
          ))}
        </ul>

        <Button
          variant="ghost"
          disabled={draft.tiers.length >= MAX_TIERS}
          onClick={() => patch({ tiers: [...draft.tiers, { ...emptyEventDraftTier }] })}
        >
          {copy.tiers.add}
        </Button>

        <section>
          <h2>{copy.tiers.rules}</h2>
          <p className="muted">{copy.tiers.rulesHelp}</p>
          <Toggle
            label={copy.tiers.transferable}
            checked={draft.transferable}
            onChange={(on) => patch({ transferable: on })}
          />
          {draft.transferable ? (
            <Field label={copy.tiers.cutoff}>
              <input
                value={String(draft.transferCutoffHours)}
                inputMode="numeric"
                onChange={(event) => {
                  const hours = Number.parseInt(event.target.value, 10);
                  patch({ transferCutoffHours: Number.isFinite(hours) ? hours : 0 });
                }}
              />
            </Field>
          ) : null}
          <Toggle
            label={copy.tiers.requireKyc}
            checked={draft.requireKyc}
            onChange={(on) => patch({ requireKyc: on })}
            help={copy.tiers.requireKycHelp}
          />
        </section>

        {checked && incomplete ? <p className="problem">{copy.tierProblems.eventIncomplete}</p> : null}
        {checked
          ? problems
            .filter((problem) => problem !== 'paidTier')
            .map((problem) => (
              <p className="problem" key={problem}>
                {copy.tierProblems[problem]}
              </p>
            ))
          : null}
        {stopped ? <Alert tone="warn">{copy.tierProblems.paidTier}</Alert> : null}
        {unsponsored ? <UnsponsoredNotice /> : null}
        {problem !== '' ? <Alert tone="error">{copy.publishProblems[problem]}</Alert> : null}
        {/* `confirming` covers two things — an operation still in flight, and one that landed
            without naming its event. The second says so itself, so only one line shows. */}
        {phase === 'confirming' && problem === '' ? (
          <Alert tone="info">{copy.publish.confirming}</Alert>
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
        <Button disabled={stopped || working} onClick={create}>
          {editing ? copy.tiers.save : copy.tiers.create}
        </Button>
      </StickyBar>
    </Screen>
  );
}
