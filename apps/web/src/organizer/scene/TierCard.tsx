import { Alert, Button, Chip, Field, TicketArt, formatTicketDate } from '../../shared/ui';
import { fmt, useLocale } from '../../shared/i18n';
import type { EventDraftTier } from '../../shared/api/firestore';
import { approvalModesEnabled } from '../../shared/config';
import { useOrganizerCopy } from '../copy';
import { ArtPicker } from '../ArtPicker';
import { MAX_TIER_NAME_CHARS, tierArt } from './draftRules';

/** The currencies a paid kind can be priced in. `free` is the segment's other half, not a chip. */
const PAID_CURRENCIES = ['MON', 'USDT', 'USDC'] as const;

/** A whole number out of a box somebody may have emptied; a blank box is zero, not NaN. */
function whole(value: string): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

export interface TierCardProps {
  index: number;
  tier: EventDraftTier;
  /** The event title, shown on the picture exactly as the ticket will show it. */
  title: string;
  /** The draft's start, in Unix seconds. `0` — nothing picked yet — draws no date line. */
  startsAt: number;
  /**
   * The name to print on the ticket, fallback already applied. It is a prop rather than a
   * `useDisplayName()` of this card's own because a draft may hold eight kinds, and eight
   * cards each reading `users/{uid}` would be eight reads of one document for one screen.
   * The section above reads it once; see {@link TicketSection}.
   */
  holder: string;
  removable: boolean;
  onPatch: (next: Partial<EventDraftTier>) => void;
  onRemove: () => void;
  /**
   * The event-wide 받는 방식 answer and a way to change it. It belongs to the event, not the
   * kind (it lives on `EventMeta`), so it is drawn on the first card only — but every card is
   * handed it so the first can find it without knowing it is the first.
   */
  approvalRequired: boolean;
  onApprovalRequired: (value: boolean) => void;
}

/**
 * One ticket kind. The picture is part of the card rather than a screen of its own because it
 * is the part an organiser actually looks at — and it is the only field here that can still be
 * changed after the event is published, since it lives in `eventArt/{eventId}` and not on the
 * chain (plan section B-4).
 *
 * A 무료 | 유료 segment sits at the top, always visible (plan section A-1). 무료 is a free kind
 * on a first-come basis, with a 받는 방식 control on the first card for how tickets are issued;
 * 유료 opens the price, the currencies and the per-person limit — and blocks this card on the
 * spot, because a paid kind is one `Ticket.claim` would refuse every single time and, after
 * publishing, there would be no way left to repair it.
 */
export function TierCard({
  index, tier, title, startsAt, holder, removable, onPatch, onRemove,
  approvalRequired, onApprovalRequired,
}: TierCardProps) {
  const scene = useOrganizerCopy().scene;
  const copy = scene.tiers;
  const paid = tier.currency !== 'free';
  const art = tierArt(tier);
  // The organiser's own name and their own start time, through the same function the
  // attendee's ticket goes through: the preview is the ticket, not a picture of one. A draft
  // with no start time yet simply has no date line — nothing is invented to fill the space.
  const dateText = formatTicketDate(startsAt, useLocale());
  // The `관리자 승인 후 발급` option is refused by the deployed contract until the 01c redeploy,
  // so it is drawn but disabled until `VITE_APPROVAL_MODES` opens it.
  const approvalModes = approvalModesEnabled();
  // 받는 방식 is one answer per event, so it is drawn on the first card and only while free.
  const showApproval = index === 0 && !paid;

  return (
    <li className="tier-card">
      <div className="tier-card__head">
        <h3>{fmt(copy.kind, { index: index + 1 })}</h3>
        {removable ? (
          <Button variant="ghost" onClick={onRemove}>
            {copy.remove}
          </Button>
        ) : null}
      </div>

      <div className="tier-card__art">
        <TicketArt
          art={art}
          title={title}
          tierName={tier.name}
          holder={holder}
          dateText={dateText}
        />
      </div>
      <p className="muted">{copy.art}</p>
      <ArtPicker
        art={art}
        // Picking a design puts the uploaded picture aside rather than deleting the draft's
        // memory of it — the two fields are kept apart until the event is created.
        onPreset={(preset) => onPatch({ design: preset, imageCid: '' })}
        onUploaded={(imageCid) => onPatch({ imageCid })}
      />

      <Field label={copy.name}>
        <input
          value={tier.name}
          // The draft rule's own cap. Past it the rule refuses the whole document, so autosave
          // would stop for good with nothing on screen saying which box did it.
          maxLength={MAX_TIER_NAME_CHARS}
          placeholder={copy.namePlaceholder}
          onChange={(event) => onPatch({ name: event.target.value })}
        />
      </Field>
      <p className="muted">{copy.nameHelp}</p>
      <Field label={copy.supply}>
        <input
          value={String(tier.supply)}
          inputMode="numeric"
          onChange={(event) => onPatch({ supply: whole(event.target.value) })}
        />
      </Field>

      {/* 무료 | 유료 — always visible, replacing the four currency chips and the old fold. 유료
          defaults the currency to MON; the three paid currencies are the row that follows. */}
      <p className="muted">{copy.price}</p>
      <div className="chip-row" role="group" aria-label={copy.price}>
        <Chip label={copy.free} selected={!paid} onClick={() => onPatch({ currency: 'free' })} />
        <Chip label={copy.paid} selected={paid} onClick={() => onPatch({ currency: 'MON' })} />
      </div>

      {paid ? (
        <>
          <div className="chip-row">
            {PAID_CURRENCIES.map((currency) => (
              <Chip
                key={currency}
                label={currency}
                selected={tier.currency === currency}
                onClick={() => onPatch({ currency })}
              />
            ))}
          </div>
          <Field label={copy.amount}>
            <input
              value={String(tier.amount)}
              inputMode="numeric"
              onChange={(event) => onPatch({ amount: whole(event.target.value) })}
            />
          </Field>
          <Field label={copy.maxPerWallet}>
            <input
              value={String(tier.maxPerWallet)}
              inputMode="numeric"
              onChange={(event) => onPatch({ maxPerWallet: whole(event.target.value) })}
            />
          </Field>
          {/* The (i) tooltip: the buyer counts themselves, so 1 is one ticket per person. The
              sentence is always in the DOM and revealed on hover/focus (plan section A-3). */}
          <span className="field-tip">
            <button type="button" className="field-tip__icon" aria-label={copy.limitTip}>
              i
            </button>
            <span className="field-tip__bubble" role="tooltip">{copy.limitTip}</span>
          </span>
          <Alert tone="warn">{copy.paidBlocked}</Alert>
        </>
      ) : null}

      {showApproval ? (
        <div className="receive-method">
          <p className="muted">{copy.receiveMethod}</p>
          <div className="chip-row" role="group" aria-label={copy.receiveMethod}>
            <Chip
              label={copy.receiveAuto}
              selected={!approvalRequired}
              onClick={() => onApprovalRequired(false)}
            />
            <Chip
              label={copy.receiveApproval}
              selected={approvalRequired}
              // The contract still rejects it; the caption below says when it opens.
              disabled={!approvalModes}
              onClick={() => onApprovalRequired(true)}
            />
          </div>
          {approvalModes ? null : <p className="muted">{copy.approvalSoon}</p>}
        </div>
      ) : null}
    </li>
  );
}
