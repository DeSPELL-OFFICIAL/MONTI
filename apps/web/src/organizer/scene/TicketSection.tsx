import { Alert, Button, Card, Chip, Field, Toggle } from '../../shared/ui';
import type { EventDraft, EventDraftTier } from '../../shared/api/firestore';
import { approvalModesEnabled } from '../../shared/config';
import { useDisplayName } from '../../shared/displayName';
import { useCopy } from '../../shared/i18n';
import { useOrganizerCopy } from '../copy';
import { emptyEventDraftTier } from '../useEventDraft';
import { TierCard } from './TierCard';
import { MAX_TIERS, PAID_CURRENCY, type TierProblem } from './draftRules';

export interface TicketSectionProps {
  draft: EventDraft;
  patch: (next: Partial<EventDraft>) => void;
  /** The rules to say out loud — empty until 만들기 has been pressed once. */
  problems: readonly TierProblem[];
  /** A kind that is not free. It is a choice to undo, so it is an alert and not a line. */
  blocked: boolean;
  /** Tapping the title on a preview asks the scene to edit the event title; see {@link TierCard}. */
  onEditTitle?: () => void;
}

/**
 * A hand-over icon (two arrows passing) and an identity-check icon (a person with a tick), the
 * two glyphs the compact rules row carries. They are `currentColor` line art and `aria-hidden`
 * (Toggle wraps them again), so they add nothing to the checkboxes' accessible names.
 */
function TransferIcon() {
  return (
    <svg
      viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"
      strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"
    >
      <path d="M4 8h13" />
      <path d="M14 5l3 3-3 3" />
      <path d="M20 16H7" />
      <path d="M10 13l-3 3 3 3" />
    </svg>
  );
}

