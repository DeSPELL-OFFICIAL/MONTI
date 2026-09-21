// The queue, as a staff member has to be able to read it at a door.
//
// Purely presentational: rows in, callbacks out. Task 30 owns the queue's lifetime — when a
// reconciliation runs, what `orgId` and `endsAt` it runs with, when the list is re-read — and a
// screen that fetched for itself would either duplicate that or fight it. It also keeps this
// testable without IndexedDB, which is the other half of why.
//
// What it refuses to do is as much of the design as what it shows:
//
// **A conflict has no button.** Somebody is already inside on that ticket; there is nothing left
// to send, and a retry offered there would be a promise the chain will not keep. The row exists
// to be read out loud — which gate, what time.
//
// **One retry at a time.** Every retry is held while one is in flight, rather than the row
// vanishing from the list: a staff member tapping down a column of parked entries must not have
// the next one slide under their thumb.
import { fmt, useLocale } from '../../shared/i18n';
import { Alert, Button, Screen } from '../../shared/ui';
import { useStaffQueueCopy, type StaffQueueCopy } from './copy';
import { DRY_RUN_MARK, LATE_WINDOW_ELAPSED } from './opQueue';
import type { ReconciledEntry } from './reconcile';

export interface QueueScreenProps {
  /** Task 28's `allEntries()`, after Task 29 has settled what it can. */
  entries: ReconciledEntry[];
  /** Run a reconciliation pass: drain what can go, settle what cannot. */
  onReconcile: () => void;
  /** Re-arm one parked entry — `opQueue.retryEntry(id)`. */
  onRetry: (id: string) => void;
  /** A reconciliation is running. */
  busy?: boolean;
  /** The id of the entry a retry is in flight for, if any. */
  retrying?: string;
}

const CONFLICTS_HEADING = 'staff-queue-conflicts';
const PARKED_HEADING = 'staff-queue-parked';

/**
 * Why an entry stopped, in the one vocabulary a staff member can act on. The two queue marks get
 * their own sentence because they mean opposite things — one is "this event is over", the other
 * is "this build cannot send it yet" — and everything else is shown with its raw `lastError`
 * beside the generic line, so a field report can name what this screen could not.
 */
function reasonFor(entry: ReconciledEntry, copy: StaffQueueCopy): string {
  if (entry.lastError === LATE_WINDOW_ELAPSED) return copy.reasonLateWindow;
  if (entry.lastError === DRY_RUN_MARK) return copy.reasonNotDeployed;
  return copy.reasonOther;
}

export function QueueScreen({ entries, onReconcile, onRetry, busy = false, retrying }: QueueScreenProps) {
  const copy = useStaffQueueCopy();
  const locale = useLocale() === 'en' ? 'en-US' : 'ko-KR';

  // `sent` is counted as waiting: an operation whose receipt never arrived is as unaccounted for
  // as one that has not left, and the two are the same thing to the person asking "how many
  // people are in here that the record does not have yet?".
  const waiting = entries.filter((e) => e.status === 'pending' || e.status === 'sent').length;
  const done = entries.filter((e) => e.status === 'confirmed').length;
  const conflicts = entries.filter((e) => e.status === 'conflict');
  const parked = entries.filter((e) => e.status === 'failed');

  return (
    <Screen title={copy.title}>
      {entries.length === 0 ? (
        <p>{copy.empty}</p>
      ) : (
        <p>{fmt(copy.counts, { waiting, done, conflicts: conflicts.length, parked: parked.length })}</p>
      )}

      <Button onClick={onReconcile} disabled={busy}>
        {busy ? copy.reconciling : copy.reconcile}
      </Button>

      {conflicts.length === 0 ? null : (
        <section className="staff-queue__conflicts">
          <h2 id={CONFLICTS_HEADING}>{copy.conflictsTitle}</h2>
          <Alert tone="warn">{copy.conflictsHint}</Alert>
          <ul aria-labelledby={CONFLICTS_HEADING}>
            {conflicts.map((entry) => (
              <li key={entry.id}>
                {fmt(copy.conflictLine, {
                  tokenId: entry.tokenId,
                  gateId: entry.firstGateId ?? '',
                  time: new Date((entry.firstTs ?? 0) * 1000).toLocaleTimeString(locale),
                })}
              </li>
            ))}
          </ul>
        </section>
      )}

      {parked.length === 0 ? null : (
        <section className="staff-queue__parked">
          <h2 id={PARKED_HEADING}>{copy.parkedTitle}</h2>
          <p>{copy.parkedHint}</p>
          <ul aria-labelledby={PARKED_HEADING}>
            {parked.map((entry) => (
              <li key={entry.id}>
                <span>{fmt(copy.ticket, { tokenId: entry.tokenId })}</span>
                <span>{reasonFor(entry, copy)}</span>
                {reasonFor(entry, copy) === copy.reasonOther && entry.lastError !== undefined ? (
                  <code className="mono">{entry.lastError}</code>
                ) : null}
                <Button
                  variant="ghost"
                  onClick={() => onRetry(entry.id)}
                  disabled={retrying !== undefined}
                >
                  {retrying === entry.id ? copy.retrying : copy.retry}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </Screen>
  );
}
