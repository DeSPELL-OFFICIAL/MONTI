import { Alert, Button, Chip, Field, TicketArt, formatTicketDate } from '../../shared/ui';
import { fmt, useLocale } from '../../shared/i18n';
import type { EventDraftCurrency, EventDraftTier } from '../../shared/api/firestore';
import { useOrganizerCopy } from '../copy';
import { ArtPicker } from '../ArtPicker';
import { MAX_TIER_NAME_CHARS, tierArt } from './draftRules';

/** The four the draft can hold. Only the first can be created today; see {@link paidTiers}. */
const CURRENCIES: readonly EventDraftCurrency[] = ['free', 'MON', 'USDT', 'USDC'];

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
}

/**
 * One ticket kind. The picture is part of the card rather than a screen of its own because it
 * is the part an organiser actually looks at — and it is the only field here that can still be
 * changed after the event is published, since it lives in `eventArt/{eventId}` and not on the
 * chain (plan section B-4).
 *
 * Choosing anything but `무료` blocks this card on the spot instead of at the end: a paid kind
 * is one `Ticket.claim` would refuse every single time, and after publishing there would be no
 * way left to repair it.
 */
export function TierCard({
  index, tier, title, startsAt, holder, removable, onPatch, onRemove,
}: TierCardProps) {
  const scene = useOrganizerCopy().scene;
  const copy = scene.tiers;
  const more = scene.more;
  const paid = tier.currency !== 'free';
  const art = tierArt(tier);
  // The organiser's own name and their own start time, through the same function the
  // attendee's ticket goes through: the preview is the ticket, not a picture of one. A draft
  // with no start time yet simply has no date line — nothing is invented to fill the space.
  const dateText = formatTicketDate(startsAt, useLocale());

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

      {/* The per-person limit and the price are answers almost nobody changes — one each, free
          — so they wait behind the fold with everything else optional (plan section B-2). A
          paid kind is the exception and opens it, because it is blocking the button. */}
      <details className="more" open={paid}>
        <summary>{more}</summary>
        <Field label={copy.maxPerWallet}>
          <input
            value={String(tier.maxPerWallet)}
            inputMode="numeric"
            onChange={(event) => onPatch({ maxPerWallet: whole(event.target.value) })}
          />
        </Field>

        <p className="muted">{copy.price}</p>
        <div className="chip-row">
          {CURRENCIES.map((currency) => (
            <Chip
              key={currency}
              label={currency === 'free' ? copy.free : currency}
              selected={tier.currency === currency}
              onClick={() => onPatch({ currency })}
            />
          ))}
        </div>
        {paid ? (
          <>
            <Field label={copy.amount}>
              <input
                value={String(tier.amount)}
                inputMode="numeric"
                onChange={(event) => onPatch({ amount: whole(event.target.value) })}
              />
            </Field>
            <Alert tone="warn">{copy.paidBlocked}</Alert>
          </>
        ) : null}
      </details>
    </li>
  );
}
