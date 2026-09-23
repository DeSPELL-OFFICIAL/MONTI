import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { hashMessage, recoverAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  BANNED_ATTENDEE_WORDS,
  TRANSFER_INVITE_TTL_SECONDS,
  offerDigest,
  recipientCommitment,
  ticketAbi,
  type Hex,
} from '@monti/shared';

process.env.GCP_PROJECT_ID = 'monti-dev';
process.env.PHONE_INDEX_KEY = 'monti-test-key';
// `defineString` 은 선언된 default 를 런타임에 쓰지 않는다(`process.env[name] || ''`, config.test.ts 참고).
process.env.RP_ID = 'monti.despell.io';

/** 테스트 전용 어테스터 키. attester.test.ts 와 같은 공개 값이다. */
const PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex;
process.env.ATTESTER_PK = PK;
const attester = privateKeyToAccount(PK);

const KEY = 'monti-test-key';
const TICKET = '0x3333333333333333333333333333333333333333';
/** 같은 체인의 다른 Ticket. EIP-712 도메인이 정말 주소를 묶는지 보는 데만 쓴다. */
const OTHER_TICKET = '0x4444444444444444444444444444444444444444' as Hex;
/** 배포 기록이 내놓는 체인 id. `offerDigest` 의 EIP-712 도메인에 그대로 들어간다. */
const CHAIN_ID = 31337;
/**
 * 위 fixture(체인 31337 · Ticket 0x3333… · tokenId 7 · 커밋먼트 = recipientCommitment(hmacPhone(PHONE, KEY))
 * · 받는 사람 0x8888…)에 대한 `Ticket.offerDigest` 값. 어테스터가 **실제로 서명하는 바로 그 32바이트**다.
 * `offerDigest` 의 필드가 하나 빠지거나 순서가 바뀌면 테스트가 함께 따라가지 못하도록 못으로 박는다.
 */
const PINNED_DIGEST = '0x234d92510a7c4d02d3fffcb85be1eed34ad5193666e57dd9c846a6ad75e2c7c3' as Hex;
/** `eventOf(tokenId)` 가 돌려주는 공연 id. `eventMeta` 가 이 값으로 불려야 한다. */
const EVENT_ID = 42n;
/** 티켓 주인이자 보내는 사람. 숫자만 쓰는 주소라 EIP-55 체크섬이 대소문자를 바꾸지 않는다. */
const OWNER = '0x9999999999999999999999999999999999999999';
/** 받는 사람의 계정. `acceptOffer` 의 msg.sender 가 될 주소다. */
const RECIPIENT = '0x8888888888888888888888888888888888888888';
const OUTSIDER = '0x7777777777777777777777777777777777777777';
const ZERO = '0x0000000000000000000000000000000000000000';
const ZERO32 = `0x${'00'.repeat(32)}` as Hex;
const PHONE = '+821012345678';
const SENDER_PHONE = '+821000000000';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * `transferInvites` / `users` 두 컬렉션과 등식 질의만 흉내 내는 가짜 Firestore.
 * 에뮬레이터 없이 `pnpm test` 안에서 돈다(invites.test.ts 와 같은 패턴).
 */
const docs = new Map<string, Record<string, unknown>>();
/** 쓰기 횟수. `pendingOffers` 는 아무것도 쓰지 않아야 한다. */
let writeCount = 0;

const SERVER_TIMESTAMP = FieldValue.serverTimestamp();

function isServerTimestamp(value: unknown): boolean {
  const candidate = value as FieldValue | undefined;
  return typeof candidate?.isEqual === 'function' && candidate.isEqual(SERVER_TIMESTAMP);
}

function write(path: string, data: Record<string, unknown>, options?: { merge?: boolean }): void {
  const previous = options?.merge ? (docs.get(path) ?? {}) : {};
  const resolved = Object.fromEntries(
    Object.entries(data).map(([k, v]) => [k, isServerTimestamp(v) ? Timestamp.now() : v]),
  );
  docs.set(path, { ...previous, ...resolved });
}

