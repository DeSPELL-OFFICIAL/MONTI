import { useEffect, useState } from 'react';
import { Alert, Button, Field } from '../shared/ui';
import { api, callableFailure, type PinnedMessage } from '../shared/api/functions';
import { useOrganizerCopy } from './copy';

/** The server's own cap (`MAX_ANNOUNCEMENT_CHARS`), mirrored so a doomed write never leaves. */
export const ANNOUNCEMENT_MAX_LENGTH = 500;

/**
 * Lays `top` over `rest` without ever listing the same notice twice.
 *
 * A notice reaches this screen from two directions — prepended the moment `pinMessage` answers,
 * and again inside the next `listPinned` page — and `messageId` is the one field both carry, so
 * it is what identity is decided on. `top` wins the tie: the row is already on screen, and
 * replacing it with an identical one would only make the list flicker. Neither side is sorted
 * here, because both already arrive newest first.
 */
function merge(top: PinnedMessage[], rest: PinnedMessage[]): PinnedMessage[] {
  const seen = new Set(top.map((notice) => notice.messageId));
  return [...top, ...rest.filter((notice) => !seen.has(notice.messageId))];
}

/**
 * The organiser's notice, written by the backend callable and pinned in the same step
 * (`pinMessage({ eventId, text })`). Nothing here writes Firestore: `pinned` is a permission
 * claim, the security rules refuse it from any client, and the server is the only thing that
 * can check on chain whether this caller may make it.
 *
 * Reading is the same story told backwards. An organiser holds no ticket for their own event,
 * so `joinEventChat` refuses them the room and the rules refuse them its messages; `listPinned`
 * is the single read path they have, authorised by the same chain read as the write. So the
 * list below is the server's, newest first, with whatever this session just posted held above
 * it — a notice has to be visible the instant it is accepted, not one refetch later.
 *
 * A load that fails says so on a line of its own and changes nothing else: it is not a post
 * error, the composer stays usable, and the rows already prepended stay where they are. What
 * was lost is the history, not the proof that this organiser's own notice went through.
 */
export function Announce({ eventId }: { eventId: string }) {
  const copy = useOrganizerCopy().announce;
  const [text, setText] = useState('');
  const [notices, setNotices] = useState<PinnedMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (eventId === '') return undefined;
    let cancelled = false;

    void (async () => {
      setLoading(true);
      setLoadFailed(false);
      const rows = await api.listPinned({ eventId }).catch(() => null);
      if (cancelled) return;
      // Anything posted while this was in flight keeps the top of the list it was put at.
      if (rows !== null) setNotices((current) => merge(current, rows));
      setLoadFailed(rows === null);
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [eventId]);

  async function post(): Promise<void> {
    const body = text.trim();
    if (body === '' || body.length > ANNOUNCEMENT_MAX_LENGTH) return;
    setBusy(true);
    setError('');
    try {
      const { messageId } = await api.pinMessage({ eventId, text: body });
      // The server stamps the real `createdAt`; this guess from the browser's clock only has to
      // carry the row until a later load hands the same `messageId` back with the true second.
      const notice = { messageId, text: body, createdAt: Math.floor(Date.now() / 1000) };
      setNotices((current) => merge([notice], current));
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

      <h3>{copy.posted}</h3>
      {loading ? <Alert tone="info">{copy.loading}</Alert> : null}
      {loadFailed ? <Alert tone="warn">{copy.loadFailed}</Alert> : null}
      {/* Only a list that is genuinely empty says so — a failed load already said its piece. */}
      {!loading && !loadFailed && notices.length === 0 ? (
        <p style={{ color: 'var(--muted)', fontSize: 13 }}>{copy.none}</p>
      ) : null}
      <ul style={{ listStyle: 'none', padding: 0 }}>
        {notices.map((notice) => (
          <li key={notice.messageId}>{notice.text}</li>
        ))}
      </ul>
    </section>
  );
}
