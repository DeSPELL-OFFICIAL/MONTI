import { Alert, Button, Field, Toggle } from '../../shared/ui';
import type { EventDraft, EventDraftTier } from '../../shared/api/firestore';
import { useOrganizerCopy } from '../copy';
import { emptyEventDraftTier } from '../useEventDraft';
import { TierCard } from './TierCard';
import { MAX_TIERS, type TierProblem } from './draftRules';

export interface TicketSectionProps {
  draft: EventDraft;
  patch: (next: Partial<EventDraft>) => void;
  /** The rules to say out loud — empty until 만들기 has been pressed once. */
  problems: readonly TierProblem[];
  /** A kind that is not free. It is a choice to undo, so it is an alert and not a line. */
  blocked: boolean;
}

/**
 * The ticket kinds, and the three rules that belong to the event rather than to a kind.
 *
 * This used to be a screen of its own at `/org/new/:draftId/tickets`, reached by 다음 and left
 * by 행사 만들기 — two screens and two buttons for what the founder's phone test called one
 * thing ("만들기 하나면 되는 거 아닌가"). It is a section of the one scene now (plan section
 * B-1); nothing about the rules moved, only where they are drawn.
 *
 * `양도 가능`, `양도 마감` and `본인 확인한 사람만` sit below the cards and not inside them
 * because `transferable`, `transferCutoffSeconds` and `requireKyc` are fields of `EventMeta`
 * and `Tier` has no room for any of them — a per-kind switch would be a screen that lies.
 */
export function TicketSection({ draft, patch, problems, blocked }: TicketSectionProps) {
  const copy = useOrganizerCopy().scene;

  function patchTier(index: number, next: Partial<EventDraftTier>): void {
    patch({ tiers: draft.tiers.map((tier, at) => (at === index ? { ...tier, ...next } : tier)) });
  }

  return (
    <section id="scene-tickets">
      <h2>{copy.tiers.title}</h2>

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

      {problems
        .filter((problem) => problem !== 'paidTier')
        .map((problem) => (
          <p className="problem" key={problem}>
            {copy.tierProblems[problem]}
          </p>
        ))}
      {blocked ? <Alert tone="warn">{copy.tierProblems.paidTier}</Alert> : null}
    </section>
  );
}