function snapshot(path: string) {
  const data = docs.get(path);
  return {
    exists: data !== undefined,
    id: path.slice(path.indexOf('/') + 1),
    get: (field: string) => data?.[field],
    data: () => data,
  };
}

function docRef(path: string) {
  return {
    path,
    id: path.slice(path.indexOf('/') + 1),
    get: async () => snapshot(path),
    set: async (data: Record<string, unknown>, options?: { merge?: boolean }) => {
      writeCount += 1;
      write(path, data, options);
    },
  };
}

function query(name: string, filters: Array<[string, unknown]>, max: number) {
  return {
    where: (field: string, op: string, value: unknown) => {
      if (op !== '==') throw new Error(`UNSUPPORTED_OP:${op}`);
      return query(name, [...filters, [field, value]], max);
    },
    limit: (n: number) => query(name, filters, n),
    get: async () => {
      const matched = [...docs.entries()]
        .filter(([path]) => path.startsWith(`${name}/`))
        .filter(([, data]) => filters.every(([field, value]) => data[field] === value))
        .slice(0, max)
        .map(([path]) => snapshot(path));
      return { docs: matched, size: matched.length, empty: matched.length === 0 };
    },
  };
}

function collection(name: string) {
  return { ...query(name, [], Number.POSITIVE_INFINITY), doc: (id: string) => docRef(`${name}/${id}`) };
}

vi.mock('../src/lib/db.js', () => ({
  PERSONS: 'persons',
  USERS: 'users',
  TRANSFER_INVITES: 'transferInvites',
  db: { collection },
}));

interface ChainOffer {
  from: string;
  recipientCommitment: Hex;
  expiresAt: bigint;
}

const NO_OFFER: ChainOffer = { from: ZERO, recipientCommitment: ZERO32, expiresAt: 0n };
/** 체인 상태. 토큰 주인과 `offerOf` 가 돌려줄 오퍼. */
const chain = { owner: OWNER as string, offers: new Map<string, ChainOffer>(), requireKyc: false };
const reads: Array<{ functionName: string; args: readonly unknown[] }> = [];

vi.mock('../src/lib/chain.js', () => ({
  deployment: () => ({ chainId: CHAIN_ID, ticket: TICKET }),
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
      if (functionName === 'offerOf') {
        return chain.offers.get(String(args[0] as bigint)) ?? NO_OFFER;
      }
      if (functionName === 'eventOf') return EVENT_ID;
      if (functionName === 'eventMeta') return { requireKyc: chain.requireKyc };
      throw new Error(`UNEXPECTED_READ:${functionName}`);
    },
  }),
}));

const { TRANSFER_INVITES, USERS } = await import('../src/lib/db.js');
const { hmacPhone } = await import('../src/lib/phoneIndex.js');
const { createTransferInvite, eventMetaAbi, pendingOffers } = await import(
  '../src/functions/transferInvites.js'
);
const functionsTest = (await import('firebase-functions-test')).default();

const create = functionsTest.wrap(createTransferInvite);
const pending = functionsTest.wrap(pendingOffers);

/** 호출자는 언제나 세션 클레임에서 나온다 — 요청 본문의 주소는 어디에서도 읽지 않는다. */
const senderAuth = { uid: 'uid-sender', token: { account: OWNER } };
const recipientAuth = { uid: 'uid-recipient', token: { account: RECIPIENT } };
const outsiderAuth = { uid: 'uid-outsider', token: { account: OUTSIDER } };

interface InviteResult {
  inviteId: string;
  commitment: Hex;
  expiresAt: number;
  smsText: string;
  smsUri: string;
}

function givenUser(uid: string, phoneE164: string | null, locale?: string): void {
  write(`${USERS}/${uid}`, {
    ...(phoneE164 ? { phoneHmac: hmacPhone(phoneE164, KEY) } : {}),
    ...(locale ? { locale } : {}),
  });
  writeCount = 0;
}

