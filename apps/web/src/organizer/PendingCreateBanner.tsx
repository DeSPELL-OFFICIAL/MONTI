import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { Hex } from 'viem';
import { Alert } from '../shared/ui';
import { listEventDrafts, type EventDraft } from '../shared/api/firestore';
import { resolveSubmittedOp } from '../shared/chain/ops';
import { createdEventId } from '../shared/chain/createdEvent';
import { forgetEventDraft, normalizeEventDraft } from './useEventDraft';
import { followUpPlan, followUpsDone, runFollowUps } from './scene/followUps';
import { useOrganizerCopy } from './copy';

/**
 * The background "확인 중" banner on the organiser home (계획 §2a). When a `createEvent` op ran past
 * the creation scene's 45s cap and the organiser chose 나중에 확인, the draft is left with the op
 * hash written and no event id read back. This is where the scene's promise — "잠시 뒤 주최자
 * 화면에서 확인" — is actually kept: the home finds that one draft, polls the op, and resolves it
 * with no manual refresh:
 *
 *   pending  → an info banner, with a link back into the draft;
 *   landed   → the two follow-up writes the scene never reached, then the done screen;
 *   reverted → a plain line and a link back in to try again.
 *
 * A bundler it cannot reach reads as pending, because the safe answer to "did my event get
 * created?" is never "make another one".
 */

const POLL_MS = 4_000;

interface Pending {
  draftId: string;
  draft: EventDraft;
  hash: Hex;
}

export function PendingCreateBanner() {
  const copy = useOrganizerCopy().home;
  const navigate = useNavigate();
  const [pending, setPending] = useState<Pending | null>(null);
  const [failed, setFailed] = useState(false);

  // The one draft that left an op behind: a hash written, no id read back, and not an edit.
  useEffect(() => {
    let live = true;
    void (async () => {
      let stored;
      try {
        stored = await listEventDrafts();
      } catch {
        return; // offline, or a login that expired: there is nothing to resolve.
      }
      if (!live) return;
      const row = stored.find((entry) => {
        const draft = normalizeEventDraft(entry.data);
        return draft.submittedOpHash !== ''
          && draft.createdEventId === ''
          && draft.editingEventId === '';
      });
      if (row === undefined) return;
      const draft = normalizeEventDraft(row.data);
      setPending({ draftId: row.id, draft, hash: draft.submittedOpHash as Hex });
    })();
    return () => {
      live = false;
    };
  }, []);

  // Poll that op until it lands or reverts.
  useEffect(() => {
    if (pending === null) return undefined;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async (): Promise<void> => {
      const result = await resolveSubmittedOp(pending.hash, pending.draft.submittedAt).catch(
        () => ({ state: 'pending', logs: [] }) as const,
      );
      if (!live) return;
      if (result.state === 'pending') {
        timer = setTimeout(() => void tick(), POLL_MS);
        return;
      }
      // `failed` (dropped or reverted) and `stale` (stuck in the mempool) both mean the op will
      // not land on its own — the resend lives in the draft, so surface the way back in.
      if (result.state === 'failed' || result.state === 'stale') {
        setFailed(true);
        return;
      }
      // Landed. The event is on chain, but the two writes the scene runs after it never happened,
      // so they run here before the done screen — the same steps as `usePublish.finish`.
      const eventId = createdEventId(result.logs);
      if (eventId === '') {
        // Landed but its logs named nothing readable: send them into the draft, whose 만들기 button
        // asks the bundler again by hash and never creates a second event.
        navigate(`/org/new/${pending.draftId}`);
        return;
      }
      const plan = followUpPlan(pending.draft, eventId);
      const done = await runFollowUps(plan);
      const complete = followUpsDone(plan, done);
      if (complete) await forgetEventDraft(pending.draftId).catch(() => undefined);
      if (!live) return;
      navigate(`/org/new/done/${eventId}`, {
        state: {
          posterCid: pending.draft.posterCid,
          title: pending.draft.title.trim(),
          followUpFailed: !complete,
          draftId: pending.draftId,
          plan,
          done,
        },
      });
    };
    void tick();
    return () => {
      live = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [pending, navigate]);

  if (pending === null) return null;
  return (
    <Alert tone={failed ? 'error' : 'info'}>
      {failed ? copy.pendingCreateFailed : copy.pendingCreate}{' '}
      <Link to={`/org/new/${pending.draftId}`}>{copy.pendingCreateOpen}</Link>
    </Alert>
  );
}
