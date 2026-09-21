import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ticketAbi } from '@monti/shared';
import { decodeFunctionData, encodeAbiParameters, type AbiFunction } from 'viem';
import { TestHelpers } from 'generated';

const { Ticket, MockDb } = TestHelpers;
type MockDbT = ReturnType<typeof MockDb.createMockDb>;

// 체크섬 대문자를 일부러 섞는다 — 저장되는 주소는 전부 소문자여야 한다.
const ALICE = `0x${'Aa'.repeat(20)}`;
const alice = ALICE.toLowerCase();
const BOB = `0x${'Bb'.repeat(20)}`;
const bob = BOB.toLowerCase();
const CAROL = `0x${'Cc'.repeat(20)}`;
const carol = CAROL.toLowerCase();
const ZERO = `0x${'00'.repeat(20)}`;
const ZERO32 = `0x${'00'.repeat(32)}`;

const TITLE = `0x${'11'.repeat(32)}`;
const DESC = `0x${'22'.repeat(32)}`;
const VENUE = `0x${'33'.repeat(32)}`;
const REGION = `0x${'44'.repeat(32)}`;
const NONCE = `0x${'55'.repeat(32)}`;
const COMMIT = `0x${'cc'.repeat(32)}`;
const TX = `0x${'ab'.repeat(32)}`;
const OTHER_TX = `0x${'cd'.repeat(32)}`;

const T0 = 1_789_862_400;
const BLOCK = 64_400_000;

const EVENT_ID = 11n;
const TOKEN = 7n;

/** Ticket.eventMeta(eventId) 가 돌려주는 튜플. 스텁이 그대로 인코딩한다. */
const META = {
  orgId: 5n,
  titleHash: TITLE,
  descHash: DESC,
  imageCid: 'bafkreigh2akiscaildcaildcaildcaildcaildcaildcaildcaildcaild',
  startsAt: 1_789_900_000n,
  endsAt: 1_789_903_600n,
  venueHash: VENUE,
  saleStart: 1_789_000_000n,
  saleEnd: 1_789_800_000n,
  transferable: true,
  transferCutoffSeconds: 3600,
  maxTransfers: 2,
  approvalRequired: false,
  category: 1,
  regionCode: REGION,
  requireKyc: true,
};

const TIERS = [
  { name: '일반', priceUsdCents: 0n, supply: 100, minted: 0, maxPerWallet: 2, seated: false },
  { name: 'VIP', priceUsdCents: 0n, supply: 10, minted: 0, maxPerWallet: 1, seated: true },
];

/** 스텁이 다음에 돌려줄 값. 테스트가 갈아 끼운다. */
let metaReply: Record<string, unknown> = META;
let tiersReply: readonly Record<string, unknown>[] = TIERS;
/** 마지막 eth_call 이 어느 블록을 물었는지. `'latest'` 면 고정에 실패한 것이다. */
let lastBlockTag: unknown;

function outputsOf(name: string): AbiFunction['outputs'] {
  const item = (ticketAbi as readonly AbiFunction[]).find(
    (entry) => entry.type === 'function' && entry.name === name,
  );
  if (!item) throw new Error(`NO_ABI_FUNCTION:${name}`);
  return item.outputs;
}

/**
 * 로컬 eth_call 스텁.
 *
 * 핸들러의 `readContract` 는 실제 viem 디코드를 거친다 — 튜플 순서가 어긋나면
 * (01b 델타 §5 가 경고하는 바로 그 사고) 이 테스트들이 값으로 잡는다.
 */
let server: Server;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const rpc = JSON.parse(body) as { id: number; params: [{ data: `0x${string}` }, unknown] };
      lastBlockTag = rpc.params[1];
      const { functionName } = decodeFunctionData({ abi: ticketAbi, data: rpc.params[0].data });
      const value = functionName === 'eventMeta' ? metaReply : tiersReply;
      const result = encodeAbiParameters(outputsOf(functionName), [value]);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('NO_PORT');
  // 핸들러는 RPC 클라이언트를 **처음 쓸 때** 만든다. 그래서 여기서 물릴 수 있다.
  process.env.RPC_URL = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

const at = (hash: string, logIndex = 0, timestamp = T0) => ({
  mockEventData: { block: { number: BLOCK, timestamp }, transaction: { hash }, logIndex },
});

