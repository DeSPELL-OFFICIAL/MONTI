import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { encodeErrorResult, keccak256, toBytes } from 'viem';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { identityAbi } from '../../shared/chain/abis';

const ZERO = `0x${'00'.repeat(20)}`;
const MINE = `0x${'ab'.repeat(20)}`;
const SOMEBODY_ELSE = `0x${'cc'.repeat(20)}`;

// The chain owns uniqueness; this screen only asks it first. Every case below is a different
// answer to that one question, or a different way the send can still come back refused.
const nicknameOwner = vi.fn(async () => SOMEBODY_ELSE as string);
vi.mock('../../shared/chain/reads', () => ({ readIdentity: () => ({ nicknameOwner }) }));

const identityOp = vi.fn(async () => ({ success: true, txHash: '0x2', blockNumber: 1n }));
vi.mock('../../shared/chain/ops', () => ({ identityOp }));
vi.mock('../../shared/chain/accounts', () => ({ getAttendeeAccount: async () => ({ address: MINE }) }));

const saveUserProfile = vi.fn(async () => undefined);
vi.mock('../../shared/api/firestore', () => ({ saveUserProfile }));

const { Nickname, normalizeNickname } = await import('./Nickname');

/** What `OpReverted` carries when the contract named one of its own errors. */
function reverted(errorName: string) {
  return { revertReason: encodeErrorResult({ abi: identityAbi, errorName }) };
}

beforeEach(() => {
  nicknameOwner.mockResolvedValue(SOMEBODY_ELSE);
  identityOp.mockResolvedValue({ success: true, txHash: '0x2', blockNumber: 1n });
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

  it('blocks a taken nickname before sending anything', async () => {
    await type('taken_name');
    expect(await screen.findByText('이미 쓰는 별명이에요.')).toBeInTheDocument();
    expect(identityOp).not.toHaveBeenCalled();
  });

  it('says what is wrong with the letters without asking the chain', async () => {
    await type('ab');
    expect(await screen.findByText('영문 소문자, 숫자, 밑줄만 3~20자로 써 주세요.')).toBeInTheDocument();
    expect(nicknameOwner).not.toHaveBeenCalled();
    expect(identityOp).not.toHaveBeenCalled();
  });

  it('sends setNickname with the keccak hash of the name it displays', async () => {
    nicknameOwner.mockResolvedValue(ZERO);
    await type('alex_01');
    expect(await screen.findByText('별명을 저장했어요')).toBeInTheDocument();
    // The name that was normalised is the name that is sent, and the hash goes with it.
    const sent = identityOp.mock.calls.at(0)?.at(0) as unknown as { functionName: string; args: unknown[] };
    expect(sent.functionName).toBe('setNickname');
    expect(sent.args[1]).toBe('alex_01');
    expect(sent.args[0]).toBe(keccak256(toBytes('alex_01')));
    expect(saveUserProfile).toHaveBeenCalledWith({ nickname: 'alex_01' });
  });

  it('treats a name this account already owns as saved, and sends nothing', async () => {
    nicknameOwner.mockResolvedValue(MINE);
    await type('alex_01');
    expect(await screen.findByText('이미 쓰고 있는 별명이에요')).toBeInTheDocument();
    expect(identityOp).not.toHaveBeenCalled();
  });

  it('names the rule the chain refused on, not one sentence for every revert', async () => {
    nicknameOwner.mockResolvedValue(ZERO);
    identityOp.mockRejectedValueOnce(reverted('NicknameTaken'));
    await type('alex_01');
    expect(await screen.findByText('이미 쓰는 별명이에요.')).toBeInTheDocument();

    identityOp.mockRejectedValueOnce(reverted('NotRegistered'));
    await type('alex_02');
    expect(await screen.findByText('가입을 먼저 마쳐 주세요.')).toBeInTheDocument();
  });

  it('falls back to the generic sentence for a revert nobody here can act on', async () => {
    nicknameOwner.mockResolvedValue(ZERO);
    identityOp.mockRejectedValueOnce(reverted('NicknameHashMismatch'));
    await type('alex_01');
    expect(await screen.findByText('문제가 생겼어요. 잠시 뒤 다시 시도해 주세요.')).toBeInTheDocument();
  });
});
