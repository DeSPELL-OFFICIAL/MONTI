import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Alert, Button, Screen, Spinner } from '../../shared/ui';
import { useCopy } from '../../shared/i18n';
import { describeFailure } from '../../shared/errors';
import { api } from '../../shared/api/functions';
import { loadEventArt, saveEventDraft } from '../../shared/api/firestore';
import { gql } from '../../shared/envio/client';
import { fetchEventMetadata } from '../../shared/envio/ipfs';
import { EVENT_QUERY, type EnvioEvent, type EnvioTier } from '../../shared/envio/queries';
import { useOrganizerCopy } from '../copy';
import { eventToDraft } from './eventToDraft';

/** The only status the chain lets an event be edited in (`Ticket.sol:235`). */
const DRAFT = 'Draft';

/** An event the indexer has no row for; `describeFailure` has no sentence of its own for it. */
class EventNotFound extends Error {}

/**
 * `/org/events/:eventId/edit` — the way back into the creation scene for an event that already
 * exists, and nothing more than that.
 *
 * It reads the event out of the four places it lives, folds it into a draft, writes that draft
 * and hands over to the scene itself. The scene is therefore **not forked**: the same two
 * screens, the same rules, the same autosave, and one field on the draft (`editingEventId`)
 * that makes the last button send `updateEventMeta` instead of `createEvent`.
 *
 * **Every read has to succeed before the scene opens.** Saving an edit replaces what it was
 * built from — the pinned document, and `eventArt/{eventId}` through the follow-up — so a
 * prefill that quietly used defaults for a source it could not read would write those defaults
 * over the real thing. A blank title over a real one, or the first preset over pictures an
 * organiser uploaded, is the one piece of damage an edit screen must not be able to do. So a
 * failed read is a refusal with a retry, not an empty field.
 *
 * The chain closes editing the moment an event is published, so a status that is not `Draft`
 * is refused here too — the plan's rule about never letting somebody fill a whole screen in
 * before being told no.
 */
export function EditEvent() {
  const copy = useOrganizerCopy().scene.edit;
  const shared = useCopy();
  const { eventId = '' } = useParams();
  const navigate = useNavigate();
  /** The rejection to put a sentence on, or `null` while nothing has gone wrong. */
  const [failure, setFailure] = useState<unknown>(null);
  const [notDraft, setNotDraft] = useState(false);
  /** Bumped by 다시 시도, which is the only thing that runs the prefill a second time. */
  const [attempt, setAttempt] = useState(0);
  /** One prefill per attempt. StrictMode runs this effect twice; two drafts is one too many. */
  const ran = useRef(-1);

  useEffect(() => {
    if (ran.current === attempt || eventId === '') return;
    ran.current = attempt;

    void (async () => {
      try {
        const indexed = await gql<{ Event: EnvioEvent[]; Tier: EnvioTier[] }>(EVENT_QUERY, {
          id: eventId,
          eventId,
        });
        const event = indexed.Event[0];
        if (event === undefined) throw new EventNotFound(eventId);
        if (event.status !== DRAFT) {
          setNotDraft(true);
          return;
        }

        // Neither read is allowed to fail quietly: the words and the pictures are both written
        // back by a save, so a default here is a default saved over the real thing.
        const [metadata, art] = await Promise.all([
          fetchEventMetadata(event.imageCid),
          loadEventArt(eventId),
        ]);
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
      } catch (cause) {
        setFailure(cause);
      }
    })();
  }, [attempt, eventId, navigate]);

  function retry(): void {
    setFailure(null);
    setAttempt((count) => count + 1);
  }

  if (notDraft) {
    return (
      <Screen title={copy.title}>
        <Alert tone="warn">{copy.notDraft}</Alert>
        <p>
          <Link to={`/org/events/${eventId}`}>{copy.back}</Link>
        </p>
      </Screen>
    );
  }

  if (failure !== null) {
    return (
      <Screen title={copy.title}>
        <Alert tone="error">{describeFailure(failure, shared)}</Alert>
        <Button onClick={retry}>{shared.common.retry}</Button>
        <p>
          <Link to={`/org/events/${eventId}`}>{copy.back}</Link>
        </p>
      </Screen>
    );
  }

  return (
    <Screen title={copy.title}>
      <Spinner />
      <p className="muted">{copy.loading}</p>
    </Screen>
  );
}
