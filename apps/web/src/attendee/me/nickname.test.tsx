import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const MINE = `0x${'ab'.repeat(20)}`;

// The server owns uniqueness now (P5): one callable, no chain write, no relay.
const setNickname = vi.fn();
vi.mock('../../shared/api/functions', () => ({ api: { setNickname: (req: unknown) => setNickname(req) } }));

const rememberNickname = vi.fn();
vi.mock('../../shared/api/nicknames', () => ({ rememberNickname: (a: string, n: string) => rememberNickname(a, n) }));
vi.mock('../../shared/chain/accounts', () => ({ getAttendeeAccount: async () => ({ address: MINE }) }));

const { Nickname, normalizeNickname } = await import('./Nickname');

/** What the callable rejects with: the refusal name in details.code. */
function refused(code: string) {
  return { code: 'failed-precondition', details: { code } };
}

beforeEach(() => {
  setNickname.mockReset();
  setNickname.mockImplementation(async ({ nickname }: { nickname: string }) => ({ nickname }));
  rememberNickname.mockReset();
});

/** A fresh screen each time: two of these in one test would give `getByRole` two textboxes. */
async function type(value: string) {
  cleanup();
  render(<Nickname />);
  await userEvent.type(screen.getByRole('textbox'), value);
  await userEvent.click(screen.getByRole('button', { name: '저장' }));
}

describe('Nickname', () => {
  it('normalises input and rejects anything outside [a-z0-9_]{3,20}', () => {
    expect(normalizeNickname('  Alex_01 ')).toBe('alex_01');
    expect(normalizeNickname('ab')).toBeNull();
    expect(normalizeNickname('a'.repeat(21))).toBeNull();
    expect(normalizeNickname('김철수')).toBeNull();
    expect(normalizeNickname('alex-01')).toBeNull();
  });

  it('says what is wrong with the letters without asking the server', async () => {
    await type('ab');
    expect(await screen.findByText('영문 소문자, 숫자, 밑줄만 3~20자로 써 주세요.')).toBeInTheDocument();
    expect(setNickname).not.toHaveBeenCalled();
  });

  it('saves the normalised name through setNickname and remembers it for this device', async () => {
    await type('Alex_01');
    expect(await screen.findByText('별명을 저장했어요')).toBeInTheDocument();
    expect(setNickname).toHaveBeenCalledWith({ nickname: 'alex_01' });
    // The name the server stored is the one this device shows from now on.
    expect(rememberNickname).toHaveBeenCalledWith(MINE, 'alex_01');
  });

  it('names the rule the server refused on', async () => {
    setNickname.mockRejectedValueOnce(refused('NICKNAME_TAKEN'));
    await type('alex_01');
    expect(await screen.findByText('이미 쓰는 별명이에요.')).toBeInTheDocument();

    setNickname.mockRejectedValueOnce(refused('NICKNAME_INVALID'));
    await type('alex_02');
    expect(await screen.findByText('영문 소문자, 숫자, 밑줄만 3~20자로 써 주세요.')).toBeInTheDocument();

    setNickname.mockRejectedValueOnce(refused('NO_PERSON'));
    await type('alex_03');
    expect(await screen.findByText('가입을 먼저 마쳐 주세요.')).toBeInTheDocument();
  });

  it('falls back to the generic sentence for anything else', async () => {
    setNickname.mockRejectedValueOnce(new Error('offline'));
    await type('alex_01');
    expect(await screen.findByText('문제가 생겼어요. 잠시 뒤 다시 시도해 주세요.')).toBeInTheDocument();
  });
});
