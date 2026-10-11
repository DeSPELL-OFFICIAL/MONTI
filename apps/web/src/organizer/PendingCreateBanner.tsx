import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Alert } from '../shared/ui';
import { listEventDrafts, watchRelay, type EventDraft } from '../shared/api/firestore';
import { forgetEventDraft, normalizeEventDraft } from './useEventDraft';
import { followUpPlan, followUpsDone, runFollowUps } from './scene/followUps';
import { useOrganizerCopy } from './copy';

/**
 * The background "확인 중" banner on the organiser home (계획 §2a). When a publish was
 * broadcast by the relayer (`sent`) and the organiser chose 나중에 확인, the draft is left with the
 * relay id written and no event id read back. This is where the scene's promise — "잠시 뒤 주최자
 * 화면에서 확인" — is actually kept: the home finds that one draft, follows its `relays/{relayId}`
 * document, and resolves it with no manual refresh:
 *
 *   pending/sent → an info banner, with a link back into the draft;
 *   confirmed    → the two follow-up writes the scene never reached, then the done screen;
 *   failed       → a plain line and a link back in to try again.
 *
 * A dropped Firestore listener leaves the banner as it is, because the safe answer to "did my
 * event get created?" is never "make another one".
 */

interface Pending {
  draftId: string;
  draft: EventDraft;
  relayId: string;
}

export function PendingCreateBanner() {
  const copy = useOrganizerCopy().home;
  const navigate = useNavigate();
  const [pending, setPending] = useState<Pending | null>(null);
  const [failed, setFailed] = useState(false);

  // The one draft that left a relay behind: an id written, no event id read back.
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
        return draft.submittedRelayId !== '' && draft.createdEventId === '';
      });
      if (row === undefined) return;
      const draft = normalizeEventDraft(row.data);
      setPending({ draftId: row.id, draft, relayId: draft.submittedRelayId });
    })();
    return () => {
      live = false;
    };
  }, []);

  // Follow that relay until it confirms or fails.
  useEffect(() => {
    if (pending === null) return undefined;
    let live = true;
    const sub: { stop?: () => void } = {};
    sub.stop = watchRelay(
      pending.relayId,
      (relay) => {
        if (!live || relay === null) return;
        if (relay.status === 'failed') {
          // Reverted, or the relayer could not send it: the way back in lives in the draft.
          sub.stop?.();
          setFailed(true);
          return;
        }
        if (relay.status !== 'confirmed') return; // pending/sent: keep the 확인 중 banner.
        sub.stop?.();
        // Confirmed. The event is on chain, but the two writes the scene runs after it never
        // happened, so they run here before the done screen — the same steps as `usePublish.finish`.
        void (async () => {
          const eventId = relay.result?.eventId ?? '';
          if (eventId === '') {
            // Confirmed but named no event id (a backend fault): send them to the draft's publish
            // screen, whose 공개하기 follows the same relay again and never creates a second event.
            navigate(`/org/new/${pending.draftId}/publish`);
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
        })();
      },
      () => undefined, // a dropped listener leaves the banner as it is.
    );
    return () => {
      live = false;
      sub.stop?.();
    };
  }, [pending, navigate]);

  if (pending === null) return null;
  return (
    <Alert tone={failed ? 'error' : 'info'}>
      {failed ? copy.pendingCreateFailed : copy.pendingCreate}{' '}
      <Link to={`/org/new/${pending.draftId}/publish`}>{copy.pendingCreateOpen}</Link>
    </Alert>
  );
}