/** createEvent 한 건: EventCreated → EventStatusChanged(0) 가 한 트랜잭션에 온다. */
async function created(): Promise<MockDbT> {
  const mockDb = await Ticket.EventCreated.processEvent({
    event: Ticket.EventCreated.createMockEvent({
      eventId: EVENT_ID,
      orgId: 5n,
      creator: ALICE,
      ...at(TX, 0),
    }),
    mockDb: MockDb.createMockDb(),
  });
  return Ticket.EventStatusChanged.processEvent({
    event: Ticket.EventStatusChanged.createMockEvent({
      eventId: EVENT_ID,
      status: 0n,
      ...at(TX, 1),
    }),
    mockDb,
  });
}

/** claim 한 건: _safeMint 의 Transfer(0→to) 가 Claimed 보다 **먼저** 온다. */
async function claimed(mockDb: MockDbT, tier = 0n): Promise<MockDbT> {
  const afterMint = await Ticket.Transfer.processEvent({
    event: Ticket.Transfer.createMockEvent({ from: ZERO, to: ALICE, tokenId: TOKEN, ...at(TX, 0) }),
    mockDb,
  });
  return Ticket.Claimed.processEvent({
    event: Ticket.Claimed.createMockEvent({
      tokenId: TOKEN,
      eventId: EVENT_ID,
      to: ALICE,
      tier,
      ...at(TX, 1),
    }),
    mockDb: afterMint,
  });
}

describe('Ticket handlers — events and tiers', () => {
  it('reads the rest of the event and its tiers from the contract on EventCreated', async () => {
    const after = await created();

    expect(after.entities.Event.get('11')).toEqual({
      id: '11',
      orgId: 5n,
      creator: alice,
      titleHash: TITLE,
      descHash: DESC,
      imageCid: META.imageCid,
      startsAt: 1_789_900_000n,
      endsAt: 1_789_903_600n,
      venueHash: VENUE,
      saleStart: 1_789_000_000n,
      saleEnd: 1_789_800_000n,
      transferable: true,
      transferCutoffSeconds: 3600n,
      maxTransfers: 2,
      approvalRequired: false,
      category: 1,
      regionCode: REGION,
      requireKyc: true,
      status: 'Draft',
    });
    expect(after.entities.Tier.get('11-0')).toEqual({
      id: '11-0',
      eventId: EVENT_ID,
      idx: 0,
      name: '일반',
      priceUsdCents: 0n,
      supply: 100n,
      minted: 0n,
      maxPerWallet: 2n,
      seated: false,
    });
    expect(after.entities.Tier.get('11-1')?.name).toBe('VIP');
    // 읽기는 그 이벤트가 난 블록에 고정돼 있어야 한다 — 'latest' 면 재생마다 답이 달라진다.
    expect(lastBlockTag).toBe(`0x${BLOCK.toString(16)}`);
  });

  it('replaces meta and tiers on EventMetaUpdated and drops the tiers that went away', async () => {
    const mockDb = await created();
    metaReply = { ...META, imageCid: 'bafkrenewcid', requireKyc: false };
    tiersReply = [{ ...TIERS[0], name: '단일', supply: 50 }];
    try {
      const after = await Ticket.EventMetaUpdated.processEvent({
        event: Ticket.EventMetaUpdated.createMockEvent({ eventId: EVENT_ID, ...at(OTHER_TX) }),
        mockDb,
      });
      expect(after.entities.Event.get('11')).toMatchObject({
        imageCid: 'bafkrenewcid',
        requireKyc: false,
        orgId: 5n,
        creator: alice,
        status: 'Draft',
      });
      expect(after.entities.Tier.get('11-0')).toMatchObject({ name: '단일', supply: 50n });
      expect(after.entities.Tier.get('11-1')).toBeUndefined();
    } finally {
      metaReply = META;
      tiersReply = TIERS;
    }
  });

  it('maps EventStatusChanged codes to names and never throws on an unknown one', async () => {
    let mockDb = await created();
    expect(mockDb.entities.Event.get('11')?.status).toBe('Draft');

    mockDb = await Ticket.EventStatusChanged.processEvent({
      event: Ticket.EventStatusChanged.createMockEvent({ eventId: EVENT_ID, status: 1n }),
      mockDb,
    });
    expect(mockDb.entities.Event.get('11')?.status).toBe('Published');

    mockDb = await Ticket.EventStatusChanged.processEvent({
      event: Ticket.EventStatusChanged.createMockEvent({ eventId: EVENT_ID, status: 2n }),
      mockDb,
    });
    expect(mockDb.entities.Event.get('11')?.status).toBe('Cancelled');

    const after = await Ticket.EventStatusChanged.processEvent({
      event: Ticket.EventStatusChanged.createMockEvent({ eventId: EVENT_ID, status: 9n }),
      mockDb,
    });
    expect(after.entities.Event.get('11')?.status).toBe('Cancelled');
  });

  it('ignores EventStatusChanged for an event it never saw', async () => {
    const after = await Ticket.EventStatusChanged.processEvent({
      event: Ticket.EventStatusChanged.createMockEvent({ eventId: 404n, status: 1n }),
      mockDb: MockDb.createMockDb(),
    });
    expect(after.entities.Event.get('404')).toBeUndefined();
  });
});

