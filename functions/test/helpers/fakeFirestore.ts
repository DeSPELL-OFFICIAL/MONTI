import { FieldValue, Timestamp } from 'firebase-admin/firestore';

/**
 * 에뮬레이터 없이 `pnpm test` 안에서 도는 가짜 Firestore.
 *
 * `accountDeletion.test.ts` 가 파일 안에 들고 있던 것과 같은 모양인데, 여기에는
 * **하위 컬렉션**이 있다 — `eventDrafts/{uid}/drafts/{draftId}` 를 지우는 경로가
 * 그것 없이는 테스트되지 않는다. 문서는 전체 경로를 키로 한 평평한 Map 하나에 산다.
 */

const DELETE = FieldValue.delete();
const SERVER_TIMESTAMP = FieldValue.serverTimestamp();

function isSentinel(value: unknown, sentinel: FieldValue): boolean {
  const candidate = value as FieldValue | undefined;
  return typeof candidate?.isEqual === 'function' && candidate.isEqual(sentinel);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

function deepMerge(target: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    if (isSentinel(value, DELETE)) delete out[key];
    else if (isSentinel(value, SERVER_TIMESTAMP)) out[key] = Timestamp.now();
    else if (isPlainObject(value)) {
      const previous = out[key];
      out[key] = deepMerge(isPlainObject(previous) ? previous : {}, value);
    } else out[key] = value;
  }
  return out;
}

function field(data: Record<string, unknown> | undefined, path: string): unknown {
  return path.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], data);
}

type Filter = [string, string, unknown];

function matches(data: Record<string, unknown>, [name, op, value]: Filter): boolean {
  const actual = field(data, name);
  if (op === '==') return actual === value;
  if (op === '<=') return (actual as number) <= (value as number);
  if (op === '<') return (actual as number) < (value as number);
  if (op === '>=') return (actual as number) >= (value as number);
  if (op === '>') return (actual as number) > (value as number);
  if (op === 'in') return Array.isArray(value) && value.includes(actual);
  throw new Error(`UNSUPPORTED_OP:${op}`);
}

export function createFakeFirestore() {
  const docs = new Map<string, Record<string, unknown>>();

  function write(path: string, data: Record<string, unknown>, options?: { merge?: boolean }): void {
    docs.set(path, deepMerge(options?.merge ? (docs.get(path) ?? {}) : {}, data));
  }

  function snapshot(path: string) {
    const data = docs.get(path);
    return {
      exists: data !== undefined,
      id: path.slice(path.lastIndexOf('/') + 1),
      ref: docRef(path),
      get: (name: string) => field(data, name),
      data: () => data,
    };
  }

  function docRef(path: string) {
    return {
      path,
      id: path.slice(path.lastIndexOf('/') + 1),
      get: async () => snapshot(path),
      set: async (data: Record<string, unknown>, options?: { merge?: boolean }) => write(path, data, options),
      update: async (data: Record<string, unknown>) => {
        if (!docs.has(path)) throw new Error(`NOT_FOUND:${path}`);
        write(path, data, { merge: true });
      },
      delete: async () => {
        docs.delete(path);
      },
      collection: (name: string) => collection(`${path}/${name}`),
    };
  }

  /** 컬렉션에 든 문서는 경로가 한 칸만 더 긴 것들이다 — 손자 문서까지 쓸어 오면 안 된다. */
  function idsIn(prefix: string): string[] {
    return [...docs.keys()].filter(
      (path) => path.startsWith(`${prefix}/`) && !path.slice(prefix.length + 1).includes('/'),
    );
  }

  function comparable(value: unknown): number | string {
    if (value instanceof Timestamp) return value.toMillis();
    return typeof value === 'string' ? value : Number(value ?? 0);
  }

  type Order = { field: string; direction: 'asc' | 'desc' };

  function query(prefix: string, filters: Filter[], max: number, order?: Order) {
    return {
      where: (path: string, op: string, value: unknown) =>
        query(prefix, [...filters, [path, op, value]], max, order),
      orderBy: (path: string, direction: 'asc' | 'desc' = 'asc') =>
        query(prefix, filters, max, { field: path, direction }),
      limit: (n: number) => query(prefix, filters, n, order),
      get: async () => {
        const paths = idsIn(prefix).filter((path) =>
          filters.every((filter) => matches(docs.get(path) as Record<string, unknown>, filter)),
        );
        // 정렬은 자르기 전에 한다 — 진짜 Firestore 와 순서가 달라지면 상한 테스트가 거짓말을 한다.
        if (order) {
          const sign = order.direction === 'desc' ? -1 : 1;
          paths.sort((a, b) => {
            const x = comparable(field(docs.get(a), order.field));
            const y = comparable(field(docs.get(b), order.field));
            return x < y ? -sign : x > y ? sign : 0;
          });
        }
        const matched = paths.slice(0, max).map((path) => snapshot(path));
        return { docs: matched, size: matched.length, empty: matched.length === 0 };
      },
    };
  }

  let autoId = 0;
  function collection(prefix: string) {
    return {
      ...query(prefix, [], Number.POSITIVE_INFINITY),
      // 인자 없는 `.doc()` 은 진짜 SDK 처럼 새 자동 id 를 짓는다.
      doc: (id?: string) => docRef(`${prefix}/${id ?? `auto-${(autoId += 1)}`}`),
    };
  }

  async function runTransaction<T>(
    fn: (tx: {
      get: (ref: { path: string }) => Promise<ReturnType<typeof snapshot>>;
      set: (ref: { path: string }, data: Record<string, unknown>, options?: { merge?: boolean }) => void;
      update: (ref: { path: string }, data: Record<string, unknown>) => void;
      delete: (ref: { path: string }) => void;
    }) => Promise<T>,
  ): Promise<T> {
    const tx = {
      get: async (ref: { path: string }) => snapshot(ref.path),
      set: (ref: { path: string }, data: Record<string, unknown>, options?: { merge?: boolean }) =>
        write(ref.path, data, options),
      update: (ref: { path: string }, data: Record<string, unknown>) => write(ref.path, data, { merge: true }),
      delete: (ref: { path: string }) => {
        docs.delete(ref.path);
      },
    };
    return fn(tx);
  }

  return { docs, db: { collection, runTransaction }, write, snapshot };
}

export type FakeFirestore = ReturnType<typeof createFakeFirestore>;
