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

  function query(prefix: string, filters: Filter[], max: number) {
    return {
      where: (path: string, op: string, value: unknown) => query(prefix, [...filters, [path, op, value]], max),
      limit: (n: number) => query(prefix, filters, n),
      get: async () => {
        const matched = idsIn(prefix)
          .filter((path) => filters.every((filter) => matches(docs.get(path) as Record<string, unknown>, filter)))
          .slice(0, max)
          .map((path) => snapshot(path));
        return { docs: matched, size: matched.length, empty: matched.length === 0 };
      },
    };
  }

  function collection(prefix: string) {
    return { ...query(prefix, [], Number.POSITIVE_INFINITY), doc: (id: string) => docRef(`${prefix}/${id}`) };
  }

  return { docs, db: { collection }, write, snapshot };
}

export type FakeFirestore = ReturnType<typeof createFakeFirestore>;