describe('Ticket handlers — tickets', () => {
  it('creates a ticket on Claimed and counts it against the tier', async () => {
    const after = await claimed(await created());

    expect(after.entities.Ticket.get('7')).toEqual({
      id: '7',
      eventId: EVENT_ID,
      tier: 0,
      owner: alice,
      transfers: 0,
      revoked: false,
      checkIn_id: undefined,
      identity_id: alice,
    });
    expect(after.entities.Tier.get('11-0')?.minted).toBe(1n);
    expect(after.entities.Tier.get('11-1')?.minted).toBe(0n);
  });

  /**
   * 재싱크(Task 38)는 이미 팔린 공연을 처음부터 다시 재생한다. 그때 체인의 `minted`
   * 는 벌써 올라가 있으므로, 그 값을 씨앗으로 놓으면 재생되는 `Claimed` 가 한 번 더
   * 세어 두 배가 된다. 씨앗은 0 이고 오직 `Claimed` 가 센다 — 스텁이 5 를 돌려줘도
   * claim 두 건이면 답은 2 다.
   */
  it('counts tier mints only from Claimed, ignoring the chain counter on a replay', async () => {
    tiersReply = [{ ...TIERS[0], minted: 5 }, TIERS[1]];
    try {
      let mockDb = await created();
      expect(mockDb.entities.Tier.get('11-0')?.minted).toBe(0n);

      mockDb = await claimed(mockDb);
      mockDb = await Ticket.Claimed.processEvent({
        event: Ticket.Claimed.createMockEvent({
          tokenId: 8n,
          eventId: EVENT_ID,
          to: BOB,
          tier: 0n,
          ...at(OTHER_TX, 1),
        }),
        mockDb,
      });
      expect(mockDb.entities.Tier.get('11-0')?.minted).toBe(2n);
    } finally {
      tiersReply = TIERS;
    }
  });

  it('counts a real transfer but not the mint, and re-links the identity', async () => {
    const minted = await claimed(await created());
    expect(minted.entities.Ticket.get('7')?.transfers).toBe(0);

    const after = await Ticket.Transfer.processEvent({
      event: Ticket.Transfer.createMockEvent({
        from: ALICE,
        to: BOB,
        tokenId: TOKEN,
        ...at(OTHER_TX),
      }),
      mockDb: minted,
    });
    expect(after.entities.Ticket.get('7')).toMatchObject({
      owner: bob,
      identity_id: bob,
      transfers: 1,
    });
  });

  it('ignores a Transfer for a token it never saw', async () => {
    const after = await Ticket.Transfer.processEvent({
      event: Ticket.Transfer.createMockEvent({ from: ALICE, to: BOB, tokenId: 404n }),
      mockDb: MockDb.createMockDb(),
    });
    expect(after.entities.Ticket.get('404')).toBeUndefined();
  });

  it('revokes a ticket and ignores a Revoked for a token it never saw', async () => {
    const after = await Ticket.Revoked.processEvent({
      event: Ticket.Revoked.createMockEvent({ tokenId: TOKEN, reason: 1n }),
      mockDb: await claimed(await created()),
    });
    expect(after.entities.Ticket.get('7')?.revoked).toBe(true);

    const unknown = await Ticket.Revoked.processEvent({
      event: Ticket.Revoked.createMockEvent({ tokenId: 404n, reason: 1n }),
      mockDb: MockDb.createMockDb(),
    });
    expect(unknown.entities.Ticket.get('404')).toBeUndefined();
  });

  it('moves a migrated ticket without counting the transfer it rides on', async () => {
    let mockDb = await claimed(await created());
    mockDb = await Ticket.Transfer.processEvent({
      event: Ticket.Transfer.createMockEvent({
        from: ALICE,
        to: BOB,
        tokenId: TOKEN,
        ...at(OTHER_TX),
      }),
      mockDb,
    });
    expect(mockDb.entities.Ticket.get('7')?.transfers).toBe(1);

    // migrate() 는 _internalMove 라 체인의 _transfers 를 올리지 않는다.
    // 인덱서에는 같은 트랜잭션의 Transfer 가 먼저 와서 이미 +1 한 상태다.
    const migrateTx = `0x${'ef'.repeat(32)}`;
    mockDb = await Ticket.Transfer.processEvent({
      event: Ticket.Transfer.createMockEvent({
        from: BOB,
        to: CAROL,
        tokenId: TOKEN,
        ...at(migrateTx, 0),
      }),
      mockDb,
    });
    const after = await Ticket.Migrated.processEvent({
      event: Ticket.Migrated.createMockEvent({
        tokenId: TOKEN,
        from: BOB,
        to: CAROL,
        ...at(migrateTx, 1),
      }),
      mockDb,
    });
    expect(after.entities.Ticket.get('7')).toMatchObject({
      owner: carol,
      identity_id: carol,
      transfers: 1,
    });
  });

  /**
   * 짝이 되는 `Transfer` 를 못 본 채로 온 `Migrated` 는 양도 수를 **깎지 않는다**.
   * 깎으면 체인보다 하나 적은 수가 조용히 남는다.
   */
  it('does not give back a transfer when the paired Transfer never arrived', async () => {
    let mockDb = await claimed(await created());
    mockDb = await Ticket.Transfer.processEvent({
      event: Ticket.Transfer.createMockEvent({
        from: ALICE,
        to: BOB,
        tokenId: TOKEN,
        ...at(OTHER_TX),
      }),
      mockDb,
    });

    const after = await Ticket.Migrated.processEvent({
      event: Ticket.Migrated.createMockEvent({
        tokenId: TOKEN,
        from: BOB,
        to: CAROL,
        ...at(`0x${'ef'.repeat(32)}`, 1),
      }),
      mockDb,
    });
    expect(after.entities.Ticket.get('7')).toMatchObject({
      owner: carol,
      identity_id: carol,
      transfers: 1,
    });
  });
});