async function givenInvite(phoneE164 = PHONE, tokenId = '7'): Promise<InviteResult> {
  const result = (await create({
    data: { tokenId, phoneE164 },
    auth: senderAuth,
  } as never)) as InviteResult;
  // 보내는 사람이 웹에서 `createOffer` 를 보낸 뒤의 체인 상태.
  chain.offers.set(tokenId, {
    from: OWNER,
    recipientCommitment: result.commitment,
    expiresAt: BigInt(result.expiresAt),
  });
  writeCount = 0;
  return result;
}

beforeEach(() => {
  process.env.RP_ID = 'monti.despell.io';
  process.env.PHONE_INDEX_KEY = KEY;
  process.env.ATTESTER_PK = PK;
  docs.clear();
  reads.length = 0;
  writeCount = 0;
  chain.owner = OWNER;
  chain.offers.clear();
  chain.requireKyc = false;
  givenUser('uid-sender', SENDER_PHONE);
  givenUser('uid-recipient', PHONE);
});

describe('createTransferInvite', () => {
  it('stores an invite with the keccak commitment and returns an sms: URI the sender opens', async () => {
    const result = await givenInvite();

    expect(result.inviteId).toMatch(UUID_RE);
    expect(result.commitment).toBe(recipientCommitment(hmacPhone(PHONE, KEY)));
    expect(result.smsUri.startsWith(`sms:${PHONE}?body=`)).toBe(true);
    expect(decodeURIComponent(result.smsUri.split('?body=')[1] ?? '')).toBe(result.smsText);
    expect(result.smsText).toContain(`https://monti.despell.io/i/${result.inviteId}`);
    const ttl = result.expiresAt - Math.floor(Date.now() / 1000);
    expect(ttl).toBeLessThanOrEqual(TRANSFER_INVITE_TTL_SECONDS);
    expect(ttl).toBeGreaterThan(TRANSFER_INVITE_TTL_SECONDS - 60);

    const invite = snapshot(`${TRANSFER_INVITES}/${result.inviteId}`);
    expect(invite.get('status')).toBe('sent');
    expect(invite.get('tokenId')).toBe('7');
    expect(invite.get('commitment')).toBe(result.commitment);
    expect(invite.get('hmacPhone')).toBe(hmacPhone(PHONE, KEY));
    expect(invite.get('fromAccount')).toBe(OWNER);
    expect(invite.get('expiresAt')).toBe(result.expiresAt);
  });

  it('never persists the phone number — only the HMAC startSignup also writes', async () => {
    const result = await givenInvite();

    const invite = snapshot(`${TRANSFER_INVITES}/${result.inviteId}`);
    expect(invite.get('phoneE164')).toBeUndefined();
    expect(invite.get('smsText')).toBeUndefined();
    expect(invite.get('smsUri')).toBeUndefined();
    const everythingWritten = JSON.stringify([...docs.entries()]);
    expect(everythingWritten).not.toContain(PHONE);
    expect(everythingWritten).not.toContain('821012345678');
  });

  it('keeps crypto vocabulary out of the text the recipient reads', async () => {
    const { smsText } = await givenInvite();
    for (const word of BANNED_ATTENDEE_WORDS) {
      expect(smsText.toLowerCase()).not.toContain(word.toLowerCase());
    }
  });

  it('writes the invite text in the sender locale', async () => {
    givenUser('uid-sender', SENDER_PHONE, 'en');
    const { smsText } = await givenInvite();
    expect(smsText).toContain('MONTI');
    expect(/[가-힣]/.test(smsText)).toBe(false);
  });

  it('refuses a token the caller does not own', async () => {
    await expect(
      create({ data: { tokenId: '7', phoneE164: PHONE }, auth: outsiderAuth } as never),
    ).rejects.toThrow('NOT_TOKEN_OWNER');
    expect(docs.has(`${TRANSFER_INVITES}/x`)).toBe(false);
    expect(writeCount).toBe(0);
  });

  it('refuses a bad phone number, a bad token id and an unauthenticated caller', async () => {
    await expect(
      create({ data: { tokenId: '7', phoneE164: '01012345678' }, auth: senderAuth } as never),
    ).rejects.toThrow('BAD_PHONE');
    await expect(
      create({ data: { tokenId: '0x7', phoneE164: PHONE }, auth: senderAuth } as never),
    ).rejects.toThrow('BAD_TOKEN_ID');
    await expect(create({ data: { phoneE164: PHONE }, auth: senderAuth } as never)).rejects.toThrow(
      'BAD_TOKEN_ID',
    );
    await expect(create({ data: { tokenId: '7', phoneE164: PHONE } } as never)).rejects.toThrow(
      'AUTH_REQUIRED',
    );
    expect(writeCount).toBe(0);
  });

  it('refuses an invite the caller addressed to their own number', async () => {
    await expect(
      create({ data: { tokenId: '7', phoneE164: SENDER_PHONE }, auth: senderAuth } as never),
    ).rejects.toThrow('SELF_TRANSFER');
    expect(writeCount).toBe(0);
  });

  it('refuses a token whose open offer is addressed to somebody else', async () => {
    chain.offers.set('7', {
      from: OWNER,
      recipientCommitment: recipientCommitment(hmacPhone('+821055556666', KEY)),
      expiresAt: BigInt(Math.floor(Date.now() / 1000) + 600),
    });

    await expect(
      create({ data: { tokenId: '7', phoneE164: PHONE }, auth: senderAuth } as never),
    ).rejects.toThrow('OFFER_ALREADY_OPEN');
    expect(writeCount).toBe(0);
  });

  it('adds one identity-verification sentence when the event requires it', async () => {
    chain.requireKyc = true;

    const { smsText } = await givenInvite();

    expect(smsText).toContain('가입 후 본인인증이 필요해요.');
    // 조건의 원본은 공연 메타다 — `eventOf` 가 돌려준 id 로 `eventMeta` 를 읽어야 한다.
    expect(reads.map((r) => r.functionName)).toContain('eventOf');
    expect(reads.find((r) => r.functionName === 'eventMeta')?.args).toEqual([EVENT_ID]);
  });

  it('leaves the sentence out when the event does not require identity verification', async () => {
    const { smsText } = await givenInvite();

    expect(smsText).not.toContain('본인인증');
    expect(smsText.toLowerCase()).not.toContain('verify');
  });

  it('writes the identity-verification sentence in the sender locale', async () => {
    chain.requireKyc = true;
    givenUser('uid-sender', SENDER_PHONE, 'en');

    const { smsText } = await givenInvite();

    expect(smsText).toContain("You'll need to verify your identity after signing up.");
    expect(/[가-힣]/.test(smsText)).toBe(false);
  });

  it('keeps crypto vocabulary out of the identity-verification sentence too', async () => {
    chain.requireKyc = true;
    const korean = (await givenInvite()).smsText;
    givenUser('uid-sender', SENDER_PHONE, 'en');
    const english = (await givenInvite()).smsText;

    for (const word of BANNED_ATTENDEE_WORDS) {
      expect(korean.toLowerCase()).not.toContain(word.toLowerCase());
      expect(english.toLowerCase()).not.toContain(word.toLowerCase());
    }
  });

  it('lets the sender re-send the same invite while their own offer is still open', async () => {
    const first = await givenInvite();
    const again = (await create({
      data: { tokenId: '7', phoneE164: PHONE },
      auth: senderAuth,
    } as never)) as InviteResult;

    expect(again.commitment).toBe(first.commitment);
    expect(again.inviteId).not.toBe(first.inviteId);
  });
});

