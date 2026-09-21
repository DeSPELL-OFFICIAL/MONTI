import { Alert, Button, Field } from '../../shared/ui';
import { useOrganizerCopy } from '../copy';
import { fromLocalInput, toLocalInput } from './datetime';
import type { StepProps } from './Step1Basic';

const HINT = { color: 'var(--muted)', fontSize: 13 } as const;

export function Step4Rules({ draft, patch, onNext, onBack }: StepProps & { onBack: () => void }) {
  const copy = useOrganizerCopy().wizard;
  return (
    <section>
      <h2>{copy.step4}</h2>
      <Field label={copy.saleStart}>
        <input
          type="datetime-local"
          value={toLocalInput(draft.saleStart)}
          onChange={(event) => patch({ saleStart: fromLocalInput(event.target.value) })}
        />
      </Field>
      <Field label={copy.saleEnd}>
        <input
          type="datetime-local"
          value={toLocalInput(draft.saleEnd)}
          onChange={(event) => patch({ saleEnd: fromLocalInput(event.target.value) })}
        />
      </Field>
      <Field label={copy.maxTransfers}>
        <input
          type="number" min={0} max={255} value={draft.maxTransfers}
          onChange={(event) => patch({ maxTransfers: Number(event.target.value) })}
        />
      </Field>
      <Field label={copy.cutoff}>
        <input
          type="number" min={0} value={draft.transferCutoffHours}
          onChange={(event) => patch({ transferCutoffHours: Number(event.target.value) })}
        />
      </Field>
      <label>
        <input
          type="checkbox" checked={draft.transferable}
          onChange={(event) => patch({ transferable: event.target.checked })}
        />
        {copy.transferable}
      </label>
      <label>
        <input
          type="checkbox" checked={draft.approvalRequired}
          onChange={(event) => patch({ approvalRequired: event.target.checked })}
        />
        {copy.approvalRequired}
      </label>
      {/* `Ticket.claim` reverts `ApprovalRequiredNotSupported` on any event with this on, so an
          event published this way is one nobody could get a ticket for. */}
      {draft.approvalRequired ? <Alert tone="warn">{copy.approvalWarning}</Alert> : null}
      <label>
        <input
          type="checkbox" checked={draft.requireKyc}
          onChange={(event) => patch({ requireKyc: event.target.checked })}
        />
        {copy.requireKyc}
      </label>
      <p style={HINT}>{copy.requireKycHelp}</p>
      <Button variant="ghost" onClick={onBack}>{copy.back}</Button>
      <Button onClick={onNext}>{copy.next}</Button>
    </section>
  );
}