describe('Ticket handlers — check-ins and overrides', () => {
  it('records a CheckIn keyed by tokenId with tx hash and block', async () => {
    const after = await Ticket.CheckedIn.processEvent({
      event: Ticket.CheckedIn.createMockEvent({
        tokenId: TOKEN,
        eventId: EVENT_ID,
        gateId: 3n,
        nonceHash: NONCE,
        ts: BigInt(T0),
        ...at(TX),
      }),
      mockDb: await claimed(await created()),
    });

    expect(after.entities.CheckIn.get('7')).toEqual({
      id: '7',
      gateId: 3n,
      ts: BigInt(T0),
      nonceHash: NONCE,
      manual: false,
      late: false,
      txHash: TX,
      block: BigInt(BLOCK),
    });
    expect(after.entities.Ticket.get('7')?.checkIn_id).toBe('7');
  });

  it('keeps manual true when ManualOverride and CheckedIn share a transaction', async () => {
    let mockDb = await claimed(await created());
    mockDb = await Ticket.ManualOverride.processEvent({
      event: Ticket.ManualOverride.createMockEvent({
        tokenId: TOKEN,
        gateId: 3n,
        approver: BOB,
        role: 1n,
        reason: 2n,
        ...at(TX, 4),
      }),
      mockDb,
    });

    expect(mockDb.entities.Override.get(`${TX}-4`)).toEqual({
      id: `${TX}-4`,
      tokenId: TOKEN,
      gateId: 3n,
      approver: bob,
      role: 1,
      reason: 2,
      requested: false,
    });
    expect(mockDb.entities.CheckIn.get('7')).toMatchObject({ manual: true, nonceHash: ZERO32 });

    // manualOverride 는 같은 트랜잭션에서 CheckedIn 도 낸다(Ticket.sol:427).
    const after = await Ticket.CheckedIn.processEvent({
      event: Ticket.CheckedIn.createMockEvent({
        tokenId: TOKEN,
        eventId: EVENT_ID,
        gateId: 3n,
        nonceHash: ZERO32,
        ts: BigInt(T0),
        ...at(TX, 5),
      }),
      mockDb,
    });
    expect(after.entities.CheckIn.get('7')).toMatchObject({ manual: true, late: false });
    expect(after.entities.Ticket.get('7')?.checkIn_id).toBe('7');
  });

  it('keeps late true only when it came from the same transaction', async () => {
    // 01b 의 CheckedInLate 가 CheckedIn 보다 먼저 와서 남긴 행을 흉내 낸다.
    // (목 DB 의 set 은 **새 DB 를 돌려준다** — 제자리에서 고치지 않는다.)
    const base = await claimed(await created());
    const seeded = base.entities.CheckIn.set({
      id: '7',
      gateId: 3n,
      ts: BigInt(T0),
      nonceHash: ZERO32,
      manual: false,
      late: true,
      txHash: TX,
      block: BigInt(BLOCK),
    });

    const sameTx = await Ticket.CheckedIn.processEvent({
      event: Ticket.CheckedIn.createMockEvent({
        tokenId: TOKEN,
        eventId: EVENT_ID,
        gateId: 3n,
        nonceHash: NONCE,
        ts: BigInt(T0),
        ...at(TX, 1),
      }),
      mockDb: seeded,
    });
    expect(sameTx.entities.CheckIn.get('7')).toMatchObject({ late: true, nonceHash: NONCE });

    const otherTx = await Ticket.CheckedIn.processEvent({
      event: Ticket.CheckedIn.createMockEvent({
        tokenId: TOKEN,
        eventId: EVENT_ID,
        gateId: 3n,
        nonceHash: NONCE,
        ts: BigInt(T0),
        ...at(OTHER_TX, 1),
      }),
      mockDb: seeded,
    });
    expect(otherTx.entities.CheckIn.get('7')?.late).toBe(false);
  });

  it('writes a requested Override on OverrideRequested', async () => {
    const after = await Ticket.OverrideRequested.processEvent({
      event: Ticket.OverrideRequested.createMockEvent({
        tokenId: TOKEN,
        gateId: 3n,
        requester: BOB,
        reason: 2n,
        ...at(TX, 9),
      }),
      mockDb: MockDb.createMockDb(),
    });

    expect(after.entities.Override.get(`${TX}-9`)).toEqual({
      id: `${TX}-9`,
      tokenId: TOKEN,
      gateId: 3n,
      approver: bob,
      role: 0,
      reason: 2,
      requested: true,
    });
    // 요청은 입장이 아니다 — CheckIn 을 만들지 않는다.
    expect(after.entities.CheckIn.get('7')).toBeUndefined();
  });
});

