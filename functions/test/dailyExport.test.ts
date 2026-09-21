import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FIREBASE_REGION } from '@monti/shared';
import type { CloudEvent, CloudFunction } from 'firebase-functions/v2';

process.env.GCP_PROJECT_ID = 'monti-dev';

/** 2026-09-21 03:00 Asia/Seoul. 스케줄이 실제로 도는 시각으로 고정해 경로를 결정적으로 만든다. */
const RUN_AT = new Date('2026-09-20T18:00:00Z');
const DATE = '2026-09-21';
const BUCKET = 'monti-exports';
const DATASET = 'monti';

/**
 * `defineString` 의 `default` 는 배포 때 환경변수로 구워지고, 런타임의 `.value()` 는
 * `process.env[name] || ''` 만 본다(config.test.ts 의 같은 주석). 테스트 프로세스에는
 * 구워 줄 배포가 없으니 직접 넣는다 — 안 넣으면 버킷 이름이 빈 문자열이 된다.
 */
process.env.EXPORT_BUCKET = BUCKET;
process.env.BIGQUERY_DATASET = DATASET;

/** 업로드 대상. `file()` 이 불린 순서대로 쌓이므로 save 호출과 1:1 로 짝이 맞는다. */
const files: Array<{ bucket: string; path: string }> = [];
/** 로드 잡이 걸린 `{dataset}.{table}`. 비어 있는 엔티티는 여기 안 들어온다. */
const tables: string[] = [];

const save = vi.fn(async (_body: string, _options?: unknown) => undefined);
const load = vi.fn(async (_source: unknown, _options?: unknown) => [
  { status: { state: 'DONE' } },
]);

vi.mock('@google-cloud/storage', () => ({
  Storage: class {
    bucket(name: string) {
      return {
        name,
        file: (path: string) => {
          files.push({ bucket: name, path });
          return { bucket: name, path, save };
        },
      };
    }
  },
}));

vi.mock('@google-cloud/bigquery', () => ({
  BigQuery: class {
    dataset(name: string) {
      return {
        table: (table: string) => {
          tables.push(`${name}.${table}`);
          return { load };
        },
      };
    }
  },
}));

/** 엔티티별로 답을 바꿔 끼우는 훅. 기본은 "Ticket 만 한 줄, 나머지는 비었다". */
const pages = new Map<string, () => unknown[]>();
const envioPage = vi.fn(async (entity: string, _fields: string) => {
  const page = pages.get(entity);
  return page ? page() : [];
});

vi.mock('../src/lib/envio.js', () => ({
  envioPage: (entity: string, fields: string) => envioPage(entity, fields),
  envioQuery: vi.fn(),
}));

const { dailyExport, toJsonl, seoulDate, EXPORT_ENTITIES } = await import(
  '../src/functions/dailyExport.js'
);
const functionsTest = (await import('firebase-functions-test')).default();
// `onSchedule` 이 주는 `ScheduleFunction` 은 `wrap` 오버로드 어디에도 맞지 않는다.
// 런타임은 `__endpoint.scheduleTrigger` 만 보고 스케줄 경로로 흘리므로 호출 형태는 그대로다.
const run = functionsTest.wrap(dailyExport as unknown as CloudFunction<CloudEvent<unknown>>);

