import { Alert, Button, Chip, Field, TicketArt } from '../../shared/ui';
import { fmt } from '../../shared/i18n';
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
export function TierCard({ index, tier, title, removable, onPatch, onRemove }: TierCardProps) {
  const copy = useOrganizerCopy().scene.tiers;
  const paid = tier.currency !== 'free';
  const art = tierArt(tier);

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
        <TicketArt art={art} title={title} tierName={tier.name} />
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
      <div className="tier-card__pair">
        <Field label={copy.supply}>
          <input
            value={String(tier.supply)}
            inputMode="numeric"
            onChange={(event) => onPatch({ supply: whole(event.target.value) })}
          />
        </Field>
        <Field label={copy.maxPerWallet}>
          <input
            value={String(tier.maxPerWallet)}
            inputMode="numeric"
            onChange={(event) => onPatch({ maxPerWallet: whole(event.target.value) })}
          />
        </Field>
      </div>

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
    </li>
  );
}
