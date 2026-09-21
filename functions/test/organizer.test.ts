import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.GCP_PROJECT_ID = 'monti-dev';
/** `defineSecret(...).value()` 는 `process.env[name]` 을 읽는다(attester.test.ts 와 같은 방식). */
process.env.PINATA_JWT = 'pinata-test-jwt';

const JWT = 'pinata-test-jwt';
const ORGANIZERS = '0x2222222222222222222222222222222222222222';
const TICKET = '0x3333333333333333333333333333333333333333';
/**
 * 조직 오너. **글자가 섞인** 주소다 — 숫자만 쓰는 주소에서는 EIP-55 정규화가 항등함수라
 * 체크섬을 빠뜨린 회귀를 테스트가 잡지 못한다.
 */
const OWNER = '0xDeaDbeefdEAdbeefdEadbEEFdeadbeEFdEaDbeeF';
/** 노드가 돌려주는 모양. 체인 읽기는 체크섬을 지켜 주지 않는다. */
const OWNER_FROM_CHAIN = OWNER.toLowerCase();
/** `PERM_CREATE_EVENT(1)` 만 가진 관리자. */
const CREATOR_ADMIN = '0x8888888888888888888888888888888888888888';
/** 아무 권한도 없는 사람. */
const OUTSIDER = '0x7777777777777777777777777777777777777777';

/** 59자 base32 CIDv1. Pinata v3 는 작은 파일에 raw-leaf(`bafk`)를, 큰 파일에 dag-pb(`bafy`)를 준다. */
const IMAGE_CID = `bafk${'a'.repeat(55)}`;
const METADATA_CID = `bafy${'b'.repeat(55)}`;

/** auth.ts 는 db.ts 를 끌고 오고 db.ts 는 import 시점에 firebase-admin 을 띄운다. 여기서는 필요 없다. */
vi.mock('../src/lib/db.js', () => ({ db: {}, PERSONS: 'persons', USERS: 'users' }));

/**
 * eth_call 하나하나의 답. 인가는 전부 체인에서 읽으므로(우리 DB에는 역할이 없다)
 * 이 표를 갈아끼우는 것이 곧 "누구로 부르는가" 다.
 */
const chain = { owner: OWNER_FROM_CHAIN as string, ownerHasAllBits: true, bits: new Map<string, number>() };
const reads: Array<{ functionName: string; args: readonly unknown[] }> = [];

vi.mock('../src/lib/chain.js', () => ({
  deployment: () => ({ organizers: ORGANIZERS, ticket: TICKET }),
  publicClient: () => ({
    readContract: async ({
      functionName,
      args,
    }: {
      functionName: string;
      args: readonly unknown[];
    }) => {
      reads.push({ functionName, args });
      if (functionName === 'ownerOf') return chain.owner;
      if (functionName === 'hasPermission') {
        const [, account, bit] = args as [bigint, string, number];
        if (chain.ownerHasAllBits && account.toLowerCase() === chain.owner.toLowerCase()) return true;
        const held = chain.bits.get(account.toLowerCase()) ?? 0;
        return (held & bit) === bit && bit !== 0;
      }
      throw new Error(`UNEXPECTED_READ:${functionName}`);
    },
  }),
}));

// ───────────────────────────────────────────────────────── 가짜 Pinata
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function pinataReply(cid: string, status = 200): Response {
  return new Response(JSON.stringify({ data: { cid } }), { status });
}

/** 업로드 한 번의 인자. 비밀 **값**은 여기에서도 읽지 않는다 — 모양만 본다. */
function uploadCall(index: number) {
  const [url, init] = fetchMock.mock.calls[index] as [
    string,
    { method: string; headers: Record<string, string>; body: FormData },
  ];
  return {
    url,
    method: init.method,
    authorization: init.headers.Authorization ?? '',
    network: init.body.get('network'),
    file: init.body.get('file') as File,
  };
}

const { MAX_IMAGE_BYTES, MAX_META_FIELD_CHARS, pinEventMetadata } = await import(
  '../src/functions/organizer.js'
);
const functionsTest = (await import('firebase-functions-test')).default();

