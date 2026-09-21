import { Button, Field } from '../../shared/ui';
import { useOrganizerCopy } from '../copy';
import { MAX_VENUE_CHARS } from './buildEventMeta';
import { fromLocalInput, toLocalInput } from './datetime';
import type { StepProps } from './Step1Basic';

export function Step2When({ draft, patch, onNext, onBack }: StepProps & { onBack: () => void }) {
  const copy = useOrganizerCopy().wizard;
  return (
    <section>
      <h2>{copy.step2}</h2>
      <Field label={copy.venue}>
        {/* The cap belongs in the field: reaching it here costs a keystroke, reaching it at
            the server costs an upload the organiser has already waited for. */}
        <input
          value={draft.venue}
          maxLength={MAX_VENUE_CHARS}
          onChange={(event) => patch({ venue: event.target.value })}
        />
      </Field>
      <Field label={copy.startsAt}>
        <input
          type="datetime-local"
          value={toLocalInput(draft.startsAt)}
          onChange={(event) => patch({ startsAt: fromLocalInput(event.target.value) })}
        />
      </Field>
      <Field label={copy.endsAt}>
        <input
          type="datetime-local"
          value={toLocalInput(draft.endsAt)}
          onChange={(event) => patch({ endsAt: fromLocalInput(event.target.value) })}
        />
      </Field>
      <Button variant="ghost" onClick={onBack}>{copy.back}</Button>
      <Button onClick={onNext}>{copy.next}</Button>
    </section>
  );
}
