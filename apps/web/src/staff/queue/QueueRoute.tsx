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
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';

import { readTicket } from '../../shared/chain/reads';
import { Button, Screen, Spinner } from '../../shared/ui';
import { useStaffCopy } from '../copy';
import { warn } from '../log';
import { useGateRegistration } from '../setup/useGateRegistration';
import { allEntries, retryEntry } from './opQueue';
import { QueueScreen } from './QueueScreen';
import { reconcileQueue, type ReconciledEntry } from './reconcile';

/** Back to the door. Relative: the staff routes are a subtree. */
const GATE_PATH = '../gate';

export function QueueRoute(): ReactElement {
  const copy = useStaffCopy();
  const navigate = useNavigate();
  const { orgId, eventId } = useGateRegistration();
  const [entries, setEntries] = useState<ReconciledEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [retrying, setRetrying] = useState<string>();
  const [loaded, setLoaded] = useState(false);
  /**
   * `Ticket.eventMeta(eventId).endsAt`, seconds — the same value the gate screen's drain passes.
   * **One park policy.** Without it this pass would leave rows pending that the gate's own pass
   * parks, so which of the two ran last would decide what a staff member is looking at.
   */
  const endsAt = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (eventId === undefined) return;
    let alive = true;
    void readTicket()
      .eventMeta(eventId)
      .then((meta) => {
        if (alive) endsAt.current = Number(meta.endsAt);
      })
      .catch(() => {
        // Unreadable: nothing is parked early, and the attempt limit decides instead. The safe
        // way to be wrong — a queue that parks eagerly throws away check-ins the chain still takes.
      });
    return () => {
      alive = false;
    };
  }, [eventId]);

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
    void reconcileQueue({ orgId, endsAt: endsAt.current })
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
    <>
      <QueueScreen
        entries={entries}
        onReconcile={reconcile}
        onRetry={retry}
        busy={busy || orgId === undefined}
        retrying={retrying}
      />
      {/*
        The way back. This is a kiosk with no address bar, so a screen with no exit is a dead end
        — and the label is the setup screen's own hand-off line, which already says exactly this.
      */}
      <Button variant="ghost" onClick={() => navigate(GATE_PATH)}>
        {copy.setup.openGate}
      </Button>
    </>
  );
}
