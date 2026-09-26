import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.GCP_PROJECT_ID = 'monti-dev';
/** `defineSecret(...).value()` 는 `process.env[name]` 을 읽는다(attester.test.ts 와 같은 방식). */
process.env.PINATA_JWT = 'pinata-test-jwt';

const POSTER_CID = `bafk${'a'.repeat(55)}`;

// ───────────────────────────────────────────────────────── 가짜 Firestore
/** `users`·`persons`·`pinQuota` 세 컬렉션만 흉내 낸다(eventChat.test.ts 와 같은 패턴). */
const docs = new Map<string, Record<string, unknown>>();

function snapshot(path: string) {
  const data = docs.get(path);
  return {
    exists: data !== undefined,
    get: (field: string) => data?.[field],
    data: () => data,
  };
}

function docRef(path: string) {
  return { path, get: async () => snapshot(path) };
}

vi.mock('../src/lib/db.js', () => ({
  PERSONS: 'persons',
  USERS: 'users',
  PIN_QUOTA: 'pinQuota',
  db: {
    collection: (name: string) => ({ doc: (id: string) => docRef(`${name}/${id}`) }),
    runTransaction: async <T>(body: (tx: unknown) => Promise<T>): Promise<T> => {
      const pending: Array<() => void> = [];
      const tx = {
        get: async (ref: { path: string }) => snapshot(ref.path),
        set: (ref: { path: string }, data: Record<string, unknown>) => {
          pending.push(() => docs.set(ref.path, data));
        },
      };
      const result = await body(tx);
      for (const apply of pending) apply();
      return result;
    },
  },
}));