beforeEach(() => {
  files.length = 0;
  tables.length = 0;
  save.mockClear();
  save.mockResolvedValue(undefined);
  load.mockClear();
  load.mockResolvedValue([{ status: { state: 'DONE' } }]);
  envioPage.mockClear();
  pages.clear();
  pages.set('Ticket', () => [{ id: '7', eventId: '11', tier: 0 }]);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(RUN_AT);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('toJsonl', () => {
  it('writes one compact JSON object per line with a trailing newline', () => {
    expect(toJsonl([{ a: 1 }, { b: 2 }])).toBe('{"a":1}\n{"b":2}\n');
  });

  it('returns an empty string for an empty page, not a bare newline', () => {
    expect(toJsonl([])).toBe('');
  });

  it('writes a bigint as a decimal string instead of throwing', () => {
    // JSON.stringify 는 bigint 를 만나면 TypeError 로 파일 전체를 날린다.
    expect(toJsonl([{ id: 2n ** 64n }])).toBe('{"id":"18446744073709551616"}\n');
  });

  it('reaches bigints nested inside objects and arrays', () => {
    expect(toJsonl([{ chain: { block: 1n }, tiers: [2n] }])).toBe(
      '{"chain":{"block":"1"},"tiers":["2"]}\n',
    );
  });
});

describe('seoulDate', () => {
  it('keeps the whole 03:00 window on the same Seoul calendar day', () => {
    // 02:59 KST 와 03:00 KST — 스케줄러가 조금 일찍/늦게 깨워도 같은 폴더에 떨어져야 한다.
    expect(seoulDate(new Date('2026-09-20T17:59:00Z'))).toBe(DATE);
    expect(seoulDate(new Date('2026-09-20T18:00:00Z'))).toBe(DATE);
  });

  it('rolls over at Seoul midnight, not at UTC midnight', () => {
    // 23:59:59 KST → 아직 20일. 00:00:00 KST → 21일. UTC 로 계산하면 둘 다 20일이 된다.
    expect(seoulDate(new Date('2026-09-20T14:59:59Z'))).toBe('2026-09-20');
    expect(seoulDate(new Date('2026-09-20T15:00:00Z'))).toBe('2026-09-21');
  });
});

describe('EXPORT_ENTITIES', () => {
  it('covers every master-plan entity', () => {
    expect(EXPORT_ENTITIES.map((e) => e.entity).sort()).toEqual([
      'Admin',
      'CheckIn',
      'Event',
      'Gate',
      'IdentityAccount',
      'Manager',
      'Offer',
      'Organizer',
      'Override',
      'Ticket',
      'Tier',
    ]);
  });

  it('always selects id first so the cursor pager has something to page on', () => {
    for (const { entity, fields } of EXPORT_ENTITIES) {
      expect(fields.split(' ')[0], entity).toBe('id');
    }
  });

  it('selects the schema.graphql scalars and no relation fields', () => {
    const byName = new Map(EXPORT_ENTITIES.map((e) => [e.entity, e.fields.split(' ')]));
    expect(byName.get('Manager')).toEqual(['id', 'orgId', 'account', 'exists', 'canApprove']);
    // Gate.isOpen 과 CheckIn.late 는 Task 33 이 스키마에서 바꾼/더한 열이다. 정확히
    // 단언해 두지 않으면 다음 rename 도 테스트가 못 잡고 BigQuery 백업이 조용히 빈다.
    expect(byName.get('Gate')).toEqual(['id', 'eventId', 'account', 'kx', 'ky', 'isOpen', 'revoked']);
    expect(byName.get('CheckIn')).toEqual([
      'id', 'gateId', 'ts', 'nonceHash', 'manual', 'late', 'txHash', 'block',
    ]);
    expect(byName.get('Offer')).toEqual(['id', 'from', 'commitment', 'expiresAt', 'status']);
    expect(byName.get('Event')).toContain('creator');
    expect(byName.get('IdentityAccount')).toContain('deviceUpdatedAt');
    // checkIn / identity 는 다른 테이블의 관계 필드다. 스칼라만 내보낸다.
    expect(byName.get('Ticket')).toEqual(['id', 'eventId', 'tier', 'owner', 'transfers', 'revoked']);
  });
});

describe('dailyExport', () => {
  it('uploads one file per entity and starts a BigQuery load job for non-empty ones', async () => {
    await run({} as never);

    expect(save).toHaveBeenCalledTimes(EXPORT_ENTITIES.length);
    expect(load).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]![0]).toBeTypeOf('string');
  });

  it('writes gs://{bucket}/{seoul date}/{entity}.jsonl', async () => {
    await run({} as never);

    expect(files).toHaveLength(EXPORT_ENTITIES.length);
    expect(files.every((f) => f.bucket === BUCKET)).toBe(true);
    expect(files.map((f) => f.path)).toEqual(
      EXPORT_ENTITIES.map((e) => `${DATE}/${e.entity}.jsonl`),
    );
  });

  it('uploads the page as newline-delimited JSON', async () => {
    await run({} as never);

    const ticket = files.findIndex((f) => f.path.endsWith('Ticket.jsonl'));
    expect(save.mock.calls[ticket]![0]).toBe('{"id":"7","eventId":"11","tier":0}\n');
    expect(save.mock.calls[ticket]![1]).toEqual({ contentType: 'application/x-ndjson' });
  });

  it('uploads the empty entities too but starts no load job for them', async () => {
    await run({} as never);

    const organizer = files.findIndex((f) => f.path.endsWith('Organizer.jsonl'));
    expect(save.mock.calls[organizer]![0]).toBe('');
    expect(tables).toEqual([`${DATASET}.Ticket`]);
  });

  it('truncates the day table from the day file with autodetected schema', async () => {
    await run({} as never);

    const [source, options] = load.mock.calls[0]!;
    expect(source).toMatchObject({ bucket: BUCKET, path: `${DATE}/Ticket.jsonl` });
    expect(options).toEqual({
      sourceFormat: 'NEWLINE_DELIMITED_JSON',
      autodetect: true,
      writeDisposition: 'WRITE_TRUNCATE',
    });
  });

  it('pages every entity through the id-cursor pager with its own field list', async () => {
    await run({} as never);

    expect(envioPage.mock.calls.map((c) => c[0])).toEqual(EXPORT_ENTITIES.map((e) => e.entity));
    expect(envioPage.mock.calls.map((c) => c[1])).toEqual(EXPORT_ENTITIES.map((e) => e.fields));
  });

  it('keeps going when one entity fails to read', async () => {
    pages.set('Gate', () => {
      throw new Error('HASURA_TIMEOUT');
    });
    pages.set('Offer', () => [{ id: '3', status: 'open' }]);

    await expect(run({} as never)).resolves.not.toThrow();

    expect(save).toHaveBeenCalledTimes(EXPORT_ENTITIES.length - 1);
    expect(files.some((f) => f.path.endsWith('Gate.jsonl'))).toBe(false);
    expect(tables.sort()).toEqual([`${DATASET}.Offer`, `${DATASET}.Ticket`]);
  });

  it('keeps going when the bucket does not exist yet', async () => {
    // 버킷은 Task 30 배포 체크리스트에서 만든다. 그 전까지 매일 이 경로로 돈다.
    save.mockRejectedValue(new Error('NotFound: 404 bucket'));

    await expect(run({} as never)).resolves.not.toThrow();

    expect(save).toHaveBeenCalledTimes(EXPORT_ENTITIES.length);
    expect(load).not.toHaveBeenCalled();
  });

  it('keeps going when one load job is rejected', async () => {
    pages.set('Offer', () => [{ id: '3', status: 'open' }]);
    load.mockRejectedValueOnce(new Error('BQ_DATASET_NOT_FOUND'));

    await expect(run({} as never)).resolves.not.toThrow();

    expect(save).toHaveBeenCalledTimes(EXPORT_ENTITIES.length);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('returns normally when the indexer is unreachable and nothing exports', async () => {
    envioPage.mockRejectedValue(new Error('fetch failed'));

    await expect(run({} as never)).resolves.not.toThrow();

    expect(envioPage).toHaveBeenCalledTimes(EXPORT_ENTITIES.length);
    expect(save).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  });

  it('runs at 03:00 Asia/Seoul in the deployed region', () => {
    const endpoint = (dailyExport as unknown as { __endpoint: Record<string, unknown> }).__endpoint;
    expect(endpoint.scheduleTrigger).toMatchObject({
      schedule: '0 3 * * *',
      timeZone: 'Asia/Seoul',
    });
    expect(endpoint.region).toEqual([FIREBASE_REGION]);
    // 열한 테이블을 통째로 페이징한다 — 기본 60초·512MiB 로는 못 끝낸다.
    expect(endpoint.timeoutSeconds).toBe(540);
    expect(endpoint.availableMemoryMb).toBe(1024);
  });
});
