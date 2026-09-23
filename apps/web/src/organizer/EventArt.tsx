import { useEffect, useState } from 'react';
import { Alert, Button, TicketArt } from '../shared/ui';
import type { TicketArtSource } from '../shared/ui';
import { fmt } from '../shared/i18n';
import { api, callableFailure } from '../shared/api/functions';
import { loadEventArt } from '../shared/api/firestore';
import { useOrganizerCopy } from './copy';
import { ArtPicker } from './ArtPicker';

/** What a kind shows before anybody has chosen anything — the same fallback the ticket screens keep. */
const DEFAULT_ART: TicketArtSource = { preset: 'a' };

/** Nothing is open. A kind's index is what identifies it, and `-1` is no kind. */
const NONE = -1;

type SaveState = '' | 'saving' | 'saved' | 'notAllowed' | 'failed';

/** Only what the picture needs; the dashboard's rows carry the rest. */
export interface EventArtTier {
  name: string;
}

export interface EventArtProps {
  eventId: string;
  /** The kinds in `Tier.idx` order — the index **is** the position the stored list is read at. */
  tiers: readonly EventArtTier[];
  /** The event's own name, so the preview is the ticket an attendee will actually be handed. */
  title: string;
}

/**
 * The ticket pictures of an event that already exists, on the organiser's own screen.
 *
 * This is the one part of a ticket that can still be changed after the event is public: the
 * chain's `Tier` has no column for a picture and `updateEventMeta` refuses anything past Draft,
 * so the art lives in `eventArt/{eventId}` and `saveEventArt` is open for the life of the event
 * (plan section B-4). The section is therefore shown whatever the event's status is.
 *
 * **Every change sends the whole list.** `saveEventArt` replaces the document rather than
 * merging into it, so a call naming one kind would erase the pictures of all the others. That
 * also makes the write idempotent: sending the same list twice is the same as sending it once,
 * which is what lets a refused save simply be pressed again.
 */
export function EventArt({ eventId, tiers, title }: EventArtProps) {
  const copy = useOrganizerCopy().dashboard.art;
  const [art, setArt] = useState<TicketArtSource[]>([]);
  const [open, setOpen] = useState(NONE);
  const [state, setState] = useState<SaveState>('');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // A missing document is the ordinary case — most events have never been through
      // `saveEventArt` — and `loadEventArt` already answers it with an empty list rather than
      // a failure, so there is nothing here to tell the organiser about.
      const stored = await loadEventArt(eventId);
      if (!cancelled) setArt(stored);
    })();
    return () => {
      cancelled = true;
    };
  }, [eventId]);

  const artOf = (index: number): TicketArtSource => art[index] ?? DEFAULT_ART;

  async function change(index: number, next: TicketArtSource): Promise<void> {
    const full = tiers.map((_, at) => (at === index ? next : artOf(at)));
    // Shown straight away, and left on screen even when the write is refused: the choice is
    // still theirs to send again, and reverting the picture under them would read as the app
    // having changed its mind rather than as a save that did not land.
    setArt(full);
    setState('saving');
    try {
      await api.saveEventArt({ eventId, tiers: full });
      setState('saved');
      setOpen(NONE);
    } catch (cause) {
      const { code } = callableFailure(cause);
      setState(code === 'permission-denied' ? 'notAllowed' : 'failed');
    }
  }

  return (
    <section className="event-art">
      <h2>{copy.title}</h2>
      <p className="muted">{copy.help}</p>

      <ul className="tier-list-cards">
        {tiers.map((tier, index) => (
          // The index is the identity: `Tier.idx` is the position `eventArt` stores against.
          <li className="tier-card" key={index}>
            <div className="tier-card__head">
              <h3>{tier.name === '' ? fmt(copy.kind, { index: index + 1 }) : tier.name}</h3>
              <Button variant="ghost" onClick={() => setOpen(open === index ? NONE : index)}>
                {open === index ? copy.close : copy.change}
              </Button>
            </div>
            <div className="tier-card__art">
              <TicketArt art={artOf(index)} title={title} tierName={tier.name} />
            </div>
            {open === index ? (
              <ArtPicker
                art={artOf(index)}
                onPreset={(preset) => void change(index, { preset })}
                onUploaded={(imageCid) => void change(index, { imageCid })}
              />
            ) : null}
          </li>
        ))}
      </ul>

      {state === 'saving' ? <p className="muted">{copy.saving}</p> : null}
      {state === 'saved' ? <p className="muted">{copy.saved}</p> : null}
      {state === 'notAllowed' ? <Alert tone="error">{copy.notAllowed}</Alert> : null}
      {state === 'failed' ? <Alert tone="error">{copy.failed}</Alert> : null}
    </section>
  );
}
