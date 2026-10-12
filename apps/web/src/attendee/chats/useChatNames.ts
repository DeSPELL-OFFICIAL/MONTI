import { useEffect, useState } from 'react';
import { loadChatMembers } from '../../shared/api/firestore';
import { resolveNicknames } from '../../shared/api/nicknames';

/**
 * uid to display name for one room. Nicknames are held by the server (`resolveNicknames`, cached
 * in `shared/api/nicknames.ts`). The chat rules keep the account off the message row (`uid`,
 * `text`, `createdAt`, `reported` and nothing else), and `users/{uid}` is readable by that one
 * user, so a name takes two steps: uid to account from the room's roster, account to nickname.
 * Only names, never the uid and never a phone number: a sender without a nickname is simply
 * absent here, and the room calls them 참석자.
 *
 * `enabled` is the join: the roster is members-only, so asking before `joinEventChat` has
 * answered is a guaranteed `permission-denied`.
 */
export function useChatNames(eventId: string, enabled: boolean): Record<string, string> {
  const [names, setNames] = useState<Record<string, string>>({});

  useEffect(() => {
    // A name from the previous room must never key a uid in this one.
    setNames({});
    if (!enabled || !eventId) return undefined;
    let cancelled = false;

    void (async () => {
      try {
        const members = await loadChatMembers(eventId);
        if (cancelled || members.length === 0) return;
        // Names are keyed lowercase; Firestore holds accounts as the chain wrote them.
        const accounts = [...new Set(members.map((member) => member.account.toLowerCase()))];
        const byAccount = await resolveNicknames(accounts);
        if (cancelled) return;
        const next: Record<string, string> = {};
        for (const member of members) {
          const nickname = byAccount[member.account.toLowerCase()];
          if (nickname) next[member.uid] = nickname;
        }
        setNames(next);
      } catch {
        // A name is a courtesy. A refused roster or an unreachable server must not take the room down.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [eventId, enabled]);

  return names;
}

/**
 * The name one row is shown under.
 *
 * A pinned row is an organiser's notice: the `pinMessage` callable wrote it server-side under
 * the organiser's own uid, and an organiser holds no ticket for their own event, so they are
 * never in the room's roster and `names` can never have a name for them. Falling through to
 * the roster would label every announcement 참석자, as if somebody in the room had posted it.
 */
export function senderName(
  message: { uid: string; pinned?: boolean },
  names: Record<string, string>,
  copy: { organizer: string; someone: string },
): string {
  if (message.pinned === true) return copy.organizer;
  return names[message.uid] ?? copy.someone;
}