describe('Ticket handlers — offers', () => {
  async function offered(): Promise<MockDbT> {
    return Ticket.OfferCreated.processEvent({
      event: Ticket.OfferCreated.createMockEvent({
        tokenId: TOKEN,
        from: ALICE,
        recipientCommitment: COMMIT,
        expiresAt: BigInt(T0),
        ...at(TX),
      }),
      mockDb: await claimed(await created()),
    });
  }

  it('tracks an offer through open → accepted', async () => {
    const mockDb = await offered();
    expect(mockDb.entities.Offer.get('7')).toEqual({
      id: '7',
      from: alice,
      commitment: COMMIT,
      expiresAt: BigInt(T0),
      status: 'open',
    });

    // OfferAccepted(tokenId, from, to) — 커밋먼트를 싣지 않는다. tokenId 로만 잇는다.
    const after = await Ticket.OfferAccepted.processEvent({
      event: Ticket.OfferAccepted.createMockEvent({
        tokenId: TOKEN,
        from: ALICE,
        to: BOB,
        ...at(OTHER_TX),
      }),
      mockDb,
    });
    expect(after.entities.Offer.get('7')?.status).toBe('accepted');
  });

  it('closes an offer on OfferCancelled and ignores an offer it never saw', async () => {
    const after = await Ticket.OfferCancelled.processEvent({
      event: Ticket.OfferCancelled.createMockEvent({ tokenId: TOKEN, ...at(OTHER_TX) }),
      mockDb: await offered(),
    });
    expect(after.entities.Offer.get('7')?.status).toBe('cancelled');

    const unknown = await Ticket.OfferCancelled.processEvent({
      event: Ticket.OfferCancelled.createMockEvent({ tokenId: 404n }),
      mockDb: MockDb.createMockDb(),
    });
    expect(unknown.entities.Offer.get('404')).toBeUndefined();
  });
});
