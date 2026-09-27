import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.GCP_PROJECT_ID = 'monti-dev';

/**
 * 리스 문서 하나(`system/attester`)와 트랜잭션만 흉내 내는 가짜 Firestore.
 * registerIdentity.test.ts 와 같은 패턴이고, 여기서는 리스가 잡혀 있을 때 곧바로 429 를
 * 던지지 않고 **풀릴 때까지 기다리는** 새 동작만 본다.
 */
const docs = new Map<string, Record<string, unknown>>();

function snapshot(path: string) {
  const data = docs.get(path);
  return {
    exists: data !== undefined,
    get: (key: string) => data?.[key],
    data: () => data,
  };
}

function write(path: string, data: Record<string, unknown>, options?: { merge?: boolean }): void {
  const previous = options?.merge ? (docs.get(path) ?? {}) : {};
  docs.set(path, { ...previous, ...data });
}

function docRef(path: string) {
  return {
    path,
    get: async () => snapshot(path),
    set: async (data: Record<string, unknown>, options?: { merge?: boolean }) => {
      write(path, data, options);
    },
  };
}

vi.mock('../src/lib/db.js', () => ({
  SYSTEM: 'system',
  db: {
    collection: (name: string) => ({ doc: (id: string) => docRef(`${name}/${id}`) }),
    runTransaction: async <T>(body: (tx: unknown) => Promise<T>): Promise<T> => {
      const pending: Array<() => void> = [];
      const tx = {
        get: async (ref: { path: string }) => snapshot(ref.path),
        set: (ref: { path: string }, data: Record<string, unknown>, options?: { merge?: boolean }) => {
          pending.push(() => write(ref.path, data, options));
        },
      };
      const result = await body(tx);
      for (const apply of pending) apply();
      return result;
    },
  },
}));

vi.mock('firebase-functions/logger', () => ({
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  log: vi.fn(),
  debug: vi.fn(),
}));

const { withAttesterLease } = await import('../src/lib/attesterLock.js');
const { warn } = await import('firebase-functions/logger');

beforeEach(() => {
  docs.clear();
  vi.mocked(warn).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('withAttesterLease — waits for the lease instead of failing fast', () => {
  it('acquires a free lease immediately, runs, and gives it back', async () => {
    const run = vi.fn(async () => 'done');
    await expect(withAttesterLease(run)).resolves.toBe('done');
    expect(run).toHaveBeenCalledTimes(1);
    // 반납된 리스는 lockedUntil 0, holder null 이다(다음 호출이 곧바로 가져간다).
    expect(snapshot('system/attester').get('lockedUntil')).toBe(0);
    expect(snapshot('system/attester').get('holder')).toBeNull();
    expect(vi.mocked(warn)).not.toHaveBeenCalled();
  });

  it('waits for a held lease and SUCCEEDS when it frees within the cap (released after 2s)', async () => {
    vi.useFakeTimers();
    // 다른 트랜잭션이 리스를 들고 있다.
    write('system/attester', { holder: 'other', lockedUntil: Date.now() + 60_000 });
    // 2초 뒤에 놓는다 — 캡(~12s) 안이다.
    setTimeout(() => write('system/attester', { holder: null, lockedUntil: 0 }), 2_000);

    const run = vi.fn(async () => 'sent');
    const promise = withAttesterLease(run);
    // 폴링·반납 마이크로태스크까지 흘려보낸다.
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(promise).resolves.toBe('sent');
    // 두 번째 호출자는 429 를 받지 않고 끝내 트랜잭션을 보냈다.
    expect(run).toHaveBeenCalledTimes(1);
    expect(vi.mocked(warn)).not.toHaveBeenCalled();
    // 잡았다가 반납했다.
    expect(snapshot('system/attester').get('lockedUntil')).toBe(0);
  });

  it('throws 429 ATTESTER_BUSY after the ~12s cap when the lease never frees, and logs a warn', async () => {
    vi.useFakeTimers();
    // 캡을 넘겨 절대 풀리지 않는 리스.
    write('system/attester', { holder: 'other', lockedUntil: Date.now() + 60_000 });

    const run = vi.fn(async () => 'sent');
    const promise = withAttesterLease(run);
    // 타이머를 흘리는 동안 unhandled rejection 으로 잡히지 않게 미리 핸들러를 단다.
    promise.catch(() => {});
    await vi.advanceTimersByTimeAsync(13_000);

    await expect(promise).rejects.toThrow('ATTESTER_BUSY');
    // 트랜잭션은 한 번도 나가지 않았고, 캡을 넘긴 사실이 로그에 남는다.
    expect(run).not.toHaveBeenCalled();
    expect(vi.mocked(warn)).toHaveBeenCalledWith('attester.lease.timeout', expect.anything());
    // 남의 리스는 건드리지 않는다.
    expect(snapshot('system/attester').get('holder')).toBe('other');
  });
});
