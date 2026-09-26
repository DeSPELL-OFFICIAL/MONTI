import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const loadChatMembers = vi.fn();
vi.mock('../../shared/api/firestore', () => ({ loadChatMembers: (id: string) => loadChatMembers(id) }));

const gql = vi.fn();
vi.mock('../../shared/envio/client', () => ({ gql: (...args: unknown[]) => gql(...args) }));

const { senderName, useChatNames } = await import('./useChatNames');

const ALICE = `0x${'aa'.repeat(20)}`;
const BOB = `0x${'bb'.repeat(20)}`;

beforeEach(() => {
  loadChatMembers.mockResolvedValue([
    { uid: 'u1', account: ALICE.toUpperCase() },
    { uid: 'u2', account: BOB },
  ]);
  gql.mockResolvedValue({ IdentityAccount: [{ id: ALICE, nickname: 'alice' }, { id: BOB, nickname: null }] });
});

describe('useChatNames', () => {
  it('maps a uid to the nickname the index holds for its account', async () => {
    const { result } = renderHook(() => useChatNames('5', true));
    await waitFor(() => expect(result.current).toEqual({ u1: 'alice' }));
    expect(gql).toHaveBeenCalledWith(expect.stringContaining('IdentityAccount'), {
      accounts: [ALICE, BOB],
    });
  });

  it('asks nothing until the room has been joined', () => {
    renderHook(() => useChatNames('5', false));
    expect(loadChatMembers).not.toHaveBeenCalled();
    expect(gql).not.toHaveBeenCalled();
  });

  it('answers with no names rather than failing when either lookup is refused', async () => {
    loadChatMembers.mockRejectedValue(new Error('permission-denied'));
    const { result } = renderHook(() => useChatNames('5', true));
    await waitFor(() => expect(loadChatMembers).toHaveBeenCalled());
    expect(result.current).toEqual({});
  });
});

describe('senderName', () => {
  const copy = { organizer: '주최자', someone: '참석자' };

  /**
   * An organiser is not a member of their own event's room, so the roster can never name them.
   * A pinned row is theirs by definition — the callable is the only thing that can set `pinned`.
   */
  it('labels a pinned row the organiser rather than looking for a roster name', () => {
    expect(senderName({ uid: 'u1', pinned: true }, { u1: 'alice' }, copy)).toBe('주최자');
  });

  it('uses the roster name for an ordinary row', () => {
    expect(senderName({ uid: 'u1', pinned: false }, { u1: 'alice' }, copy)).toBe('alice');
    expect(senderName({ uid: 'u1' }, { u1: 'alice' }, copy)).toBe('alice');
  });

  it('falls back to 참석자 for a sender the index has no nickname for', () => {
    expect(senderName({ uid: 'u2' }, { u1: 'alice' }, copy)).toBe('참석자');
  });
});
