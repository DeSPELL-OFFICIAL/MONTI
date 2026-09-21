import { useEffect, useState } from 'react';
import { loadChatMembers } from '../../shared/api/firestore';
import { gql } from '../../shared/envio/client';

/**
 * `Identity.nicknameOf` answers with `keccak256(nickname)` and never the name itself, so the
 * index is the only place a plaintext nickname exists — the same source the gate snapshot reads
 * (functions/src/functions/snapshot.ts). The chat rules keep the account off the message row
 * (`uid`, `text`, `createdAt`, `reported` and nothing else), and `users/{uid}` is readable by
 * that one user, so a name takes two steps: uid to account from the room's roster, account to
 * nickname from the index.
 */
const CHAT_NICKNAMES_QUERY = `
  query ChatNicknames($accounts: [String!]!) {
    IdentityAccount(where: { id: { _in: $accounts } }) { id nickname }
  }`;

interface ChatNicknamesResult {
  IdentityAccount: Array<{ id: string; nickname: string | null }>;
}

/**
 * uid to display name for one room. Only names, never the uid and never a phone number: a
 * sender the index has no nickname for is simply absent here, and the room calls them 참석자.
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
        // The index keys accounts lowercase; Firestore holds them as the chain wrote them.
        const accounts = [...new Set(members.map((member) => member.account.toLowerCase()))];
        const result = await gql<ChatNicknamesResult>(CHAT_NICKNAMES_QUERY, { accounts });
        if (cancelled) return;
        const byAccount = new Map(
          result.IdentityAccount.filter((row) => row.nickname).map(
            (row) => [row.id.toLowerCase(), row.nickname as string] as const,
          ),
        );
        const next: Record<string, string> = {};
        for (const member of members) {
          const nickname = byAccount.get(member.account.toLowerCase());
          if (nickname) next[member.uid] = nickname;
        }
        setNames(next);
      } catch {
        // A name is a courtesy. A refused roster or a sleeping index must not take the room down.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [eventId, enabled]);

  return names;
}
