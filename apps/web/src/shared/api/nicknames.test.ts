import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolveNicknamesCall = vi.fn();
vi.mock('./functions', () => ({ api: { resolveNicknames: (req: unknown) => resolveNicknamesCall(req) } }));

const { RESOLVE_NICKNAMES_BATCH, NICKNAME_CACHE_MS, clearNicknameCache, rememberNickname, resolveNicknames } =
  await import('./nicknames');

const ALICE = `0x${'aa'.repeat(20)}`;
const BOB = `0x${'bb'.repeat(20)}`;

beforeEach(() => {
  clearNicknameCache();
  resolveNicknamesCall.mockReset();
  resolveNicknamesCall.mockImplementation(async ({ accounts }: { accounts: string[] }) => ({
    names: Object.fromEntries(accounts.filter((a) => a === ALICE).map((a) => [a, 'alice'])),
  }));
});

describe('resolveNicknames', () => {
  it('asks the callable with lowercase, de-duplicated accounts and keys the answer lowercase', async () => {
    const names = await resolveNicknames([ALICE.toUpperCase().replace('0X', '0x'), ALICE, BOB]);
    expect(resolveNicknamesCall).toHaveBeenCalledTimes(1);
    expect(resolveNicknamesCall).toHaveBeenCalledWith({ accounts: [ALICE, BOB] });
    expect(names).toEqual({ [ALICE]: 'alice' });
  });

  it('answers from the cache the second time — named and nameless accounts alike', async () => {
    await resolveNicknames([ALICE, BOB]);
    const again = await resolveNicknames([BOB, ALICE]);
    expect(again).toEqual({ [ALICE]: 'alice' });
    expect(resolveNicknamesCall).toHaveBeenCalledTimes(1);
  });

  it('asks again once the cached answer is old', async () => {
    vi.useFakeTimers();
    try {
      await resolveNicknames([ALICE]);
      vi.advanceTimersByTime(NICKNAME_CACHE_MS + 1);
      await resolveNicknames([ALICE]);
      expect(resolveNicknamesCall).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it(`splits a long list into calls of at most ${RESOLVE_NICKNAMES_BATCH}`, async () => {
    const many = Array.from({ length: 230 }, (_, i) => `0x${i.toString(16).padStart(40, '0')}`);
    await resolveNicknames(many);
    expect(resolveNicknamesCall).toHaveBeenCalledTimes(3);
    const sizes = resolveNicknamesCall.mock.calls.map(([req]) => (req as { accounts: string[] }).accounts.length);
    expect(sizes).toEqual([100, 100, 30]);
  });

  it('asks nothing for an empty list', async () => {
    expect(await resolveNicknames([])).toEqual({});
    expect(resolveNicknamesCall).not.toHaveBeenCalled();
  });

  it('lets a just-saved name replace what the cache held', async () => {
    await resolveNicknames([BOB]);
    rememberNickname(BOB.toUpperCase().replace('0X', '0x'), 'bob_01');
    expect(await resolveNicknames([BOB])).toEqual({ [BOB]: 'bob_01' });
    expect(resolveNicknamesCall).toHaveBeenCalledTimes(1);
  });
});
