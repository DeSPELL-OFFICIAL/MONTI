import { Alert, Button, Spinner } from '../../shared/ui';
import { useLocale } from '../../shared/i18n';
import { useOrganizerCopy, type OrganizerCopy } from '../copy';
import { toLocalInput } from './datetime';
import { KR_REGIONS } from './regions';
import { usePublish } from './usePublish';
import type { WizardDraft } from './buildEventMeta';

/** The theme's own name, or its number when a stored draft carries one the app does not offer. */
function categoryLabel(copy: OrganizerCopy['wizard'], category: number): string {
  const labels: Record<number, string> = {
    0: copy.category0, 1: copy.category1, 2: copy.category2, 3: copy.category3,
  };
  return labels[category] ?? String(category);
}

/** Every value that goes on chain, spelled out — the three hashed strings included. */
function Row({ label, value }: { label: string; value: string }) {
  return (
    <p>
      <strong>{label}</strong> {value}
    </p>
  );
}

const HINT = { color: 'var(--muted)', fontSize: 13 } as const;

export function Step6Review({
  draft, patch, onBack, onPublished, onDone,
}: {
  draft: WizardDraft;
  /** The draft is marked with the operation's hash when a `wait` gives up, so a reload cannot
   *  publish the same event twice. */
  patch: (next: Partial<WizardDraft>) => void;
  onBack: () => void;
  /** Runs the moment the event is on chain: the wizard throws the draft away here. */
  onPublished: () => void;
  /** Where the organiser goes once they have read the confirmation. */
  onDone: () => void;
}) {
  const copy = useOrganizerCopy().wizard;
  const locale = useLocale();
  const { phase, problems, error, publish } = usePublish(draft, onPublished, patch);
  const region = KR_REGIONS.find((entry) => entry.code === draft.regionCode);
  const busy = phase === 'pinning' || phase === 'sending';
  const yes = locale === 'en' ? 'Yes' : '예';
  const no = locale === 'en' ? 'No' : '아니요';

  // The draft was thrown away the moment this landed, so the review rows below would all be
  // blank: the confirmation replaces them rather than sitting under an empty form.
  if (phase === 'published') {
    return (
      <section>
        <h2>{copy.step6}</h2>
        <Alert tone="info">{copy.published}</Alert>
        <Button onClick={onDone}>{copy.heading}</Button>
      </section>
    );
  }

  return (
    <section>
      <h2>{copy.step6}</h2>
      <h3>{copy.reviewTitle}</h3>
      <Row label={copy.orgId} value={draft.orgId} />
      <Row label={copy.title} value={draft.title} />
      <Row label={copy.description} value={draft.description} />
      <Row label={copy.venue} value={draft.venue} />
      <Row label={copy.region} value={region ? (locale === 'en' ? region.labelEn : region.labelKo) : draft.regionCode} />
      <Row label={copy.category} value={categoryLabel(copy, draft.category)} />
      <Row label={copy.startsAt} value={toLocalInput(draft.startsAt)} />
      <Row label={copy.endsAt} value={toLocalInput(draft.endsAt)} />
      <Row label={copy.saleStart} value={toLocalInput(draft.saleStart)} />
      <Row label={copy.saleEnd} value={toLocalInput(draft.saleEnd)} />
      <Row label={copy.transferable} value={draft.transferable ? yes : no} />
      <Row label={copy.cutoff} value={String(draft.transferCutoffHours)} />
      <Row label={copy.maxTransfers} value={String(draft.maxTransfers)} />
      <Row label={copy.approvalRequired} value={draft.approvalRequired ? yes : no} />
      <Row label={copy.requireKyc} value={draft.requireKyc ? yes : no} />
      <Row label={copy.image} value={draft.image?.fileName ?? ''} />
      {draft.tiers.map((tier, index) => (
        <Row
          key={index}
          label={`${copy.tierName} ${index + 1}`}
          value={`${tier.name} · ${copy.supply} ${tier.supply} · ${copy.maxPerWallet} ${tier.maxPerWallet}`}
        />
      ))}
      {draft.gates.length > 0 ? <Row label={copy.gateName} value={draft.gates.join(', ')} /> : null}

      <p style={HINT}>{copy.reviewHashed}</p>
      <Alert tone="info">{copy.feeNote}</Alert>
      {draft.approvalRequired ? <Alert tone="warn">{copy.approvalWarning}</Alert> : null}

      {problems.length > 0 ? (
        <Alert tone="error">
          {copy.fixFirst}
          <ul>
            {problems.map((problem) => (
              <li key={problem}>{copy.problems[problem]}</li>
            ))}
          </ul>
        </Alert>
      ) : null}
      {error ? (
        <Alert tone="error">
          {error}
          {error === copy.unsponsored ? <span> {copy.unsponsoredHelp}</span> : null}
        </Alert>
      ) : null}
      {phase === 'pinning' ? <Alert tone="info">{copy.pinning}</Alert> : null}
      {phase === 'sending' ? <Alert tone="info">{copy.publishing}</Alert> : null}
      {/* `wait` gave up before the operation landed. Not a failure — it is still on its way. */}
      {phase === 'confirming' ? <Alert tone="info">{copy.confirming}</Alert> : null}
      {busy ? <Spinner /> : null}

      <Button variant="ghost" onClick={onBack} disabled={busy}>{copy.back}</Button>
      <Button onClick={() => void publish()} disabled={phase !== 'idle'}>{copy.publish}</Button>
    </section>
  );
}
