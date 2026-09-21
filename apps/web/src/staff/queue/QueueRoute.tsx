// The queue screen's one mount: where the reconciliation actually runs.
//
// `QueueScreen` (Task 29) is presentational — rows in, two callbacks out — and `reconcileQueue`
// is the pass that settles them against the chain. This file is the only place the two meet, and
// the only place `reconcileQueue` is called from at all.
//
// That matters more than it looks. The reconciliation drains the queue on its way through, and
// the drain is the one writer of every row: two callers would each read a row as unsent, each
// send the same sponsored operation, and each write back its own stale copy. Task 29 serialises
// `drainQueue` against exactly that, and this screen keeps the second caller from existing in
// the first place — the gate screen's connectivity watcher is the other one, and the two screens
// are sibling routes that are never mounted together.
import { useCallback, useEffect, useState, type ReactElement } from 'react';

import { Screen, Spinner } from '../../shared/ui';
import { useStaffCopy } from '../copy';
import { warn } from '../log';
import { useGateRegistration } from '../setup/useGateRegistration';
import { allEntries, retryEntry } from './opQueue';
import { QueueScreen } from './QueueScreen';
import { reconcileQueue, type ReconciledEntry } from './reconcile';

export function QueueRoute(): ReactElement {
  const copy = useStaffCopy();
  const { orgId } = useGateRegistration();
  const [entries, setEntries] = useState<ReconciledEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [retrying, setRetrying] = useState<string>();
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    const rows = (await allEntries()) as ReconciledEntry[];
    setEntries(rows);
    setLoaded(true);
  }, []);

  useEffect(() => {
    void load().catch((error) => warn('queue', 'could not read the queue', error));
  }, [load]);

  /**
   * "지금 맞춰 보기". A staff member pressing it is asking for a send attempt now, so no
   * `isOnline` is passed: the button *is* the signal that somebody believes the connection is
   * back, and a pass made while it is not costs one failed read per unsettled row and changes
   * nothing.
   */
  const reconcile = useCallback(() => {
    if (orgId === undefined) return;
    setBusy(true);
    void reconcileQueue({ orgId })
      .catch((error) => warn('queue', 'reconcile failed', error))
      .then(load)
      .catch((error) => warn('queue', 'could not read the queue', error))
      .finally(() => setBusy(false));
  }, [orgId, load]);

  const retry = useCallback(
    (id: string) => {
      setRetrying(id);
      void retryEntry(id)
        .catch((error) => warn('queue', 'could not re-arm the entry', error))
        .then(load)
        .catch((error) => warn('queue', 'could not read the queue', error))
        .finally(() => setRetrying(undefined));
    },
    [load],
  );

  if (!loaded) {
    return (
      <Screen title={copy.queue.title}>
        <Spinner />
      </Screen>
    );
  }

  return (
    <QueueScreen
      entries={entries}
      onReconcile={reconcile}
      onRetry={retry}
      busy={busy || orgId === undefined}
      retrying={retrying}
    />
  );
}