/** `pinEventImage` 는 체인을 읽지 않는다. 모듈이 끌고 오는 것만 막아 둔다. */
vi.mock('../src/lib/chain.js', () => ({
  deployment: () => ({ organizers: '0x22', ticket: '0x33' }),
  publicClient: () => ({
    readContract: async () => {
      throw new Error('UNEXPECTED_CHAIN_READ');
    },
  }),
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function pinataReply(cid: string, status = 200): Response {
  return new Response(JSON.stringify({ data: { cid } }), { status });
}

function uploadedFile(index = 0): File {
  const [, init] = fetchMock.mock.calls[index] as [string, { body: FormData }];
  return init.body.get('file') as File;
}

const { MAX_PINS_PER_DAY, MAX_POSTER_BYTES, MAX_TICKET_ART_BYTES, pinEventImage } = await import(
  '../src/functions/organizer.js'
);
const functionsTest = (await import('firebase-functions-test')).default();
const pin = functionsTest.wrap(pinEventImage);

const auth = { uid: 'uid-1' };

/**
 * PNG 앞머리 24바이트 + 채움. `probeImage` 는 헤더만 읽으므로 이렇게 만든 파일로
 * "치수는 작지만 바이트는 크다"를 정확히 겨냥할 수 있다.
 */
function pngBytes(width: number, height: number, padding = 0): Buffer {
  const head = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
  head.writeUInt32BE(13, 8);
  head.write('IHDR', 12, 'latin1');
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  return Buffer.concat([head, Buffer.alloc(padding, 9)]);
}

/** 앞머리 FF D8 FF 와 SOF0 하나만 담은 JPEG. */
function jpegBytes(width: number, height: number, padding = 0): Buffer {
  const head = Buffer.alloc(19);
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0]).copy(head, 0);
  head.writeUInt16BE(0x0011, 10);
  head.writeUInt8(8, 12);
  head.writeUInt16BE(height, 13);
  head.writeUInt16BE(width, 15);
  return Buffer.concat([head, Buffer.alloc(padding, 9)]);
}

function b64(bytes: Buffer): string {
  return bytes.toString('base64');
}

function quota(): Record<string, unknown> | undefined {
  return docs.get('pinQuota/0xaa');
}

beforeEach(() => {
  docs.clear();
  docs.set('users/uid-1', { personId: '0xaa' });
  docs.set('persons/0xaa', { status: 'active', account: '0x01' });
  fetchMock.mockReset();
  // `Response` 본문은 한 번만 읽힌다. 호출마다 새로 만들어야 두 번째 핀이 파서에서 죽지 않는다.
  fetchMock.mockImplementation(async () => pinataReply(POSTER_CID));
});

describe('pinEventImage', () => {
  it('pins a poster and hands back the CID alone', async () => {
    const result = (await pin({
      data: { bytesBase64: b64(jpegBytes(1240, 1754)), kind: 'poster' },
      auth,
    } as never)) as Record<string, unknown>;

    expect(result).toEqual({ cid: POSTER_CID });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  /**
   * 클라이언트가 보낸 이름이 아니라 **바이트**가 형식을 정한다(`lib/portrait.ts` 와 같은 규칙).
   * 옛 경로는 `image.mime` 을 그대로 믿어 Pinata 에 올렸다 — 이 콜러블에는 그 칸이 없다.
   */
  it('names the file from the bytes, never from anything the caller says', async () => {
    await pin({
      data: { bytesBase64: b64(pngBytes(800, 600)), kind: 'poster', mime: 'image/svg+xml' },
      auth,
    } as never);
    expect(uploadedFile().type).toBe('image/png');
    expect(uploadedFile().name).toBe('image.png');

    fetchMock.mockClear();
    await pin({ data: { bytesBase64: b64(jpegBytes(80, 60)), kind: 'ticket' }, auth } as never);
    expect(uploadedFile().type).toBe('image/jpeg');
    expect(uploadedFile().name).toBe('image.jpg');
  });

  it('takes JPEG and PNG only — webp, gif, svg and pdf are refused before any upload', async () => {
    for (const bytes of [
      Buffer.from('RIFF0000WEBPVP8 '),
      Buffer.from('GIF89a'),
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      Buffer.from('%PDF-1.4'),
    ]) {
      await expect(
        pin({ data: { bytesBase64: b64(bytes), kind: 'poster' }, auth } as never),
      ).rejects.toThrow('BAD_IMAGE_FORMAT');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a canvas wider or taller than 4000 px', async () => {
    for (const bytes of [pngBytes(4001, 10), pngBytes(10, 4001), jpegBytes(9000, 9000)]) {
      await expect(
        pin({ data: { bytesBase64: b64(bytes), kind: 'poster' }, auth } as never),
      ).rejects.toThrow('BAD_IMAGE_DIMENSIONS');
    }
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(
      pin({ data: { bytesBase64: b64(pngBytes(4000, 4000)), kind: 'poster' }, auth } as never),
    ).resolves.toEqual({ cid: POSTER_CID });
  });

  /** 포스터 600 KB · 티켓 그림 400 KB. 같은 파일이 쓰임새에 따라 갈린다. */
  it('holds each kind to its own byte cap', async () => {
    const between = pngBytes(100, 100, 500 * 1024);
    await expect(
      pin({ data: { bytesBase64: b64(between), kind: 'poster' }, auth } as never),
    ).resolves.toEqual({ cid: POSTER_CID });
    await expect(
      pin({ data: { bytesBase64: b64(between), kind: 'ticket' }, auth } as never),
    ).rejects.toThrow('IMAGE_TOO_LARGE');

    expect(between.length).toBeLessThan(MAX_POSTER_BYTES);
    expect(between.length).toBeGreaterThan(MAX_TICKET_ART_BYTES);

    fetchMock.mockClear();
    await expect(
      pin({
        data: { bytesBase64: b64(Buffer.alloc(MAX_POSTER_BYTES + 1, 7)), kind: 'poster' },
        auth,
      } as never),
    ).rejects.toThrow('IMAGE_TOO_LARGE');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a malformed request before it touches Firestore or Pinata', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ bytesBase64: b64(pngBytes(10, 10)) }, 'BAD_IMAGE_KIND'],
      [{ bytesBase64: b64(pngBytes(10, 10)), kind: 'banner' }, 'BAD_IMAGE_KIND'],
      [{ bytesBase64: b64(pngBytes(10, 10)), kind: 7 }, 'BAD_IMAGE_KIND'],
      [{ kind: 'poster' }, 'BAD_IMAGE'],
      [{ bytesBase64: '', kind: 'poster' }, 'BAD_IMAGE'],
      [{ bytesBase64: 'not base64!!', kind: 'poster' }, 'BAD_IMAGE'],
      [{ bytesBase64: 7, kind: 'poster' }, 'BAD_IMAGE'],
    ];
    for (const [data, code] of cases) {
      await expect(pin({ data, auth } as never)).rejects.toThrow(code);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(quota()).toBeUndefined();
  });

  it('refuses an unauthenticated caller before it looks at the bytes', async () => {
    await expect(
      pin({ data: { bytesBase64: b64(pngBytes(10, 10)), kind: 'poster' } } as never),
    ).rejects.toThrow('AUTH_REQUIRED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /**
   * 주최자 인가가 아니라 **가입한 사람**으로 좁힌다 — 초안은 주최사를 만들기 전에도 쓴다.
   * 그래도 아무나는 아니다: 체인에 계정이 올라간 `active` 인 사람만 우리 저장 공간을 쓴다.
   */
  it('takes any active person, and only an active person', async () => {
    docs.delete('users/uid-1');
    await expect(
      pin({ data: { bytesBase64: b64(pngBytes(10, 10)), kind: 'poster' }, auth } as never),
    ).rejects.toThrow('NO_SIGNUP');

    docs.set('users/uid-1', { personId: '0xaa' });
    docs.delete('persons/0xaa');
    await expect(
      pin({ data: { bytesBase64: b64(pngBytes(10, 10)), kind: 'poster' }, auth } as never),
    ).rejects.toThrow('NO_SIGNUP');

    docs.set('persons/0xaa', { status: 'pending' });
    await expect(
      pin({ data: { bytesBase64: b64(pngBytes(10, 10)), kind: 'poster' }, auth } as never),
    ).rejects.toThrow('NOT_ACTIVE');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('counts every pin against a per-person daily quota and stops at the limit', async () => {
    const data = { bytesBase64: b64(pngBytes(10, 10)), kind: 'poster' };
    for (let n = 0; n < MAX_PINS_PER_DAY; n += 1) {
      await pin({ data, auth } as never);
    }
    expect(quota()?.count).toBe(MAX_PINS_PER_DAY);

    fetchMock.mockClear();
    await expect(pin({ data, auth } as never)).rejects.toThrow('PIN_QUOTA');
    // 한도는 업로드 **전에** 센다 — 통과한 뒤에 세면 이미 저장 공간을 쓴 뒤다.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(quota()?.count).toBe(MAX_PINS_PER_DAY);
  });

  it('starts the count over when the stored day is not today', async () => {
    docs.set('pinQuota/0xaa', { day: '2000-01-01', count: MAX_PINS_PER_DAY });
    await pin({ data: { bytesBase64: b64(pngBytes(10, 10)), kind: 'poster' }, auth } as never);
    expect(quota()?.count).toBe(1);
    expect(quota()?.day).not.toBe('2000-01-01');
  });

  it('keeps one person’s quota out of another’s', async () => {
    docs.set('users/uid-2', { personId: '0xbb' });
    docs.set('persons/0xbb', { status: 'active' });
    docs.set('pinQuota/0xaa', { day: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date()), count: MAX_PINS_PER_DAY });

    await expect(
      pin({ data: { bytesBase64: b64(pngBytes(10, 10)), kind: 'poster' }, auth } as never),
    ).rejects.toThrow('PIN_QUOTA');
    await expect(
      pin({
        data: { bytesBase64: b64(pngBytes(10, 10)), kind: 'poster' },
        auth: { uid: 'uid-2' },
      } as never),
    ).resolves.toEqual({ cid: POSTER_CID });
  });

  /** Pinata 가 어떻게 틀어지든 호출자가 받는 것은 하나다 — 우리 쪽 사정은 로그에만 남는다. */
  it('turns every Pinata failure into a single typed PIN_FAILED', async () => {
    for (const reply of [
      pinataReply('', 401),
      new Response('<html>nope</html>', { status: 200 }),
      pinataReply('QmPK1s3pNYLi9ERiq3BDxKa4XosgWwFRQUydHUtz4YgpqB'),
    ]) {
      fetchMock.mockReset();
      fetchMock.mockResolvedValue(reply);
      await expect(
        pin({ data: { bytesBase64: b64(pngBytes(10, 10)), kind: 'poster' }, auth } as never),
      ).rejects.toThrow('PIN_FAILED');
    }

    fetchMock.mockReset();
    fetchMock.mockRejectedValue(new Error('socket hang up'));
    await expect(
      pin({ data: { bytesBase64: b64(pngBytes(10, 10)), kind: 'poster' }, auth } as never),
    ).rejects.toThrow('PIN_FAILED');
  });

  it('never hands the Pinata JWT back to the caller', async () => {
    const result = (await pin({
      data: { bytesBase64: b64(pngBytes(10, 10)), kind: 'poster' },
      auth,
    } as never)) as Record<string, unknown>;
    expect(JSON.stringify(result)).not.toContain('pinata-test-jwt');
    expect(Object.keys(result)).toEqual(['cid']);
  });
});
