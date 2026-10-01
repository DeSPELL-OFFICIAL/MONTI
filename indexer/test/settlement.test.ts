import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeFunctionData, encodeAbiParameters, type Abi, type AbiFunction } from 'viem';
import { TestHelpers } from 'generated';
// 핸들러가 getPolicy 를 부를 때 쓰는 **같은** 벤더 ABI 다.
import settlementAbiJson from '../src/vendored/settlement-vault-abi.json';

const settlementAbi = settlementAbiJson.abi as unknown as Abi;

// 금고가 아직 config.yaml 에 없으면(배포 전 → codegen 에 SettlementVault 없음) 이 스위트는
// 통째로 건너뛴다 — codegen·tsc·test 가 그대로 green 이다. 배포 + 재생성 뒤 codegen 이
// SettlementVault 를 내면 그때 실제로 돌며 아래 단언들이 핸들러를 값으로 검증한다.
const SettlementVault = (TestHelpers as Record<string, any>).SettlementVault;
const { MockDb } = TestHelpers;

// 체크섬 대문자를 일부러 섞는다 — 저장되는 주소 id·필드는 전부 소문자여야 한다.
const RECIP_A = `0x${'Aa'.repeat(20)}`;
const recipA = RECIP_A.toLowerCase();
const RECIP_B = `0x${'Bb'.repeat(20)}`;
const recipB = RECIP_B.toLowerCase();
const ORG = `0x${'0f'.repeat(20)}`;
const org = ORG.toLowerCase();
const PAYER = `0x${'Ad'.repeat(20)}`;
const payer = PAYER.toLowerCase();
const USDC = `0x${'11'.repeat(20)}`;
const usdc = USDC.toLowerCase();

const POLICY_HASH = `0x${'ab'.repeat(32)}`;
const REASON_A = `0x${'a1'.repeat(32)}`;
const REASON_B = `0x${'b2'.repeat(32)}`;
const TAG_ARTIST = `0x${Buffer.from('artist').toString('hex').padEnd(64, '0')}`;
const TAG_PLATFORM = `0x${Buffer.from('platform').toString('hex').padEnd(64, '0')}`;
const TX = `0x${'cc'.repeat(32)}`;
const TX2 = `0x${'dd'.repeat(32)}`;

const EVENT_ID = 42n;
const T0 = 1_790_000_000;
const BLOCK = 67_300_000;

// getPolicy 스텁이 돌려줄 정책(90/10, 노쇼는 수취인 분배).
const POLICY = {
  // 소문자 주소다 — viem 의 encodeAbiParameters 가 믹스드케이스는 체크섬으로 거르기 때문.
  // 핸들러는 어차피 소문자로 저장하므로(addr) 아래 단언과도 맞는다.
  recipients: [
    { account: recipA, bps: 9000, reasonHash: REASON_A, tag: TAG_ARTIST },
    { account: recipB, bps: 1000, reasonHash: REASON_B, tag: TAG_PLATFORM },
  ],
  platformBps: 1000,
  reserveBps: 0,
  noShowRefund: false,
  frozen: true,
  version: 1,
};

function outputsOf(name: string): AbiFunction['outputs'] {
  const item = (settlementAbi as readonly AbiFunction[]).find(
    (entry) => entry.type === 'function' && entry.name === name,
  );
  if (!item) throw new Error(`NO_ABI_FUNCTION:${name}`);
  return item.outputs;
}

const at = (hash: string, logIndex = 0, timestamp = T0) => ({
  mockEventData: { block: { number: BLOCK, timestamp }, transaction: { hash }, logIndex },
});