const pin = functionsTest.wrap(pinEventMetadata);

/** 세션 클레임으로만 호출자를 묶는다 — 요청 본문의 주소는 어디에서도 읽지 않는다. */
const ownerAuth = { uid: 'uid-owner', token: { account: OWNER } };
const adminAuth = { uid: 'uid-admin', token: { account: CREATOR_ADMIN } };
const outsiderAuth = { uid: 'uid-outsider', token: { account: OUTSIDER } };

const IMAGE_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const IMAGE_B64 = IMAGE_BYTES.toString('base64');
const META = { name: 'MONTI Demo Night', description: '모나드 메트로폴리스 데모' };

function pinRequest(overrides: Record<string, unknown> = {}) {
  return {
    orgId: '5',
    image: { base64: IMAGE_B64, mime: 'image/jpeg' },
    meta: META,
    ...overrides,
  };
}

beforeEach(() => {
  process.env.PINATA_JWT = JWT;
  reads.length = 0;
  chain.owner = OWNER_FROM_CHAIN;
  chain.ownerHasAllBits = true;
  chain.bits.clear();
  chain.bits.set(CREATOR_ADMIN.toLowerCase(), 1); // PERM_CREATE_EVENT
  fetchMock.mockReset();
  fetchMock.mockResolvedValueOnce(pinataReply(IMAGE_CID)).mockResolvedValueOnce(pinataReply(METADATA_CID));
});

