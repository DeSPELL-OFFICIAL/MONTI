import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Hex } from 'viem';
import type { SubmittedOp, SubmittedOpState } from '../../shared/chain/ops';
import {
  clearClaimDraft, guardClaim, readClaimDraft, writeClaimDraft, type ClaimDraft,
} from './claimDraft';

const HASH = `0x${'ab'.repeat(32)}` as Hex;

function draft(over: Partial<ClaimDraft> = {}): ClaimDraft {
  return { fn: 'claim', tier: 0, opHash: HASH, submittedAt: 1_000, ...over };
}

/** A resolver that always answers with the given state, and records that it was asked. */
function resolver(state: SubmittedOpState) {
  return vi.fn(async (): Promise<SubmittedOp> => ({ state, logs: [] }));
}

afterEach(() => {
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe('claim draft (sessionStorage)', () => {
  it('round-trips a draft per event id', () => {
    writeClaimDraft('5', draft({ tier: 2 }));
    writeClaimDraft('9', draft({ fn: 'requestClaim' }));
    expect(readClaimDraft('5')).toEqual(draft({ tier: 2 }));
    expect(readClaimDraft('9')).toEqual(draft({ fn: 'requestClaim' }));
    expect(readClaimDraft('nope')).toBeNull();
  });

  it('reads nothing back once the draft is cleared', () => {
    writeClaimDraft('5', draft());
    clearClaimDraft('5');
    expect(readClaimDraft('5')).toBeNull();
  });

  it('treats a draft with no usable hash as none', () => {
    writeClaimDraft('5', draft({ opHash: '' as Hex }));
    expect(readClaimDraft('5')).toBeNull();
  });
});

describe('guardClaim — the duplicate-safe gate', () => {
  it('sends when there is nothing recorded, and never asks the bundler', async () => {
    const resolve = resolver('landed');
    expect(await guardClaim(null, resolve)).toBe('send');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('re-checks a recorded op instead of blind-resending, and completes when it landed', async () => {
    const resolve = resolver('landed');
    expect(await guardClaim(draft(), resolve)).toBe('complete');
    // The double-issuance guard: a hash on file is always resolved, with its own submittedAt.
    expect(resolve).toHaveBeenCalledWith(HASH, 1_000);
  });

  it('waits, sending nothing, while a recorded op is still pending', async () => {
    const resolve = resolver('pending');
    expect(await guardClaim(draft(), resolve)).toBe('wait');
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('resends a recorded op that failed or went stale, with current fees', async () => {
    expect(await guardClaim(draft(), resolver('failed'))).toBe('send');
    expect(await guardClaim(draft(), resolver('stale'))).toBe('send');
  });

  it('treats a bundler it cannot reach as pending — never a second claim', async () => {
    const resolve = vi.fn(async (): Promise<SubmittedOp> => {
      throw new Error('bundler unreachable');
    });
    expect(await guardClaim(draft(), resolve)).toBe('wait');
  });
});