describe.skipIf(!SettlementVault)('SettlementVault handlers', () => {
  // getPolicy 만 응답하는 로컬 eth_call 스텁. 핸들러의 readContract 가 진짜 viem 디코드를
  // 거치므로, SplitPolicy 튜플 순서가 어긋나면 이 테스트가 값으로 잡는다.
  let server: Server;
  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        const rpc = JSON.parse(body) as { id: number; params: [{ data: `0x${string}` }, unknown] };
        const { functionName } = decodeFunctionData({ abi: settlementAbi, data: rpc.params[0].data });
        const result = encodeAbiParameters(outputsOf(functionName), [POLICY]);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('NO_PORT');
    process.env.RPC_URL = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it('PolicySet stores the header and reads the recipient split from getPolicy', async () => {
    const after = await SettlementVault.PolicySet.processEvent({
      event: SettlementVault.PolicySet.createMockEvent({
        eventId: EVENT_ID,
        organizer: ORG,
        policyHash: POLICY_HASH,
        version: 1n,
        ...at(TX),
      }),
      mockDb: MockDb.createMockDb(),
    });
    const policy = after.entities.SettlementPolicy.get(EVENT_ID.toString());
    expect(policy).toBeDefined();
    expect(policy?.organizer).toBe(org);
    expect(policy?.policyHash).toBe(POLICY_HASH);
    expect(policy?.version).toBe(1);
    expect(policy?.platformBps).toBe(1000);
    expect(policy?.reserveBps).toBe(0);
    expect(policy?.noShowRefund).toBe(false);
    expect(policy?.txHash).toBe(TX);
    const recipients = JSON.parse(policy?.recipients ?? '[]');
    expect(recipients).toEqual([
      { account: recipA, bps: 9000, reasonHash: REASON_A, tag: TAG_ARTIST },
      { account: recipB, bps: 1000, reasonHash: REASON_B, tag: TAG_PLATFORM },
    ]);
    // 집계 행이 먼저 세워진다.
    expect(after.entities.EventSettlement.get(EVENT_ID.toString())).toBeDefined();
  });

  it('Deposited opens a Held escrow with lowercase addresses and 6-decimal amount', async () => {
    const after = await SettlementVault.Deposited.processEvent({
      event: SettlementVault.Deposited.createMockEvent({
        eventId: EVENT_ID,
        tokenId: 7n,
        token: USDC,
        amount: 10_000_000n, // 10 USDC
        payer: PAYER,
        ...at(TX),
      }),
      mockDb: MockDb.createMockDb(),
    });
    const escrow = after.entities.Escrow.get('7');
    expect(escrow).toEqual({
      id: '7',
      eventId: EVENT_ID,
      token: usdc,
      amount: 10_000_000n,
      payer,
      status: 'Deposited',
      depositedAt: BigInt(T0),
      releasedAt: undefined,
      depositTxHash: TX,
      settleTxHash: undefined,
    });
    expect(after.entities.EventSettlement.get(EVENT_ID.toString())?.totalDeposited).toBe(10_000_000n);
  });

  it('Released moves the escrow to Released and stamps the settle tx', async () => {
    let db = await SettlementVault.Deposited.processEvent({
      event: SettlementVault.Deposited.createMockEvent({
        eventId: EVENT_ID, tokenId: 7n, token: USDC, amount: 10_000_000n, payer: PAYER, ...at(TX),
      }),
      mockDb: MockDb.createMockDb(),
    });
    db = await SettlementVault.Released.processEvent({
      event: SettlementVault.Released.createMockEvent({
        eventId: EVENT_ID, tokenId: 7n, token: USDC, amount: 10_000_000n, ...at(TX2, 0, T0 + 100),
      }),
      mockDb: db,
    });
    const escrow = db.entities.Escrow.get('7');
    expect(escrow?.status).toBe('Released');
    expect(escrow?.releasedAt).toBe(BigInt(T0 + 100));
    expect(escrow?.settleTxHash).toBe(TX2);
    expect(db.entities.EventSettlement.get(EVENT_ID.toString())?.totalReleased).toBe(10_000_000n);
  });

  it('Paid writes one payout row keyed by txHash-logIndex and counts it', async () => {
    const after = await SettlementVault.Paid.processEvent({
      event: SettlementVault.Paid.createMockEvent({
        eventId: EVENT_ID, tokenId: 7n, recipient: RECIP_A, amount: 9_000_000n, reasonHash: REASON_A,
        ...at(TX2, 3),
      }),
      mockDb: MockDb.createMockDb(),
    });
    const payout = after.entities.Payout.get(`${TX2}-3`);
    expect(payout).toEqual({
      id: `${TX2}-3`,
      eventId: EVENT_ID,
      tokenId: 7n,
      recipient: recipA,
      amount: 9_000_000n,
      reasonHash: REASON_A,
      at: BigInt(T0),
      txHash: TX2,
    });
    expect(after.entities.EventSettlement.get(EVENT_ID.toString())?.payoutCount).toBe(1);
  });

  it('NoShowSettled marks the escrow and counts as released (recipient distribution)', async () => {
    let db = await SettlementVault.Deposited.processEvent({
      event: SettlementVault.Deposited.createMockEvent({
        eventId: EVENT_ID, tokenId: 8n, token: USDC, amount: 5_000_000n, payer: PAYER, ...at(TX),
      }),
      mockDb: MockDb.createMockDb(),
    });
    db = await SettlementVault.NoShowSettled.processEvent({
      event: SettlementVault.NoShowSettled.createMockEvent({
        eventId: EVENT_ID, tokenId: 8n, token: USDC, amount: 5_000_000n, ...at(TX2, 1),
      }),
      mockDb: db,
    });
    expect(db.entities.Escrow.get('8')?.status).toBe('NoShowSettled');
    expect(db.entities.EventSettlement.get(EVENT_ID.toString())?.totalReleased).toBe(5_000_000n);
  });

  it('Refunded returns the deposit and counts as refunded', async () => {
    let db = await SettlementVault.Deposited.processEvent({
      event: SettlementVault.Deposited.createMockEvent({
        eventId: EVENT_ID, tokenId: 9n, token: USDC, amount: 3_000_000n, payer: PAYER, ...at(TX),
      }),
      mockDb: MockDb.createMockDb(),
    });
    db = await SettlementVault.Refunded.processEvent({
      event: SettlementVault.Refunded.createMockEvent({
        eventId: EVENT_ID, tokenId: 9n, token: USDC, amount: 3_000_000n, payer: PAYER, ...at(TX2, 2),
      }),
      mockDb: db,
    });
    expect(db.entities.Escrow.get('9')?.status).toBe('Refunded');
    expect(db.entities.EventSettlement.get(EVENT_ID.toString())?.totalRefunded).toBe(3_000_000n);
  });

  it('PayoutDeferred credits a pull balance that Withdrawn drains to zero', async () => {
    let db = await SettlementVault.PayoutDeferred.processEvent({
      event: SettlementVault.PayoutDeferred.createMockEvent({
        eventId: EVENT_ID, tokenId: 7n, recipient: RECIP_B, token: USDC, amount: 1_000_000n, ...at(TX),
      }),
      mockDb: MockDb.createMockDb(),
    });
    let pending = db.entities.PendingWithdrawal.get(`${recipB}-${usdc}`);
    expect(pending).toEqual({ id: `${recipB}-${usdc}`, recipient: recipB, token: usdc, amount: 1_000_000n });
    db = await SettlementVault.Withdrawn.processEvent({
      event: SettlementVault.Withdrawn.createMockEvent({
        recipient: RECIP_B, token: USDC, amount: 1_000_000n, ...at(TX2),
      }),
      mockDb: db,
    });
    expect(db.entities.PendingWithdrawal.get(`${recipB}-${usdc}`)?.amount).toBe(0n);
  });

  it('TokenAllowed and DepositorSet track the allowlists', async () => {
    const t = await SettlementVault.TokenAllowed.processEvent({
      event: SettlementVault.TokenAllowed.createMockEvent({ token: USDC, allowed: true, ...at(TX) }),
      mockDb: MockDb.createMockDb(),
    });
    expect(t.entities.SettlementToken.get(usdc)).toEqual({ id: usdc, allowed: true });
    const d = await SettlementVault.DepositorSet.processEvent({
      event: SettlementVault.DepositorSet.createMockEvent({ account: PAYER, allowed: true, ...at(TX) }),
      mockDb: MockDb.createMockDb(),
    });
    expect(d.entities.SettlementDepositor.get(payer)).toEqual({ id: payer, allowed: true });
  });

  it('aggregates deposits, releases and a refund across tokens (6-decimal BigInt)', async () => {
    let db = MockDb.createMockDb();
    // 세 티켓 입금: 10 + 5 + 3 USDC
    for (const [tokenId, amount] of [[1n, 10_000_000n], [2n, 5_000_000n], [3n, 3_000_000n]] as const) {
      db = await SettlementVault.Deposited.processEvent({
        event: SettlementVault.Deposited.createMockEvent({
          eventId: EVENT_ID, tokenId, token: USDC, amount, payer: PAYER, ...at(TX),
        }),
        mockDb: db,
      });
    }
    // 둘 릴리스(10 + 5), 하나 환불(3)
    db = await SettlementVault.Released.processEvent({
      event: SettlementVault.Released.createMockEvent({
        eventId: EVENT_ID, tokenId: 1n, token: USDC, amount: 10_000_000n, ...at(TX2, 0),
      }),
      mockDb: db,
    });
    db = await SettlementVault.Released.processEvent({
      event: SettlementVault.Released.createMockEvent({
        eventId: EVENT_ID, tokenId: 2n, token: USDC, amount: 5_000_000n, ...at(TX2, 1),
      }),
      mockDb: db,
    });
    db = await SettlementVault.Refunded.processEvent({
      event: SettlementVault.Refunded.createMockEvent({
        eventId: EVENT_ID, tokenId: 3n, token: USDC, amount: 3_000_000n, payer: PAYER, ...at(TX2, 2),
      }),
      mockDb: db,
    });
    // 두 지급 줄
    for (const li of [3, 4]) {
      db = await SettlementVault.Paid.processEvent({
        event: SettlementVault.Paid.createMockEvent({
          eventId: EVENT_ID, tokenId: 1n, recipient: RECIP_A, amount: 9_000_000n, reasonHash: REASON_A,
          ...at(TX2, li),
        }),
        mockDb: db,
      });
    }
    const agg = db.entities.EventSettlement.get(EVENT_ID.toString());
    expect(agg?.totalDeposited).toBe(18_000_000n);
    expect(agg?.totalReleased).toBe(15_000_000n);
    expect(agg?.totalRefunded).toBe(3_000_000n);
    expect(agg?.payoutCount).toBe(2);
  });
});
