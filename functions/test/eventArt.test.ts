import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';

process.env.GCP_PROJECT_ID = 'monti-dev';

const TICKET = '0x3333333333333333333333333333333333333333';
const ORGANIZERS = '0x2222222222222222222222222222222222222222';
/** 조직 오너. **글자가 섞인** 주소다 — 체크섬을 빠뜨린 회귀는 이런 주소에서만 잡힌다. */
const OWNER = '0xDeaDbeefdEAdbeefdEadbEEFdeadbeEFdEaDbeeF';
/** `PERM_CREATE_EVENT(1)` 만 가진 관리자. */
const CREATOR_ADMIN = '0x8888888888888888888888888888888888888888';
const OUTSIDER = '0x7777777777777777777777777777777777777777';

const ART_CID = `bafk${'a'.repeat(55)}`;

// ───────────────────────────────────────────────────────── 가짜 Firestore
const docs = new Map<string, Record<string, unknown>>();
const writes: string[] = [];
const SERVER_TIMESTAMP = FieldValue.serverTimestamp();

function isServerTimestamp(value: unknown): boolean {
  const candidate = value as FieldValue | undefined;
  return typeof candidate?.isEqual === 'function' && candidate.isEqual(SERVER_TIMESTAMP);
}

vi.mock('../src/lib/db.js', () => ({
  EVENT_ART: 'eventArt',
  PERSONS: 'persons',
  USERS: 'users',
  db: {
    collection: (name: string) => ({
      doc: (id: string) => ({
        path: `${name}/${id}`,
        set: async (data: Record<string, unknown>) => {
          writes.push(`${name}/${id}`);
          docs.set(
            `${name}/${id}`,
            Object.fromEntries(
              Object.entries(data).map(([k, v]) => [k, isServerTimestamp(v) ? Timestamp.now() : v]),
            ),
          );
        },
      }),
    }),
  },
}));

/** eth_call 하나하나의 답. 인가는 전부 체인에서 읽는다 — 우리 DB 에는 역할이 없다. */
const chain = { orgId: 5n, owner: OWNER.toLowerCase() as string, bits: new Map<string, number>() };
const calls: Array<{ functionName: string; args: readonly unknown[] }> = [];

vi.mock('../src/lib/chain.js', () => ({
  deployment: () => ({ ticket: TICKET, organizers: ORGANIZERS }),
  publicClient: () => ({
    readContract: async ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
      calls.push({ functionName, args });
      if (functionName === 'eventOrg') return chain.orgId;
      if (functionName === 'ownerOf') return chain.owner;
      if (functionName === 'hasPermission') {
        const [, account, bit] = args as [bigint, string, number];
        return ((chain.bits.get(account.toLowerCase()) ?? 0) & bit) === bit && bit !== 0;
      }
      throw new Error(`UNEXPECTED_READ:${functionName}`);
    },
  }),
}));

let caller = OWNER;
vi.mock('../src/lib/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/auth.js')>()),
  resolveCallerAccount: vi.fn(async () => caller),
}));

await import('../src/config.js');
const { ART_PRESETS, MAX_ART_TIERS, saveEventArt } = await import('../src/functions/eventArt.js');
const functionsTest = (await import('firebase-functions-test')).default();
const save = functionsTest.wrap(saveEventArt);

const auth = { uid: 'uid-1' };

function stored(): Record<string, unknown> | undefined {
  return docs.get('eventArt/11');
}

beforeEach(() => {
  docs.clear();
  writes.length = 0;
  calls.length = 0;
  caller = OWNER;
  chain.orgId = 5n;
  chain.owner = OWNER.toLowerCase();
  chain.bits.clear();
  chain.bits.set(CREATOR_ADMIN.toLowerCase(), 1); // PERM_CREATE_EVENT
});

