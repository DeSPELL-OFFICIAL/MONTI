import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const loadChatMembers = vi.fn();
vi.mock('../../shared/api/firestore', () => ({ loadChatMembers: (id: string) => loadChatMembers(id) }));

const resolveNicknames = vi.fn();
vi.mock('../../shared/api/nicknames', () => ({ resolveNicknames: (accounts: string[]) => resolveNicknames(accounts) }));

const { senderName, useChatNames } = await import('./useChatNames');

const ALICE = `0x${'aa'.repeat(20)}`;
const BOB = `0x${'bb'.repeat(20)}`;

beforeEach(() => {
  loadChatMembers.mockResolvedValue([
    { uid: 'u1', account: ALICE.toUpperCase().replace('0X', '0x') },
    { uid: 'u2', account: BOB },
  ]);
  resolveNicknames.mockReset();
  resolveNicknames.mockResolvedValue({ [ALICE]: 'alice' });
});

describe('useChatNames', () => {
  it('maps a uid to the server-held nickname of its account', async () => {
    const { result } = renderHook(() => useChatNames('5', true));
    await waitFor(() => expect(result.current).toEqual({ u1: 'alice' }));
    expect(resolveNicknames).toHaveBeenCalledWith([ALICE, BOB]);
  });

  it('asks nothing until the room has been joined', () => {
    renderHook(() => useChatNames('5', false));
    expect(loadChatMembers).not.toHaveBeenCalled();
    expect(resolveNicknames).not.toHaveBeenCalled();
  });

  it('answers with no names rather than failing when the name lookup is refused', async () => {
    resolveNicknames.mockRejectedValue(new Error('unavailable'));
    const { result } = renderHook(() => useChatNames('5', true));
    await waitFor(() => expect(resolveNicknames).toHaveBeenCalled());
    expect(result.current).toEqual({});
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