describe('pinEventMetadata', () => {
  it('pins the image, then a metadata JSON pointing at it, and returns both CIDs', async () => {
    const result = (await pin({ data: pinRequest(), auth: ownerAuth } as never)) as {
      imageCid: string;
      metadataCid: string;
    };

    expect(result).toEqual({ imageCid: IMAGE_CID, metadataCid: METADATA_CID });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const image = uploadCall(0);
    expect(image.url).toBe('https://uploads.pinata.cloud/v3/files');
    expect(image.method).toBe('POST');
    expect(image.network).toBe('public');
    expect(image.file.type).toBe('image/jpeg');
    expect(image.file.size).toBe(IMAGE_BYTES.length);

    const metadata = uploadCall(1);
    expect(metadata.file.type).toBe('application/json');
    expect(JSON.parse(await metadata.file.text())).toEqual({
      name: META.name,
      description: META.description,
      image: `ipfs://${IMAGE_CID}`,
    });
  });

  it('pins venue, category and region when they are given, trimmed', async () => {
    await pin({
      data: pinRequest({
        meta: { ...META, venue: '  올림픽공원 K-아트홀  ', category: 3, region: '  서울  ' },
      }),
      auth: ownerAuth,
    } as never);

    const metadata = JSON.parse(await uploadCall(1).file.text()) as Record<string, unknown>;
    expect(Object.keys(metadata).sort()).toEqual([
      'category',
      'description',
      'image',
      'name',
      'region',
      'venue',
    ]);
    expect(metadata.venue).toBe('올림픽공원 K-아트홀');
    expect(metadata.region).toBe('서울');
    // 관람객 화면은 `typeof fields.category === 'number'` 만 읽는다(`shared/envio/ipfs.ts`).
    // 문자열로 박으면 거기서 조용히 `0` 이 되고, 체인의 `EventMeta.category` 도 `uint8` 이다.
    expect(metadata.category).toBe(3);
    expect(typeof metadata.category).toBe('number');
  });

  it('takes a numeric string category and pins it as a number', async () => {
    // 웹 폼의 `<select>` 는 값을 문자열로 준다. 숫자로 바꿔 박는 것은 서버 몫이다.
    await pin({
      data: pinRequest({ meta: { ...META, category: ' 12 ' } }),
      auth: ownerAuth,
    } as never);

    const metadata = JSON.parse(await uploadCall(1).file.text()) as Record<string, unknown>;
    expect(metadata.category).toBe(12);
    expect(typeof metadata.category).toBe('number');
  });

  it('takes the uint8 edges 0 and 255 as a category', async () => {
    for (const [at, category] of [0, 255].entries()) {
      fetchMock.mockReset();
      fetchMock.mockResolvedValueOnce(pinataReply(IMAGE_CID)).mockResolvedValueOnce(pinataReply(METADATA_CID));
      await pin({ data: pinRequest({ meta: { ...META, category } }), auth: ownerAuth } as never);
      const metadata = JSON.parse(await uploadCall(1).file.text()) as Record<string, unknown>;
      expect(metadata.category, `${at} 번째 가장자리`).toBe(category);
    }
  });

  it('rejects a category that is not a uint8, before any upload', async () => {
    fetchMock.mockReset();
    for (const category of ['공연', '', 256, -1, 1.5, null, Number.NaN, ['3'], '0x10']) {
      await expect(
        pin({ data: pinRequest({ meta: { ...META, category } }), auth: ownerAuth } as never),
      ).rejects.toThrow('BAD_META');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('leaves an absent or blank optional field out of the JSON entirely', async () => {
    // 관람객 화면은 **없는 칸**을 기본값으로 채운다(`shared/envio/ipfs.ts`).
    // 빈 문자열을 실어 보내면 기본값 대신 빈 줄이 그려진다.
    await pin({
      data: pinRequest({ meta: { ...META, venue: '   ', category: undefined } }),
      auth: ownerAuth,
    } as never);

    const metadata = JSON.parse(await uploadCall(1).file.text()) as Record<string, unknown>;
    expect(Object.keys(metadata).sort()).toEqual(['description', 'image', 'name']);
    expect('venue' in metadata).toBe(false);
    expect('category' in metadata).toBe(false);
    expect('region' in metadata).toBe(false);
  });

  it('takes an optional field of exactly 200 characters, measured after trimming', async () => {
    await pin({
      data: pinRequest({ meta: { ...META, venue: `  ${'가'.repeat(MAX_META_FIELD_CHARS)}  ` } }),
      auth: ownerAuth,
    } as never);
    const metadata = JSON.parse(await uploadCall(1).file.text()) as { venue: string };
    expect(metadata.venue.length).toBe(MAX_META_FIELD_CHARS);
  });

  it('rejects an optional field over 200 characters or of the wrong type, before any upload', async () => {
    fetchMock.mockReset();
    const long = 'a'.repeat(MAX_META_FIELD_CHARS + 1);
    for (const meta of [
      { ...META, venue: long },
      { ...META, region: long },
      { ...META, venue: 7 },
      { ...META, region: ['서울'] },
    ]) {
      await expect(pin({ data: pinRequest({ meta }), auth: ownerAuth } as never)).rejects.toThrow(
        'BAD_META',
      );
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends the server JWT as a bearer header and never hands it back to the caller', async () => {
    const result = (await pin({ data: pinRequest(), auth: ownerAuth } as never)) as Record<string, unknown>;

    for (const index of [0, 1]) {
      // 모양만 본다 — 값을 테스트에 박으면 비밀이 저장소로 새는 길이 하나 더 생긴다.
      expect(uploadCall(index).authorization).toMatch(/^Bearer \S+$/);
    }
    expect(JSON.stringify(result)).not.toContain(JWT);
    expect(Object.keys(result).sort()).toEqual(['imageCid', 'metadataCid']);
  });

  it('lets an admin holding PERM_CREATE_EVENT pin, and asks the chain with that exact bit', async () => {
    await pin({ data: pinRequest(), auth: adminAuth } as never);
    expect(reads).toContainEqual({ functionName: 'hasPermission', args: [5n, CREATOR_ADMIN, 1] });
    expect(reads).toContainEqual({ functionName: 'ownerOf', args: [5n] });
  });

  it('refuses a caller who is neither the owner nor a create-event admin, before it uploads', async () => {
    await expect(pin({ data: pinRequest(), auth: outsiderAuth } as never)).rejects.toThrow('NOT_ORGANIZER');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses an unauthenticated caller before it looks at the image', async () => {
    await expect(pin({ data: pinRequest() } as never)).rejects.toThrow('AUTH_REQUIRED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an image over 2 MB without uploading it', async () => {
    const tooBig = Buffer.alloc(MAX_IMAGE_BYTES + 1, 7).toString('base64');
    await expect(
      pin({ data: pinRequest({ image: { base64: tooBig, mime: 'image/png' } }), auth: ownerAuth } as never),
    ).rejects.toThrow('IMAGE_TOO_LARGE');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts jpeg, png and webp and rejects every other mime', async () => {
    for (const mime of ['image/jpeg', 'image/png', 'image/webp']) {
      fetchMock.mockReset();
      fetchMock.mockResolvedValueOnce(pinataReply(IMAGE_CID)).mockResolvedValueOnce(pinataReply(METADATA_CID));
      await pin({ data: pinRequest({ image: { base64: IMAGE_B64, mime } }), auth: ownerAuth } as never);
      expect(uploadCall(0).file.type).toBe(mime);
    }

    fetchMock.mockReset();
    for (const mime of ['image/gif', 'image/svg+xml', 'application/pdf', '', undefined]) {
      await expect(
        pin({ data: pinRequest({ image: { base64: IMAGE_B64, mime } }), auth: ownerAuth } as never),
      ).rejects.toThrow('BAD_IMAGE_MIME');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a malformed request before any upload', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ orgId: '0x5' }, 'BAD_ORG_ID'],
      [{ orgId: undefined }, 'BAD_ORG_ID'],
      [{ image: undefined }, 'BAD_IMAGE'],
      [{ image: { base64: '', mime: 'image/png' } }, 'BAD_IMAGE'],
      [{ image: { base64: 'not base64!!', mime: 'image/png' } }, 'BAD_IMAGE'],
      [{ meta: undefined }, 'BAD_META'],
      [{ meta: { name: '', description: 'x' } }, 'BAD_META'],
      [{ meta: { name: 'x', description: 7 } }, 'BAD_META'],
    ];
    for (const [overrides, code] of cases) {
      await expect(pin({ data: pinRequest(overrides), auth: ownerAuth } as never)).rejects.toThrow(code);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces a Pinata failure instead of returning an empty CID', async () => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(pinataReply('', 401));
    await expect(pin({ data: pinRequest(), auth: ownerAuth } as never)).rejects.toThrow(
      'PINATA_UPLOAD_FAILED',
    );
  });

  it('surfaces a non-JSON 200 as the same Pinata failure, not a raw parse error', async () => {
    // 게이트웨이가 끼어들어 200 에 HTML 을 실어 주는 날이 있다. 그 실패가 파서에서 새어
    // 나가면 호출자는 이유 없는 `internal` 을 받는다.
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(new Response('<html>nope</html>', { status: 200 }));
    await expect(pin({ data: pinRequest(), auth: ownerAuth } as never)).rejects.toThrow(
      'PINATA_UPLOAD_FAILED',
    );
  });

  it('authorises the owner off the chain answer alone, whatever case the node returns', async () => {
    // 컨트랙트가 오너에게 모든 비트를 주지 않는 날에도 오너는 자기 조직에서 잠기지 않는다.
    chain.ownerHasAllBits = false;
    await pin({ data: pinRequest(), auth: ownerAuth } as never);
    expect(reads).toContainEqual({ functionName: 'ownerOf', args: [5n] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('refuses a CID that is not the base32 CIDv1 the chain takes', async () => {
    // CIDv0(`Qm…`)를 그대로 흘려보내면 나중에 createEvent 가 이유 없이 거절당한다.
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(pinataReply('QmPK1s3pNYLi9ERiq3BDxKa4XosgWwFRQUydHUtz4YgpqB'));
    await expect(pin({ data: pinRequest(), auth: ownerAuth } as never)).rejects.toThrow('BAD_PINATA_CID');
  });
});
