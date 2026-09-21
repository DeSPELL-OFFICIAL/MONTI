import { Button, Field } from '../../shared/ui';
import { useOrganizerCopy } from '../copy';
import type { WizardTier } from './buildEventMeta';
import type { StepProps } from './Step1Basic';

const MAX_TIERS = 8;
const NEW_TIER: WizardTier = { name: '', supply: 100, maxPerWallet: 2, seated: false };

const HINT = { color: 'var(--muted)', fontSize: 13 } as const;

export function Step3Tiers({ draft, patch, onNext, onBack }: StepProps & { onBack: () => void }) {
  const copy = useOrganizerCopy().wizard;

  function edit(index: number, next: Partial<WizardTier>): void {
    patch({ tiers: draft.tiers.map((tier, at) => (at === index ? { ...tier, ...next } : tier)) });
  }

  return (
    <section>
      <h2>{copy.step3}</h2>
      <p style={HINT}>{copy.tiersHelp}</p>
      {draft.tiers.map((tier, index) => (
        // The rows are positional: an index is what identifies one while its name is still blank.
        <fieldset key={index}>
          <Field label={`${copy.tierName} ${index + 1}`}>
            <input value={tier.name} onChange={(event) => edit(index, { name: event.target.value })} />
          </Field>
          <Field label={`${copy.supply} ${index + 1}`}>
            <input
              type="number" min={1} value={tier.supply}
              onChange={(event) => edit(index, { supply: Number(event.target.value) })}
            />
          </Field>
          <Field label={`${copy.maxPerWallet} ${index + 1}`}>
            <input
              type="number" min={1} value={tier.maxPerWallet}
              onChange={(event) => edit(index, { maxPerWallet: Number(event.target.value) })}
            />
          </Field>
          <label>
            <input
              type="checkbox" checked={tier.seated}
              onChange={(event) => edit(index, { seated: event.target.checked })}
            />
            {copy.seated}
          </label>
          {draft.tiers.length > 1 ? (
            <Button
              variant="danger"
              onClick={() => patch({ tiers: draft.tiers.filter((_, at) => at !== index) })}
            >
              {copy.removeTier}
            </Button>
          ) : null}
        </fieldset>
      ))}
      <Button
        variant="ghost"
        disabled={draft.tiers.length >= MAX_TIERS}
        onClick={() => patch({ tiers: [...draft.tiers, { ...NEW_TIER }] })}
      >
        {copy.addTier}
      </Button>
      <Button variant="ghost" onClick={onBack}>{copy.back}</Button>
      <Button onClick={onNext}>{copy.next}</Button>
    </section>
  );
}
