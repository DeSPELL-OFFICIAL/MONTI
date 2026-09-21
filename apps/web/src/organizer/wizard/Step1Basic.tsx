import { useState } from 'react';
import { Alert, Button, Field } from '../../shared/ui';
import { useOrganizerCopy } from '../copy';
import { CATEGORY_CODES, type WizardDraft } from './buildEventMeta';
import { ImageRejected, prepareImage } from './pinata';
import { KR_REGIONS } from './regions';
import { useLocale } from '../../shared/i18n';
import { fmt } from '../../shared/i18n';

export interface StepProps {
  draft: WizardDraft;
  patch: (next: Partial<WizardDraft>) => void;
  onNext: () => void;
}

const HINT = { color: 'var(--muted)', fontSize: 13 } as const;

export function Step1Basic({ draft, patch, onNext }: StepProps) {
  const copy = useOrganizerCopy().wizard;
  const locale = useLocale();
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState('');

  // The picture is only sent when the event is published, so this step narrows it to a type
  // and a size the backend takes and keeps it with the rest of the draft.
  async function choose(file: File | undefined): Promise<void> {
    if (!file) return;
    setWorking(true);
    setProblem('');
    try {
      patch({ image: await prepareImage(file) });
    } catch (cause) {
      setProblem(cause instanceof ImageRejected ? copy.problems[cause.problem] : copy.problems.pinFailed);
    } finally {
      setWorking(false);
    }
  }

  return (
    <section>
      <h2>{copy.step1}</h2>
      <Field label={copy.orgId}>
        <input inputMode="numeric" value={draft.orgId} onChange={(event) => patch({ orgId: event.target.value })} />
      </Field>
      <p style={HINT}>{copy.orgIdHelp}</p>
      <Field label={copy.title}>
        <input value={draft.title} onChange={(event) => patch({ title: event.target.value })} />
      </Field>
      <Field label={copy.description}>
        <textarea rows={4} value={draft.description} onChange={(event) => patch({ description: event.target.value })} />
      </Field>
      <Field label={copy.image}>
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          disabled={working}
          onChange={(event) => void choose(event.target.files?.[0])}
        />
      </Field>
      <p style={HINT}>{copy.imageHelp}</p>
      {working ? <Alert tone="info">{copy.imageWorking}</Alert> : null}
      {draft.image ? <Alert tone="info">{fmt(copy.imagePicked, { name: draft.image.fileName })}</Alert> : null}
      {problem ? <Alert tone="error">{problem}</Alert> : null}
      <Field label={copy.category}>
        <select value={draft.category} onChange={(event) => patch({ category: Number(event.target.value) })}>
          {CATEGORY_CODES.map((code) => (
            <option key={code} value={code}>{copy[`category${code}`]}</option>
          ))}
        </select>
      </Field>
      <Field label={copy.region}>
        <select value={draft.regionCode} onChange={(event) => patch({ regionCode: event.target.value })}>
          {KR_REGIONS.map((region) => (
            <option key={region.code} value={region.code}>
              {locale === 'en' ? region.labelEn : region.labelKo}
            </option>
          ))}
        </select>
      </Field>
      <Button onClick={onNext}>{copy.next}</Button>
    </section>
  );
}
