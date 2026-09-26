import { useRef } from 'react';
import { Alert, Button, Chip, Field, TicketArt, formatTicketDate } from '../../shared/ui';
import { fmt, useLocale } from '../../shared/i18n';
import { useReducedMotion } from '../../shared/motion';
import type { EventDraftTier } from '../../shared/api/firestore';
import { approvalModesEnabled } from '../../shared/config';
import { useOrganizerCopy } from '../copy';
import { ArtPicker } from '../ArtPicker';
import { MAX_TIER_NAME_CHARS, tierArt } from './draftRules';

/**
 * The preview's tap regions, as bands of the frame's own height. The picture, the kind and the
 * title are drawn at fixed baselines by {@link buildTicketSvg} in a 1000×1600 frame: the picture
 * fills the top, the kind's baseline sits near 61% and the title block spans ~63–69%, with the
 * stub below the tear at 74%. These bands lay a transparent button over each so a tap edits the
 * thing under the thumb — the preview is the form, not a picture of one. Each button carries a
 * `min-height` of one tap target (theme.css), so on a small thumbnail the thin kind/title bands
 * grow and the later one wins the overlap; the picture region and the price badge stay the two
 * unambiguous targets.
 */
const TAP_REGION = {
  art: { top: '0%', height: '58%' },
  kind: { top: '58%', height: '6%' },
  title: { top: '64%', height: '10%' },
} as const;

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
  /**
   * Editing the event title from the preview. The title is an event field and lives on another
   * card ({@link CreateEvent}'s `scene-title`), so tapping the title on the ticket asks the scene
   * to take the organiser there rather than editing anything the kind owns. Optional: a card
   * rendered without it simply leaves that one region inert.
   */
  onEditTitle?: () => void;
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
  approvalRequired, onApprovalRequired, onEditTitle,
}: TierCardProps) {
  const scene = useOrganizerCopy().scene;
  const copy = scene.tiers;
  const paid = tier.currency !== 'free';
  const art = tierArt(tier);
  // The three controls a tap on the preview drives. The picker is wrapped so its first tile can
  // be found and focused from here without the picker having to expose a ref of its own.
  const nameRef = useRef<HTMLInputElement>(null);
  const priceRef = useRef<HTMLDivElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();

  /**
   * Bring a control into view and give it focus. `scrollIntoView` is guarded — jsdom has none,
   * and neither does an older WebView — and the reveal is instant when the OS asks for reduced
   * motion. Focus is what makes the tap land somewhere the keyboard and a screen reader follow.
   */
  function reveal(container: HTMLElement | null, target: HTMLElement | null | undefined): void {
    container?.scrollIntoView?.({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
    target?.focus();
  }
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

      {/* The preview is the form: transparent buttons over the drawing's own regions turn a tap
          on the picture, the kind or the title into editing that exact thing. The overlay never
          touches the TicketArt's `role="img"`/label, and it covers only the picture — the fields
          below stay in the DOM and reachable on their own. */}
      <div className="tier-card__art">
        <TicketArt
          art={art}
          title={title}
          tierName={tier.name}
          holder={holder}
          dateText={dateText}
          animated
        />
        <div className="tier-preview__taps">
          <button
            type="button"
            className="tier-preview__tap"
            style={TAP_REGION.art}
            aria-label={copy.editArt}
            onClick={() => reveal(pickerRef.current, pickerRef.current?.querySelector('.art-tile'))}
          />
          <button
            type="button"
            className="tier-preview__tap"
            style={TAP_REGION.kind}
            aria-label={copy.editKind}
            onClick={() => reveal(nameRef.current, nameRef.current)}
          />
          <button
            type="button"
            className="tier-preview__tap"
            style={TAP_REGION.title}
            aria-label={copy.editTitle}
            onClick={() => onEditTitle?.()}
          />
        </div>
        {/* The one price the drawing does not bake in, shown as a badge and tapped to set it. */}
        <button
          type="button"
          className="tier-preview__badge"
          aria-label={copy.editPrice}
          onClick={() => reveal(priceRef.current, priceRef.current?.querySelector('button'))}
        >
          {paid ? copy.paid : copy.free}
        </button>
      </div>
      <p className="muted">{copy.art}</p>
      <div ref={pickerRef}>
        <ArtPicker
          art={art}
          title={title}
          tierName={tier.name}
          holder={holder}
          dateText={dateText}
          // Picking a design puts the uploaded picture aside rather than deleting the draft's
          // memory of it — the two fields are kept apart until the event is created.
          onPreset={(preset) => onPatch({ design: preset, imageCid: '' })}
          onUploaded={(imageCid) => onPatch({ imageCid })}
        />
      </div>

      <Field label={copy.name}>
        <input
          ref={nameRef}
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
      <div className="chip-row" role="group" aria-label={copy.price} ref={priceRef}>
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