function KycIcon() {
  return (
    <svg
      viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"
      strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"
    >
      <circle cx="11" cy="8" r="4" />
      <path d="M4 20c0-3.9 3.6-6 7-6 .8 0 1.6.1 2.3.3" />
      <path d="M15 18l2 2 4-4" />
    </svg>
  );
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
export function TicketSection({ draft, patch, problems, blocked, onEditTitle }: TicketSectionProps) {
  const copy = useOrganizerCopy().scene;
  // Read once here rather than in each card: a draft may hold eight kinds, and the name is one
  // document. The fallback is the attendee's own word, so the organiser's preview and the
  // ticket somebody is handed cannot disagree about what an unnamed person is called.
  const tickets = useCopy().tickets;
  const displayName = useDisplayName();
  const holder = displayName === '' ? tickets.artGuest : displayName;
  // 관리자 승인 후 발급 is still refused by the deployed contract, so the approval preset is
  // held behind the same flag as the receiving-method chip inside the card.
  const approvalModes = approvalModesEnabled();

  function patchTier(index: number, next: Partial<EventDraftTier>): void {
    patch({ tiers: draft.tiers.map((tier, at) => (at === index ? { ...tier, ...next } : tier)) });
  }

  // The current draft, read back as the chosen preset: a free first kind is 선착순 or 승인 by the
  // event flag, anything else is 유료. It is the same one-tap choice the receiving-method chips
  // make, gathered into one row at the top so the whole of an ordinary event is one tap.
  const firstPaid = draft.tiers[0] !== undefined && draft.tiers[0].currency !== 'free';
  const quick: 'free' | 'approval' | 'paid' = firstPaid
    ? 'paid'
    : draft.approvalRequired ? 'approval' : 'free';

  return (
    <Card title={copy.tiers.title} id="scene-tickets">
      {/* One tap sets the first kind and the receiving method together — free/선착순, free/승인
          or paid — and the cards below stay the place to fine-tune it. */}
      <p className="muted">{copy.tiers.quickStart}</p>
      <div className="chip-row" role="group" aria-label={copy.tiers.quickStart}>
        <Chip
          label={copy.tiers.quickFree}
          selected={quick === 'free'}
          onClick={() => {
            patchTier(0, { currency: 'free', maxPerWallet: 1 });
            patch({ approvalRequired: false });
          }}
        />
        <Chip
          label={copy.tiers.quickApproval}
          selected={quick === 'approval'}
          // The same gate as the receiving-method 관리자 승인 chip: drawn, but off until the flag.
          disabled={!approvalModes}
          onClick={() => {
            patchTier(0, { currency: 'free', maxPerWallet: 1 });
            patch({ approvalRequired: true });
          }}
        />
        <Chip
          label={copy.tiers.quickPaid}
          selected={quick === 'paid'}
          // The amount is left at its default; the honest paid block still lands in the card.
          onClick={() => patchTier(0, { currency: PAID_CURRENCY, maxPerWallet: 1 })}
        />
      </div>

      <ul className="tier-list-cards">
        {draft.tiers.map((tier, index) => (
          <TierCard
            // The index is the identity: `Tier.idx` is what `eventArt` is stored against,
            // and a kind has no id of its own until the chain gives it one.
            key={index}
            index={index}
            tier={tier}
            title={draft.title}
            startsAt={draft.startsAt}
            holder={holder}
            removable={draft.tiers.length > 1}
            onPatch={(next) => patchTier(index, next)}
            onRemove={() => patch({ tiers: draft.tiers.filter((_, at) => at !== index) })}
            // Event-wide, so the card is handed the draft's answer and writes straight back to
            // the draft rather than to its own kind. Only the first card draws the control.
            approvalRequired={draft.approvalRequired}
            onApprovalRequired={(value) => patch({ approvalRequired: value })}
            // Every card is handed it; the title is one event field, so a tap on any preview's
            // title takes the organiser to the same box.
            onEditTitle={onEditTitle}
          />
        ))}
      </ul>

      {problems
        .filter((problem) => problem !== 'paidTier')
        .map((problem) => (
          <p className="problem" key={problem}>
            {copy.tierProblems[problem]}
          </p>
        ))}
      {blocked ? <Alert tone="warn">{copy.tierProblems.paidTier}</Alert> : null}
    </Card>
  );
}

/**
 * The ticket settings behind `더 설정하기`: a second kind, and the three rules that belong to
 * the event. They are folded because an event with one free kind needs none of them — and the
 * three rules are event-wide (`transferable`, `transferCutoffSeconds` and `requireKyc` live on
 * `EventMeta`, and `Tier` has no room for any of them), so a per-kind switch would be a lie.
 */
export function TicketExtras({ draft, patch }: Pick<TicketSectionProps, 'draft' | 'patch'>) {
  const copy = useOrganizerCopy().scene;

  return (
    <section>
      <h2>{copy.tiers.title}</h2>
      <Button
        variant="ghost"
        disabled={draft.tiers.length >= MAX_TIERS}
        onClick={() => patch({ tiers: [...draft.tiers, { ...emptyEventDraftTier }] })}
      >
        {copy.tiers.add}
      </Button>

      <h2>{copy.tiers.rules}</h2>
      <p className="muted">{copy.tiers.rulesHelp}</p>
      {/* One compact row: the two switches, each with a glyph, side by side. They stay real
          checkboxes — the icon is `aria-hidden` decoration, so the accessible name is still the
          label and `getByRole('checkbox', { name })` finds each one. The long 본인 확인 note moves
          into a (i) tooltip so the row stays a row rather than a wall of sentences. */}
      <div className="tier-extras-row">
        <Toggle
          icon={<TransferIcon />}
          label={copy.tiers.transferable}
          checked={draft.transferable}
          onChange={(on) => patch({ transferable: on })}
        />
        <div className="tier-extras-row__kyc">
          <Toggle
            icon={<KycIcon />}
            label={copy.tiers.requireKyc}
            checked={draft.requireKyc}
            onChange={(on) => patch({ requireKyc: on })}
          />
          <span className="field-tip">
            <button type="button" className="field-tip__icon" aria-label={copy.tiers.requireKycHelp}>
              i
            </button>
            <span className="field-tip__bubble" role="tooltip">{copy.tiers.requireKycHelp}</span>
          </span>
        </div>
      </div>
      {/* The deadline is only a question while hand-over is allowed, so it reveals under the row. */}
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
    </section>
  );
}
