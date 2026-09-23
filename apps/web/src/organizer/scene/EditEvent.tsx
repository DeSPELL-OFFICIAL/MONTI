import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Alert, Screen, Spinner } from '../../shared/ui';
import { api } from '../../shared/api/functions';
import { loadEventArt, saveEventDraft } from '../../shared/api/firestore';
import { gql } from '../../shared/envio/client';
import { fetchEventMetadata } from '../../shared/envio/ipfs';
import { EVENT_QUERY, type EnvioEvent, type EnvioTier } from '../../shared/envio/queries';
import { useOrganizerCopy } from '../copy';
import { eventToDraft } from './eventToDraft';

/** The only status the chain lets an event be edited in (`Ticket.sol:235`). */
const DRAFT = 'Draft';

type EditProblem = '' | 'notDraft' | 'failed';

/**
 * `/org/events/:eventId/edit` — the way back into the creation scene for an event that already
 * exists, and nothing more than that.
 *
 * It reads the event out of the four places it lives, folds it into a draft, writes that draft
 * and hands over to the scene itself. The scene is therefore **not forked**: the same two
 * screens, the same rules, the same autosave, and one field on the draft (`editingEventId`)
 * that makes the last button send `updateEventMeta` instead of `createEvent`.
 *
 * The chain closes editing the moment an event is published, so a status that is not `Draft`
 * is refused here rather than at the end — the plan's rule about never letting somebody fill a
 * whole screen in before being told no.
 */
export function EditEvent() {
  const copy = useOrganizerCopy().scene.edit;
  const { eventId = '' } = useParams();
  const navigate = useNavigate();
  const [problem, setProblem] = useState<EditProblem>('');
  /** The prefill runs once. StrictMode runs this effect twice; two drafts is one too many. */
  const started = useRef(false);

  useEffect(() => {
    if (started.current || eventId === '') return;
    started.current = true;

    void (async () => {
      try {
        const indexed = await gql<{ Event: EnvioEvent[]; Tier: EnvioTier[] }>(EVENT_QUERY, {
          id: eventId,
          eventId,
        });
        const event = indexed.Event[0];
        if (event === undefined) {
          setProblem('failed');
          return;
        }
        if (event.status !== DRAFT) {
          setProblem('notDraft');
          return;
        }

        const [metadata, art] = await Promise.all([
          fetchEventMetadata(event.imageCid).catch(() => null),
          loadEventArt(eventId),
        ]);
        // A document the gateway would not hand over is a refusal, not an empty prefill: the
        // title and the description would come back blank, and saving a blank one over the
        // real one is exactly the damage an edit screen must not be able to do.
        if (metadata === null) {
          setProblem('failed');
          return;
        }
        // The hidden venue is nowhere in the public document; the callable is the only copy.
        const priv = metadata.venueHidden
          ? await api.getEventPrivate({ eventId }).catch(() => ({ venue: '' }))
          : { venue: '' };

        const draftId = crypto.randomUUID();
        await saveEventDraft(
          draftId,
          eventToDraft(eventId, {
            event,
            tiers: indexed.Tier,
            metadata,
            privateVenue: priv.venue ?? '',
            art,
          }),
        );
        // `replace`, so the back gesture goes to the event and not through this screen again.
        navigate(`/org/new/${draftId}`, { replace: true });
      } catch {
        setProblem('failed');
      }
    })();
  }, [eventId, navigate]);

  return (
    <Screen title={copy.title}>
      {problem === '' ? (
        <>
          <Spinner />
          <p className="muted">{copy.loading}</p>
        </>
      ) : (
        <>
          <Alert tone={problem === 'notDraft' ? 'warn' : 'error'}>{copy[problem]}</Alert>
          <p>
            <Link to={`/org/events/${eventId}`}>{copy.back}</Link>
          </p>
        </>
      )}
    </Screen>
  );
}
