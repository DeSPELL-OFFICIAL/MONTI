import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Alert, Button, Field, Screen } from '../../shared/ui';
import { useCopy } from '../../shared/i18n';
import {
  CHAT_MESSAGE_MAX_LENGTH,
  sendChatMessage,
  watchChatMessages,
  watchChatRoom,
  type ChatMessage,
  type ChatRoomState,
} from '../../shared/api/firestore';
import { api, callableFailure } from '../../shared/api/functions';
import { useChatNames } from './useChatNames';

/** What kept this person out of the room, if anything. '' is the ordinary open room. */
type Blocker = '' | 'noTicket' | 'failed';

/** `joinEventChat`'s two ways of saying the same thing: the room is over. */
const ENDED_REASONS: ReadonlySet<string> = new Set(['CHAT_CLOSED', 'EVENT_ENDED']);

export function ChatRoom() {
  const copy = useCopy();
  const { eventId = '' } = useParams();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [room, setRoom] = useState<ChatRoomState>({ closed: false, endsAt: 0 });
  const [joined, setJoined] = useState(false);
  const [blocked, setBlocked] = useState<Blocker>('');
  const [draft, setDraft] = useState('');
  const [reported, setReported] = useState<ReadonlySet<string>>(new Set());
  const names = useChatNames(eventId, joined);

  useEffect(() => {
    if (eventId === '') return undefined;
    let cancelled = false;
    let stopMessages = (): void => undefined;
    let stopRoom = (): void => undefined;

    /**
     * A listener that is refused is a listener Firestore has already detached, and the only
     * thing that can grant it is the membership `joinEventChat` writes. So it reads as the same
     * sentence as a refused join, never as a crash.
     */
    function onSubscribeError(error: unknown): void {
      if (callableFailure(error).code === 'permission-denied') setBlocked('noTicket');
      else setBlocked('failed');
    }

    // Join first, subscribe second: the rules open `messages` to members only, and membership
    // is exactly what this call writes (it is idempotent, so re-entering a room is free).
    void api
      .joinEventChat({ eventId })
      .then(() => {
        if (cancelled) return;
        setJoined(true);
        stopMessages = watchChatMessages(eventId, setMessages, onSubscribeError);
        stopRoom = watchChatRoom(eventId, setRoom, onSubscribeError);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const { code, reason } = callableFailure(error);
        // The room closing is not a failure — it is the room's last state, and it has its own
        // sentence. Subscribing after it would only be refused anyway.
        if (ENDED_REASONS.has(reason)) setRoom((current) => ({ ...current, closed: true }));
        else if (code === 'permission-denied') setBlocked('noTicket');
        else setBlocked('failed');
      });

    return () => {
      cancelled = true;
      stopMessages();
      stopRoom();
    };
  }, [eventId]);

  const locked = room.closed || blocked !== '';
  const notices = messages.filter((message) => message.pinned);
  const said = messages.filter((message) => !message.pinned);

  /** The marker is this device's own note, put up before the server answers and taken back down
   *  if it refuses — the row's `reported` counter is everybody's total, not "I reported this". */
  async function report(msgId: string): Promise<void> {
    setReported((current) => new Set(current).add(msgId));
    try {
      await api.reportMessage({ eventId, msgId });
    } catch {
      setReported((current) => {
        const next = new Set(current);
        next.delete(msgId);
        return next;
      });
    }
  }

  async function send(): Promise<void> {
    const text = draft.trim();
    if (text === '') return;
    setDraft('');
    try {
      await sendChatMessage(eventId, text);
    } catch {
      setDraft(text);
    }
  }

  return (
    <Screen title={copy.chats.title}>
      {room.closed ? <Alert tone="warn">{copy.chats.closed}</Alert> : null}
      {blocked === 'noTicket' ? <Alert tone="error">{copy.chats.noTicket}</Alert> : null}
      {blocked === 'failed' ? <Alert tone="error">{copy.chats.joinFailed}</Alert> : null}

      {/* An announcement is a row the organiser pinned. This screen only ever reads `pinned`. */}
      {notices.map((notice) => (
        <Alert key={notice.id} tone="info">
          {copy.chats.notice} · {notice.text}
        </Alert>
      ))}

      <ul className="event-list" style={{ listStyle: 'none', padding: 0 }}>
        {said.map((message) => (
          <li key={message.id} style={{ marginBottom: 8 }}>
            <span className="muted">{names[message.uid] ?? copy.chats.someone}</span>{' '}
            <span>{message.text}</span>{' '}
            {reported.has(message.id) ? (
              <span className="muted">{copy.chats.reported}</span>
            ) : (
              <button type="button" onClick={() => void report(message.id)}>
                {copy.chats.report}
              </button>
            )}
          </li>
        ))}
      </ul>

      <Field label={copy.chats.placeholder}>
        <textarea
          rows={2}
          maxLength={CHAT_MESSAGE_MAX_LENGTH}
          value={draft}
          disabled={locked}
          placeholder={copy.chats.placeholder}
          onChange={(event) => setDraft(event.target.value)}
        />
      </Field>
      {draft.length >= CHAT_MESSAGE_MAX_LENGTH ? <Alert tone="warn">{copy.chats.tooLong}</Alert> : null}
      <Button disabled={locked || draft.trim().length === 0} onClick={() => void send()}>
        {copy.chats.send}
      </Button>
    </Screen>
  );
}
