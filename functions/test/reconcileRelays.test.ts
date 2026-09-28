import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TransactionReceiptNotFoundError } from 'viem';
import type { Hex } from '@monti/shared';

// 로거는 소음/부작용을 피하려 죽인다. chain 은 통째로 mock 해 config 의 부작용 로드를 끊는다 —
// decideRelay 는 스텁 클라이언트를 인자로 받으므로 publicClient() 자체는 부르지 않는다.
vi.mock('firebase-functions/logger', () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }));
vi.mock('../src/lib/chain.js', () => ({ publicClient: () => ({}) }));

// 가짜 Firestore: 쓰기 경로만 기록한다. admissions 하위 컬렉션까지 체인을 따라간다.
const hoisted = vi.hoisted(() => {
  const writes: Array<{ path: string; data: Record<string, unknown>; merge?: boolean }> = [];
  const makeRef = (path: string): Record<string, unknown> => ({
    set: (data: Record<string, unknown>, opts?: { merge?: boolean }) => {
      writes.push({ path, data, merge: opts?.merge });
      return Promise.resolve();
    },
    collection: (c: string) => ({ doc: (id: string) => makeRef(`${path}/${c}/${id}`) }),
  });
  const db = { collection: (c: string) => ({ doc: (id: string) => makeRef(`${c}/${id}`) }) };
  return { writes, db };
});

vi.mock('../src/lib/db.js', () => ({
  db: hoisted.db,
  RELAYS: 'relays',
  ADMISSIONS: 'admissions',
  ADMISSION_TOKENS: 'tokens',
}));

const { decideRelay, applyRelayDecision } = await import('../src/functions/reconcileRelays.js');

type Pc = Parameters<typeof decideRelay>[1];
type Doc = Parameters<typeof applyRelayDecision>[0];

const HASH = '0xdeadbeef' as Hex;
const NOW = 1_700_000_000_000;
const MIN = 60_000;

function pc(overrides: Record<string, unknown>): Pc {
  return overrides as unknown as Pc;
}

describe('decideRelay — 상태 전이(스텁 클라이언트)', () => {
  it('confirms on a successful receipt', async () => {
    const client = pc({ getTransactionReceipt: vi.fn(async () => ({ status: 'success' })) });
    expect(await decideRelay({ txHash: HASH, sentAtMs: NOW - 3 * MIN, nowMs: NOW }, client)).toEqual({
      kind: 'confirm',
    });
  });

  it('fails with the revert reason when the receipt reverted', async () => {
    const client = pc({
      getTransactionReceipt: async () => ({ status: 'reverted' }),
      getTransaction: async () => ({ to: '0x01', input: '0x', from: '0x02', value: 0n, blockNumber: 5n }),
      call: async () => {
        throw { shortMessage: 'execution reverted: AlreadyCheckedIn' };
      },
    });
    expect(await decideRelay({ txHash: HASH, sentAtMs: NOW - 3 * MIN, nowMs: NOW }, client)).toEqual({
      kind: 'fail',
      error: { code: 'REVERTED', message: 'execution reverted: AlreadyCheckedIn' },
    });
  });

  it('falls back to a generic revert message when the reason is not obtainable', async () => {
    const client = pc({
      getTransactionReceipt: async () => ({ status: 'reverted' }),
      getTransaction: async () => ({ to: '0x01', input: '0x', from: '0x02', value: 0n, blockNumber: 5n }),
      // eth_call 이 되레 성공하면(사유 재현 불가) 일반 문구로 떨어진다.
      call: async () => ({ data: '0x' }),
    });
    expect(await decideRelay({ txHash: HASH, sentAtMs: NOW, nowMs: NOW }, client)).toEqual({
      kind: 'fail',
      error: { code: 'REVERTED', message: 'execution reverted' },
    });
  });

  it('waits while there is no receipt and the 10-minute window has not passed', async () => {
    const client = pc({
      getTransactionReceipt: async () => {
        throw new TransactionReceiptNotFoundError({ hash: HASH });
      },
    });
    expect(await decideRelay({ txHash: HASH, sentAtMs: NOW - 5 * MIN, nowMs: NOW }, client)).toEqual({
      kind: 'wait',
    });
  });

  it('drops the tx as failed after 10 minutes with no receipt', async () => {
    const client = pc({
      getTransactionReceipt: async () => {
        throw new TransactionReceiptNotFoundError({ hash: HASH });
      },
    });
    expect(await decideRelay({ txHash: HASH, sentAtMs: NOW - 11 * MIN, nowMs: NOW }, client)).toEqual({
      kind: 'fail',
      error: { code: 'TX_DROPPED', message: 'no receipt after 10 minutes' },
    });
  });

  it('re-throws a transient RPC error instead of dropping a live tx', async () => {
    const client = pc({
      getTransactionReceipt: async () => {
        throw new Error('HTTP 503 rate limited');
      },
    });
    await expect(
      decideRelay({ txHash: HASH, sentAtMs: NOW - 11 * MIN, nowMs: NOW }, client),
    ).rejects.toThrow('HTTP 503');
  });

  it('drops a sent relay that never recorded a tx hash, without an RPC call', async () => {
    const getTransactionReceipt = vi.fn();
    const client = pc({ getTransactionReceipt });
    expect(await decideRelay({ sentAtMs: NOW - 11 * MIN, nowMs: NOW }, client)).toEqual({
      kind: 'fail',
      error: { code: 'TX_DROPPED', message: 'sent without a tx hash' },
    });
    expect(getTransactionReceipt).not.toHaveBeenCalled();
  });
});

