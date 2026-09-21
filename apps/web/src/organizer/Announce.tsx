import { useState } from 'react';
import { Alert, Button, Field } from '../shared/ui';
import { api, callableFailure } from '../shared/api/functions';
import { useOrganizerCopy } from './copy';

/** The server's own cap (`MAX_ANNOUNCEMENT_CHARS`), mirrored so a doomed write never leaves. */
export const ANNOUNCEMENT_MAX_LENGTH = 500;

interface Posted {
  messageId: string;
  text: string;
}

/**
 * The organiser's notice, written by the backend callable and pinned in the same step
 * (`pinMessage({ eventId, text })`). Nothing here writes Firestore: `pinned` is a permission
 * claim, the security rules refuse it from any client, and the server is the only thing that
 * can check on chain whether this caller may make it.
 *
 * The list below is only what this screen posted in this session. An organiser holds no ticket
 * for their own event, so `joinEventChat` would refuse them the room and there is no read path
 * to the notices already there — a `listPinned` callable comes later. Saying that plainly
 * beats an empty list that looks like the notices were lost.
 */
export function Announce({ eventId }: { eventId: string }) {
  const copy = useOrganizerCopy().announce;
  const [text, setText] = useState('');
  const [posted, setPosted] = useState<Posted[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function post(): Promise<void> {
    const body = text.trim();
    if (body === '' || body.length > ANNOUNCEMENT_MAX_LENGTH) return;
    setBusy(true);
    setError('');
    try {
      const { messageId } = await api.pinMessage({ eventId, text: body });
      setPosted((current) => [{ messageId, text: body }, ...current]);
      setText('');
    } catch (cause) {
      const { code, reason } = callableFailure(cause);
      if (code === 'permission-denied') setError(copy.notAllowed);
      else if (reason === 'CHAT_CLOSED') setError(copy.chatClosed);
      else setError(copy.failed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h2>{copy.title}</h2>
      <Field label={copy.placeholder}>
        <textarea
          rows={3}
          maxLength={ANNOUNCEMENT_MAX_LENGTH}
          value={text}
          disabled={busy}
          placeholder={copy.placeholder}
          onChange={(event) => setText(event.target.value)}
        />
      </Field>
      {text.length >= ANNOUNCEMENT_MAX_LENGTH ? <Alert tone="warn">{copy.tooLong}</Alert> : null}
      {error ? <Alert tone="error">{error}</Alert> : null}
      {busy ? <Alert tone="info">{copy.posting}</Alert> : null}
      <Button disabled={busy || text.trim().length === 0} onClick={() => void post()}>
        {copy.post}
      </Button>

      {posted.length > 0 ? (
        <>
          <h3>{copy.posted}</h3>
          <p style={{ color: 'var(--muted)', fontSize: 13 }}>{copy.sessionOnly}</p>
          <ul style={{ listStyle: 'none', padding: 0 }}>
            {posted.map((notice) => (
              <li key={notice.messageId}>{notice.text}</li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}