/**
 * 손으로 적은 타입은 컨트랙트가 바뀌어도 조용히 통과한다 — `ChainEventMeta` 가 `as` 캐스트였던
 * 시절의 구멍이다. 이제 반환 구조체 타입은 아래 조각에서 **컴파일러가** 만들지만, 조각 자체가
 * 원본과 어긋나면 다시 같은 구멍이 된다. 그것을 막는 것이 이 테스트 하나다.
 */
describe('eventMeta ABI 조각', () => {
  it('is a verbatim copy of the eventMeta entry in the real Ticket ABI', () => {
    const real = (ticketAbi as unknown[]).filter(
      (entry) => (entry as { type?: string; name?: string }).type === 'function' &&
        (entry as { name?: string }).name === 'eventMeta',
    );

    expect(real).toHaveLength(1);
    expect(eventMetaAbi).toEqual(real);
  });

  it('keeps requireKyc — the one field this file reads — last in the 16-field tuple', () => {
    const components = eventMetaAbi[0].outputs[0].components;
    expect(components).toHaveLength(16);
    expect(components.at(-1)).toEqual({ name: 'requireKyc', type: 'bool', internalType: 'bool' });
  });
});

describe('pendingOffers', () => {
  it('returns an attester signature that recovers over the raw digest for the caller account', async () => {
    const invite = await givenInvite();

    const result = (await pending({ data: {}, auth: recipientAuth } as never)) as {
      offers: Array<{ tokenId: string; attesterSig: Hex; inviteId: string }>;
    };

    expect(result.offers).toHaveLength(1);
    expect(result.offers[0]?.tokenId).toBe('7');
    expect(result.offers[0]?.inviteId).toBe(invite.inviteId);

    // Ticket.acceptOffer 가 검증하는 값 그대로: EIP-712 `TransferApproval`, 도메인에
    // chainId 와 Ticket 주소가 들어간다(`Ticket.offerDigest(...)` 와 같은 값이어야 한다).
    const digest = offerDigest({
      chainId: CHAIN_ID,
      ticket: TICKET,
      tokenId: 7n,
      recipientCommitment: invite.commitment,
      recipientAccount: RECIPIENT,
    });
    // 다이제스트를 못으로 박는다. 테스트가 같은 함수로 기대값을 다시 계산하기만 하면
    // 모양이 바뀌어도 양쪽이 함께 따라가 조용히 통과한다 — 이 한 줄이 그 길을 막는다.
    expect(digest).toBe(PINNED_DIGEST);
    const signature = result.offers[0]?.attesterSig as Hex;
    expect(await recoverAddress({ hash: PINNED_DIGEST, signature })).toBe(attester.address);
    // EIP-191 접두사가 붙으면 컨트랙트의 ECDSA.recover 가 다른 주소를 얻는다.
    expect(await recoverAddress({ hash: hashMessage({ raw: digest }), signature })).not.toBe(
      attester.address,
    );
    // 도메인이 정말 묶여 있다 — 체인이나 Ticket 주소가 다르면 같은 서명이 어테스터를 내놓지 않는다.
    // 옛 배포본에 대고 만든 서명이 새 Ticket 에서 죽는 이유가 이것이다.
    for (const strayedDomain of [
      { chainId: CHAIN_ID + 1, ticket: TICKET as Hex },
      { chainId: CHAIN_ID, ticket: OTHER_TICKET },
    ]) {
      const strayed = offerDigest({
        ...strayedDomain,
        tokenId: 7n,
        recipientCommitment: invite.commitment,
        recipientAccount: RECIPIENT,
      });
      expect(strayed).not.toBe(digest);
      expect(await recoverAddress({ hash: strayed, signature })).not.toBe(attester.address);
    }
  });

  it('signs for the caller account, so another account cannot reuse the signature', async () => {
    const invite = await givenInvite();
    const result = (await pending({ data: {}, auth: recipientAuth } as never)) as {
      offers: Array<{ attesterSig: Hex }>;
    };

    const otherDigest = offerDigest({
      chainId: CHAIN_ID,
      ticket: TICKET,
      tokenId: 7n,
      recipientCommitment: invite.commitment,
      recipientAccount: OUTSIDER,
    });
    expect(
      await recoverAddress({ hash: otherDigest, signature: result.offers[0]?.attesterSig as Hex }),
    ).not.toBe(attester.address);
  });

  it('writes nothing and leaks neither the phone index nor the sender', async () => {
    const invite = await givenInvite();
    const result = await pending({ data: {}, auth: recipientAuth } as never);

    expect(writeCount).toBe(0);
    expect(snapshot(`${TRANSFER_INVITES}/${invite.inviteId}`).get('status')).toBe('sent');
    expect(Object.keys(result.offers[0] ?? {}).sort()).toEqual(['attesterSig', 'inviteId', 'tokenId']);
    const payload = JSON.stringify(result);
    expect(payload).not.toContain(hmacPhone(PHONE, KEY));
    expect(payload).not.toContain(OWNER);
  });

  it('skips an invite whose chain offer carries a different commitment', async () => {
    await givenInvite();
    chain.offers.set('7', {
      from: OWNER,
      recipientCommitment: recipientCommitment(hmacPhone('+821055556666', KEY)),
      expiresAt: BigInt(Math.floor(Date.now() / 1000) + 600),
    });

    const result = (await pending({ data: {}, auth: recipientAuth } as never)) as { offers: unknown[] };
    expect(result.offers).toEqual([]);
  });

  it('skips an invite with no offer on chain at all', async () => {
    await givenInvite();
    chain.offers.clear();

    const result = (await pending({ data: {}, auth: recipientAuth } as never)) as { offers: unknown[] };
    expect(result.offers).toEqual([]);
  });

  it('skips an expired invite and an offer the chain already expired', async () => {
    const invite = await givenInvite();
    const stored = docs.get(`${TRANSFER_INVITES}/${invite.inviteId}`) as Record<string, unknown>;
    stored.expiresAt = Math.floor(Date.now() / 1000) - 1;

    expect(((await pending({ data: {}, auth: recipientAuth } as never)) as { offers: unknown[] }).offers)
      .toEqual([]);

    stored.expiresAt = Math.floor(Date.now() / 1000) + 600;
    chain.offers.set('7', {
      from: OWNER,
      recipientCommitment: invite.commitment,
      expiresAt: BigInt(Math.floor(Date.now() / 1000) - 1),
    });
    expect(((await pending({ data: {}, auth: recipientAuth } as never)) as { offers: unknown[] }).offers)
      .toEqual([]);
  });

  it('skips an invite that is no longer open', async () => {
    const invite = await givenInvite();
    (docs.get(`${TRANSFER_INVITES}/${invite.inviteId}`) as Record<string, unknown>).status = 'accepted';

    const result = (await pending({ data: {}, auth: recipientAuth } as never)) as { offers: unknown[] };
    expect(result.offers).toEqual([]);
  });

  it('returns every open invite for the caller, one entry per ticket', async () => {
    await givenInvite(PHONE, '7');
    await givenInvite(PHONE, '8');
    // 같은 티켓을 같은 번호로 한 번 더 보낸 초대. 받는 사람에게 티켓은 하나로 보여야 한다.
    await givenInvite(PHONE, '7');

    const result = (await pending({ data: {}, auth: recipientAuth } as never)) as {
      offers: Array<{ tokenId: string }>;
    };
    expect(result.offers.map((o) => o.tokenId).sort()).toEqual(['7', '8']);
  });

  it('returns nothing for a phone with no invite', async () => {
    givenUser('uid-stranger', '+821099990000');
    await givenInvite();

    const result = (await pending({
      data: {},
      auth: { uid: 'uid-stranger', token: { account: OUTSIDER } },
    } as never)) as { offers: unknown[] };
    expect(result.offers).toEqual([]);
  });

  it('refuses a caller whose user doc has no phone index, and an unauthenticated caller', async () => {
    givenUser('uid-nophone', null);
    await expect(
      pending({ data: {}, auth: { uid: 'uid-nophone', token: { account: OUTSIDER } } } as never),
    ).rejects.toThrow('PHONE_INDEX_MISSING');
    await expect(pending({ data: {} } as never)).rejects.toThrow('AUTH_REQUIRED');
  });
});