describe('applyRelayDecision — Firestore 효과 + 대기 테이블 연동', () => {
  beforeEach(() => {
    hoisted.writes.length = 0;
  });

  function fakeDoc(fields: Record<string, unknown>) {
    const refWrites: Array<{ data: Record<string, unknown>; merge?: boolean }> = [];
    const doc = {
      id: 'relay-1',
      get: (k: string) => fields[k],
      ref: {
        set: (data: Record<string, unknown>, opts?: { merge?: boolean }) => {
          refWrites.push({ data, merge: opts?.merge });
          return Promise.resolve();
        },
      },
      refWrites,
    };
    return doc;
  }

  it('confirms a check-in and flips its admission to confirmed', async () => {
    const doc = fakeDoc({ kind: 'checkIn', eventId: '7', tokenId: '42' });
    await applyRelayDecision(doc as unknown as Doc, { kind: 'confirm' });
    expect(doc.refWrites[0]).toMatchObject({ merge: true });
    expect(doc.refWrites[0]?.data.status).toBe('confirmed');
    const adm = hoisted.writes.find((w) => w.path === 'admissions/7/tokens/42');
    expect(adm).toMatchObject({ merge: true });
    expect(adm?.data.status).toBe('confirmed');
  });

  it('fails a late check-in, records the error, and flips its admission to failed', async () => {
    const doc = fakeDoc({ kind: 'checkInLate', eventId: '7', tokenId: '42' });
    const error = { code: 'REVERTED', message: 'AlreadyCheckedIn' };
    await applyRelayDecision(doc as unknown as Doc, { kind: 'fail', error });
    expect(doc.refWrites[0]?.data.status).toBe('failed');
    expect(doc.refWrites[0]?.data.error).toEqual(error);
    const adm = hoisted.writes.find((w) => w.path === 'admissions/7/tokens/42');
    expect(adm?.data.status).toBe('failed');
  });

  it('confirms a claim without touching any admission', async () => {
    const doc = fakeDoc({ kind: 'claim', eventId: '7' });
    await applyRelayDecision(doc as unknown as Doc, { kind: 'confirm' });
    expect(doc.refWrites[0]?.data.status).toBe('confirmed');
    expect(hoisted.writes).toHaveLength(0);
  });

  it('writes nothing on a wait decision', async () => {
    const doc = fakeDoc({ kind: 'checkIn', eventId: '7', tokenId: '42' });
    await applyRelayDecision(doc as unknown as Doc, { kind: 'wait' });
    expect(doc.refWrites).toHaveLength(0);
    expect(hoisted.writes).toHaveLength(0);
  });
});