describe('saveEventArt', () => {
  it('stores a preset per tier, in the order the tiers were given', async () => {
    await expect(
      save({ data: { eventId: '11', tiers: [{ preset: 'c' }, { preset: 'a' }] }, auth } as never),
    ).resolves.toEqual({ ok: true });
    expect(stored()?.tiers).toEqual([{ preset: 'c' }, { preset: 'a' }]);
  });

  it('stores an uploaded image CID just as readily, and the two can be mixed', async () => {
    await save({
      data: { eventId: '11', tiers: [{ imageCid: ART_CID }, { preset: 'b' }] },
      auth,
    } as never);
    expect(stored()?.tiers).toEqual([{ imageCid: ART_CID }, { preset: 'b' }]);
  });

  /**
   * 프리셋은 열둘인데 한 공연의 종류는 여덟이 상한이다 — 목록을 그대로 한 번에 보내면
   * `BAD_TIERS` 가 먼저 난다. 여덟씩 끊어 보내 **모든 글자**가 통과하는 것을 본다.
   */
  it('takes every bundled preset letter', async () => {
    for (let i = 0; i < ART_PRESETS.length; i += MAX_ART_TIERS) {
      const chunk = ART_PRESETS.slice(i, i + MAX_ART_TIERS).map((preset) => ({ preset }));
      await expect(save({ data: { eventId: '11', tiers: chunk }, auth } as never)).resolves.toEqual({
        ok: true,
      });
      expect(stored()?.tiers).toEqual(chunk);
    }
  });

  it("takes the last bundled letter 'l'", async () => {
    await expect(save({ data: { eventId: '11', tiers: [{ preset: 'l' }] }, auth } as never)).resolves.toEqual(
      { ok: true },
    );
    expect(stored()?.tiers).toEqual([{ preset: 'l' }]);
  });

  /**
   * 규칙 파일은 TS 를 읽지 못해 프리셋 글자가 두 벌로 존재한다. 여기서 맞대어, 서버만
   * 넓히고 `firestore.rules` 를 빠뜨리는 회귀를 배포 전에 잡는다 — 그 회귀의 증상은
   * 검증 메시지가 아니라 초안 자동저장의 문서 단위 권한 오류다.
   */
  it('keeps the preset range in firestore.rules in step with ART_PRESETS', () => {
    const rules = readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8');
    const range = /art\.get\('preset', 'a'\)\.matches\('\^\[a-([a-z])\]\$'\)/.exec(rules);
    expect(range, 'firestore.rules 에서 artOk 의 프리셋 범위를 찾지 못했다').not.toBeNull();
    const last = range![1]!.charCodeAt(0);
    const letters = Array.from({ length: last - 'a'.charCodeAt(0) + 1 }, (_, i) =>
      String.fromCharCode('a'.charCodeAt(0) + i),
    );
    expect(letters).toEqual([...ART_PRESETS]);
  });

  it('takes eight tiers — the same ceiling the contract enforces — and refuses a ninth', async () => {
    const eight = Array.from({ length: MAX_ART_TIERS }, () => ({ preset: 'a' }));
    await expect(save({ data: { eventId: '11', tiers: eight }, auth } as never)).resolves.toEqual({
      ok: true,
    });

    writes.length = 0;
    await expect(
      save({ data: { eventId: '11', tiers: [...eight, { preset: 'a' }] }, auth } as never),
    ).rejects.toThrow('BAD_TIERS');
    expect(writes).toEqual([]);
  });

  /**
   * 한 칸에 둘 다 있으면 화면이 어느 쪽을 그릴지 여기서 정해지지 않고, 둘 다 없으면
   * 그 칸은 빈 카드가 된다. 어느 쪽도 저장 뒤에 고칠 수 없는 문제가 아니라 **지금** 막는다.
   */
  it('takes exactly one of preset and imageCid per tier, never both and never neither', async () => {
    for (const tier of [{}, { preset: 'a', imageCid: ART_CID }, { design: 'aurora' }]) {
      await expect(save({ data: { eventId: '11', tiers: [tier] }, auth } as never)).rejects.toThrow(
        'BAD_TIERS',
      );
    }
    expect(writes).toEqual([]);
  });

  it('refuses a preset that is not one of the twelve the web bundles', async () => {
    for (const preset of ['m', 'z', 'A', 'aurora', '', 1, null]) {
      await expect(save({ data: { eventId: '11', tiers: [{ preset }] }, auth } as never)).rejects.toThrow(
        preset === undefined ? 'BAD_TIERS' : 'BAD_PRESET',
      );
    }
    expect(writes).toEqual([]);
  });

  it('refuses an image CID that is not the base32 CIDv1 the pin returns', async () => {
    for (const imageCid of [
      'QmPK1s3pNYLi9ERiq3BDxKa4XosgWwFRQUydHUtz4YgpqB',
      `bafk${'a'.repeat(54)}`,
      `bafz${'a'.repeat(55)}`,
      `ipfs://${ART_CID}`,
      '',
      7,
    ]) {
      await expect(
        save({ data: { eventId: '11', tiers: [{ imageCid }] }, auth } as never),
      ).rejects.toThrow('BAD_IMAGE_CID');
    }
    expect(writes).toEqual([]);
  });

  it('refuses an empty or malformed tier list', async () => {
    for (const tiers of [undefined, [], 'a', { 0: { preset: 'a' } }, [null], ['a']]) {
      await expect(save({ data: { eventId: '11', tiers }, auth } as never)).rejects.toThrow('BAD_TIERS');
    }
    expect(writes).toEqual([]);
  });

  it('replaces the list instead of merging, so dropping a tier drops its art', async () => {
    await save({
      data: { eventId: '11', tiers: [{ preset: 'a' }, { preset: 'b' }, { preset: 'c' }] },
      auth,
    } as never);
    await save({ data: { eventId: '11', tiers: [{ preset: 'd' }] }, auth } as never);
    expect(stored()?.tiers).toEqual([{ preset: 'd' }]);
  });

  it('lets an admin holding PERM_CREATE_EVENT save, and asks the chain with that exact bit', async () => {
    caller = CREATOR_ADMIN;
    await expect(save({ data: { eventId: '11', tiers: [{ preset: 'a' }] }, auth } as never)).resolves.toEqual(
      { ok: true },
    );
    expect(calls).toContainEqual({ functionName: 'eventOrg', args: [11n] });
    expect(calls).toContainEqual({ functionName: 'hasPermission', args: [5n, CREATOR_ADMIN, 1] });
  });

  it('refuses a caller who is not an organizer, and writes nothing', async () => {
    caller = OUTSIDER;
    await expect(save({ data: { eventId: '11', tiers: [{ preset: 'a' }] }, auth } as never)).rejects.toThrow(
      'NOT_ORGANIZER',
    );
    expect(writes).toEqual([]);
  });

  it('refuses a malformed event id and writes "011" and "11" to the same document', async () => {
    for (const eventId of [undefined, '', '0x11', 11]) {
      await expect(
        save({ data: { eventId, tiers: [{ preset: 'a' }] }, auth } as never),
      ).rejects.toThrow('BAD_EVENT_ID');
    }
    await save({ data: { eventId: '011', tiers: [{ preset: 'a' }] }, auth } as never);
    expect(writes).toEqual(['eventArt/11']);
  });

  it('validates the whole request before it asks the chain anything', async () => {
    await expect(save({ data: { eventId: '11', tiers: [{ preset: 'z' }] }, auth } as never)).rejects.toThrow(
      'BAD_PRESET',
    );
    expect(calls).toEqual([]);
  });
});
