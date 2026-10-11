import { Alert, Button, Field } from '../../shared/ui';
import { fmt } from '../../shared/i18n';
import { formatUsdCents } from '../../shared/money';
import { useOrganizerCopy, type OrganizerCopy } from '../copy';
import {
  blankRow, bpsToPercent, exampleSplit, percentToBps, validateRows,
  type RecipientRow, type SplitError,
} from './settlementModel';

export interface SplitEditorProps {
  rows: RecipientRow[];
  onChange: (rows: RecipientRow[]) => void;
  /** The ticket the worked example splits — the draft's first paid price. */
  exampleCents: number;
}

/** The sentence for each split problem; `''` when the split is valid. */
export function splitErrorText(error: SplitError, errors: OrganizerCopy['settlement']['errors']): string {
  switch (error) {
    case 'EMPTY': return errors.empty;
    case 'TOO_MANY': return errors.tooMany;
    case 'BAD_ACCOUNT': return errors.badAccount;
    case 'BAD_BPS': return errors.badBps;
    case 'NAME_TOO_LONG': return errors.nameTooLong;
    case 'BAD_TAG': return errors.badTag;
    case 'PLATFORM_LOW': return errors.platformLow;
    case 'BAD_SUM': return errors.badSum;
    default: return '';
  }
}

/**
 * The revenue-split editor of the publish screen: one row per recipient, the MONTI platform row
 * locked (its account and tag are fixed, only its share is editable and never below 5%), a live
 * sum that must reach 100%, and a worked example on the draft's own price. It holds no state of
 * its own — the publish screen keeps the rows and writes them to the draft's `splitJson`.
 */
export function SplitEditor({ rows, onChange, exampleCents }: SplitEditorProps) {
  const copy = useOrganizerCopy().settlement;
  const validation = validateRows(rows);
  const example = exampleSplit(rows, exampleCents);
  const error = splitErrorText(validation.error, copy.errors);

  const setRow = (id: string, patch: Partial<RecipientRow>): void =>
    onChange(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));

  return (
    <>
      <ul className="split-rows" style={{ listStyle: 'none', padding: 0 }}>
        {rows.map((row) => (
          <li key={row.id} className="split-row">
            <Field label={copy.nameLabel}>
              <input
                value={row.name}
                readOnly={row.platform}
                onChange={(e) => setRow(row.id, { name: e.target.value })}
              />
            </Field>
            <Field label={copy.percentLabel}>
              <input
                inputMode="decimal"
                value={bpsToPercent(row.bps)}
                onChange={(e) => {
                  const bps = percentToBps(e.target.value);
                  if (bps !== null) setRow(row.id, { bps });
                  else if (e.target.value.trim() === '') setRow(row.id, { bps: 0 });
                }}
              />
            </Field>
            {row.platform ? (
              <p className="muted">{copy.platformNote}</p>
            ) : (
              <>
                <Field label={copy.tagLabel}>
                  <input value={row.tag} onChange={(e) => setRow(row.id, { tag: e.target.value })} />
                </Field>
                <details className="more">
                  <summary>{copy.accountSummary}</summary>
                  <Field label={copy.accountLabel}>
                    <input
                      value={row.account}
                      placeholder="0x…"
                      onChange={(e) => setRow(row.id, { account: e.target.value.trim() })}
                    />
                  </Field>
                </details>
                <Button variant="ghost" onClick={() => onChange(rows.filter((kept) => kept.id !== row.id))}>
                  {copy.removeRow}
                </Button>
              </>
            )}
          </li>
        ))}
      </ul>
      <Button variant="ghost" onClick={() => onChange([...rows, blankRow()])}>{copy.addRow}</Button>

      <p className={validation.ok ? 'settlement-sum' : 'settlement-sum settlement-sum--off'}>
        {copy.sumLabel}: {bpsToPercent(validation.sumBps)}%
      </p>

      <div className="settlement-example">
        <h3>{fmt(copy.exampleFor, { price: formatUsdCents(exampleCents) })}</h3>
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {example.map((line, i) => (
            <li key={i}>{line.name} · {formatUsdCents(line.cents)}</li>
          ))}
        </ul>
      </div>

      {error !== '' ? <Alert tone="warn">{error}</Alert> : null}
    </>
  );
}
