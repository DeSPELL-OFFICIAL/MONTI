import { Button, Field } from '../../shared/ui';
import { useOrganizerCopy } from '../copy';
import type { StepProps } from './Step1Basic';

/**
 * The entrances, by name. Nothing is registered here on purpose: linking a terminal needs that
 * terminal's own key, which only the device itself has, so the names written down here are what
 * the event screen offers to link once the event exists.
 */
const HINT = { color: 'var(--muted)', fontSize: 13 } as const;

export function Step5Staff({ draft, patch, onNext, onBack }: StepProps & { onBack: () => void }) {
  const copy = useOrganizerCopy().wizard;

  function rename(index: number, name: string): void {
    patch({ gates: draft.gates.map((gate, at) => (at === index ? name : gate)) });
  }

  return (
    <section>
      <h2>{copy.step5}</h2>
      <p style={HINT}>{copy.gatesHelp}</p>
      {draft.gates.length === 0 ? <p>{copy.gatesEmpty}</p> : null}
      {draft.gates.map((gate, index) => (
        // Positional, like the ticket kinds: a blank name has nothing else to identify it by.
        <fieldset key={index}>
          <Field label={`${copy.gateName} ${index + 1}`}>
            <input value={gate} onChange={(event) => rename(index, event.target.value)} />
          </Field>
          <Button variant="danger" onClick={() => patch({ gates: draft.gates.filter((_, at) => at !== index) })}>
            {copy.removeGate}
          </Button>
        </fieldset>
      ))}
      <Button variant="ghost" onClick={() => patch({ gates: [...draft.gates, ''] })}>{copy.addGate}</Button>
      <Button variant="ghost" onClick={onBack}>{copy.back}</Button>
      <Button onClick={onNext}>{copy.next}</Button>
    </section>
  );
}
