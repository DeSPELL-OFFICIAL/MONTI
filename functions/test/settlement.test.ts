import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import {
  ContractFunctionRevertedError,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  getAddress,
  keccak256,
  type Hex,
} from 'viem';
import { createFakeFirestore } from './helpers/fakeFirestore.js';
import { reasonHashOf, settlementAbi, tagToBytes32 } from '../src/lib/settlementAbi.js';

process.env.GCP_PROJECT_ID = 'monti-dev';

const PERSON_ID = `0x${'aa'.repeat(32)}` as Hex;
const OTHER_PERSON = `0x${'bb'.repeat(32)}` as Hex;
const ACCOUNT = getAddress(`0x${'11'.repeat(20)}`);
const ARTIST = getAddress(`0x${'a1'.repeat(20)}`);
const VENUE = getAddress(`0x${'a2'.repeat(20)}`);
const PLATFORM = getAddress(`0x${'a5'.repeat(20)}`);
const VAULT = getAddress(`0x${'ce'.repeat(20)}`);
const USDC = getAddress(`0x${'dc'.repeat(20)}`);
const TICKET = getAddress(`0x${'71'.repeat(20)}`);
const RELAYER = getAddress(`0x${'fa'.repeat(20)}`);
const TREASURY = getAddress(`0x${'77'.repeat(20)}`);
const TX = `0x${'ab'.repeat(32)}` as Hex;
const DEP_TX = `0x${'de'.repeat(32)}` as Hex;
const DEVICE_SIG = `0x${'cd'.repeat(64)}` as Hex;
const EVENT_ID = 42n;
const TOKEN_ID = 1234n;

// 체인 읽기 가짜 상태(테스트마다 덮어쓴다).
let policyNonce = 0n;
let usedAt = 0;
let eventStatus = 1; // Published
let allowance = 2n ** 200n; // 충분 → approve 생략
let hashView: Hex | null = null; // null 이면 readContract 가 던진다(view 없음 분기)

const fake = createFakeFirestore();

const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
  if (functionName === 'policyNonce') return policyNonce;
  if (functionName === 'hashPolicy') {
    if (hashView === null) throw new Error('view unavailable');
    return hashView;
  }
  if (functionName === 'allowance') return allowance;
  if (functionName === 'usedAt') return usedAt;
  if (functionName === 'eventStatus') return eventStatus;
  throw new Error(`UNEXPECTED_READ:${functionName}`);
});
const estimateContractGas = vi.fn(async () => 200_000n);
const waitForTransactionReceipt = vi.fn(async () => ({ status: 'success', logs: [] as unknown[] }));
const sendRelayed = vi.fn(async () => ({ hash: TX, nonce: 3, gasLimit: 206_000n, sentAt: Date.now() }));
const sendFromTreasury = vi.fn(async () => ({ hash: DEP_TX, nonce: 5, gasLimit: 103_000n, sentAt: Date.now() }));
const waitTreasury = vi.fn(async () => ({ status: 'success', logs: [] }));
const runRelayClaim = vi.fn(async () => ({ relayId: `${ACCOUNT}:${EVENT_ID}:0`, status: 'confirmed', txHash: TX, tokenId: TOKEN_ID.toString() }));

let callerAccount: Hex = ACCOUNT;
let orgAllowed = false;

vi.mock('../src/lib/db.js', () => ({
  db: fake.db,
  SETTLEMENTS: 'settlements',
  ORDERS: 'orders',
  RELAYS: 'relays',
  USERS: 'users',
}));
vi.mock('../src/lib/chain.js', () => ({
  publicClient: () => ({ readContract, estimateContractGas, waitForTransactionReceipt }),
  deployment: () => ({ ticket: TICKET, settlementVault: VAULT, usdc: USDC }),
}));
vi.mock('../src/lib/relayer.js', () => ({ sendRelayed, getRelayerAccount: () => ({ address: RELAYER }) }));
vi.mock('../src/lib/treasury.js', () => ({
  sendFromTreasury,
  waitTreasury,
  getTreasuryAccount: () => ({ address: TREASURY }),
}));
vi.mock('../src/lib/auth.js', () => ({
  resolveCallerAccount: async () => callerAccount,
  isEventOrganizer: async () => orgAllowed,
}));
vi.mock('../src/functions/relay.js', () => ({ runRelayClaim }));

const settlement = await import('../src/functions/settlement.js');
const functionsTest = (await import('firebase-functions-test')).default();
const relaySetPolicy = functionsTest.wrap(settlement.relaySetPolicy);
const purchaseTicket = functionsTest.wrap(settlement.purchaseTicket);
const refundOrder = functionsTest.wrap(settlement.refundOrder);

const auth = { uid: 'uid-1', token: { account: ACCOUNT, personId: PERSON_ID } };

/** viem 이 settlementAbi 로 디코딩할 수 있는 커스텀-에러 revert. */
function reverted(errorName: string) {
  const data = encodeErrorResult({ abi: settlementAbi, errorName } as never);
  return new ContractFunctionRevertedError({ abi: settlementAbi, data, functionName: 'setPolicy' });
}

// 인터페이스대로 독립적으로 계산한 policyHash — hashPolicy 의 패리티 기준.
const RECIPIENTS_TUPLE = {
  type: 'tuple[]',
  components: [
    { name: 'account', type: 'address' },
    { name: 'bps', type: 'uint16' },
    { name: 'reasonHash', type: 'bytes32' },
    { name: 'tag', type: 'bytes32' },
  ],
} as const;
function independentHash(onChain: { account: Hex; bps: number; reasonHash: Hex; tag: Hex }[], platformBps: number): Hex {
  return keccak256(
    encodeAbiParameters(
      [RECIPIENTS_TUPLE, { type: 'uint16' }, { type: 'uint16' }, { type: 'bool' }],
      [onChain, platformBps, 0, false],
    ),
  );
}

const RECIPIENTS = [
  { account: ARTIST, bps: 6000, reason: '출연료', tag: 'artist' },
  { account: VENUE, bps: 2000, reason: '대관료', tag: 'venue' },
  { account: PLATFORM, bps: 2000, reason: '플랫폼 수수료', tag: 'platform' },
];
const ON_CHAIN = RECIPIENTS.map((r) => ({
  account: r.account,
  bps: r.bps,
  reasonHash: reasonHashOf(r.reason),
  tag: tagToBytes32(r.tag),
}));
const EXPECTED_HASH = independentHash(ON_CHAIN, 2000);

function policyReq(over: Record<string, unknown> = {}) {
  return {
    eventId: EVENT_ID.toString(),
    policy: { recipients: RECIPIENTS, platformBps: 2000 },
    auth: { nonce: '0', deadline: '99999999999' },
    deviceSig: DEVICE_SIG,
    priceUsdCentsByTier: { '0': 3000 },
    ...over,
  };
}
function buyReq(over: Record<string, unknown> = {}) {
  return {
    eventId: EVENT_ID.toString(),
    tier: 0,
    auth: { eventId: EVENT_ID.toString(), tier: 0, account: ACCOUNT, nonce: '0', deadline: '99999999999' },
    deviceSig: DEVICE_SIG,
    payment: { method: 'card-mock', amountUsdCents: 3000 },
    ...over,
  };
}

beforeEach(() => {
  fake.docs.clear();
  policyNonce = 0n;
  usedAt = 0;
  eventStatus = 1;
  allowance = 2n ** 200n;
  hashView = EXPECTED_HASH;
  callerAccount = ACCOUNT;
  orgAllowed = false;
  readContract.mockClear();
  estimateContractGas.mockClear();
  estimateContractGas.mockResolvedValue(200_000n);
  waitForTransactionReceipt.mockClear();
  waitForTransactionReceipt.mockResolvedValue({ status: 'success', logs: [] });
  sendRelayed.mockClear();
  sendRelayed.mockResolvedValue({ hash: TX, nonce: 3, gasLimit: 206_000n, sentAt: Date.now() });
  sendFromTreasury.mockClear();
  sendFromTreasury.mockResolvedValue({ hash: DEP_TX, nonce: 5, gasLimit: 103_000n, sentAt: Date.now() });
  waitTreasury.mockClear();
  runRelayClaim.mockClear();
  runRelayClaim.mockResolvedValue({ relayId: `${ACCOUNT}:${EVENT_ID}:0`, status: 'confirmed', txHash: TX, tokenId: TOKEN_ID.toString() });
});

describe('relaySetPolicy', () => {
  it('stores a policy whose hash matches an independent keccak of the abi-encoded policy', async () => {
    const res = (await relaySetPolicy({ data: policyReq(), auth } as never)) as { relayId: string; status: string; txHash?: string };
    expect(res.status).toBe('confirmed');
    expect(res.relayId).toBe(`setPolicy:${ACCOUNT}:0`);
    const doc = fake.snapshot(`settlements/${EVENT_ID}`);
    expect(doc.get('policyHash')).toBe(EXPECTED_HASH);
    const policy = doc.get('policy') as { platformBps: number; recipients: Record<string, unknown>[] };
    expect(policy.platformBps).toBe(2000);
    expect(policy.recipients[0]).toMatchObject({ account: ARTIST, bps: 6000, reason: '출연료', tag: 'artist' });
    expect(doc.get('priceUsdCentsByTier')).toEqual({ '0': 3000 });
    expect(fake.snapshot(`relays/setPolicy:${ACCOUNT}:0`).get('kind')).toBe('setPolicy');
    expect(sendRelayed).toHaveBeenCalledTimes(1);
  });

  it('computes the hash locally when the hashPolicy view is unavailable (pre-deploy)', async () => {
    hashView = null; // readContract('hashPolicy') throws → 로컬 계산으로 진행
    const res = (await relaySetPolicy({ data: policyReq(), auth } as never)) as { status: string };
    expect(res.status).toBe('confirmed');
    expect(fake.snapshot(`settlements/${EVENT_ID}`).get('policyHash')).toBe(EXPECTED_HASH);
  });

  it('rejects a split that does not sum to 10000 before any send', async () => {
    const bad = { recipients: [{ account: ARTIST, bps: 5000, reason: 'x', tag: 'artist' }, { account: PLATFORM, bps: 2000, reason: 'p', tag: 'platform' }], platformBps: 2000 };
    await expect(relaySetPolicy({ data: policyReq({ policy: bad }), auth } as never)).rejects.toMatchObject({ details: { code: 'BAD_SPLIT_SUM' } });
    expect(sendRelayed).not.toHaveBeenCalled();
  });

  it('maps a NotPolicyAuthorizer simulation revert to NOT_ORGANIZER', async () => {
    estimateContractGas.mockRejectedValueOnce(reverted('NotPolicyAuthorizer'));
    await expect(relaySetPolicy({ data: policyReq(), auth } as never)).rejects.toMatchObject({ details: { code: 'NOT_ORGANIZER' } });
    expect(sendRelayed).not.toHaveBeenCalled();
  });

  it('is idempotent — an existing confirmed setPolicy relay returns without a second send', async () => {
    fake.write(`relays/setPolicy:${ACCOUNT}:0`, { status: 'confirmed', txHash: TX, personId: PERSON_ID });
    const res = (await relaySetPolicy({ data: policyReq(), auth } as never)) as { status: string };
    expect(res.status).toBe('confirmed');
    expect(sendRelayed).not.toHaveBeenCalled();
  });
});

describe('purchaseTicket', () => {
  function seedPrice() {
    fake.write(`settlements/${EVENT_ID}`, { priceUsdCentsByTier: { '0': 3000 } });
  }

  it('mints then deposits USDC into escrow on a confirmed claim', async () => {
    seedPrice();
    const res = (await purchaseTicket({ data: buyReq(), auth } as never)) as { orderId: string; status: string; tokenId?: string; depositTxHash?: string };
    expect(res.status).toBe('deposited');
    expect(res.tokenId).toBe(TOKEN_ID.toString());
    expect(res.depositTxHash).toBe(DEP_TX);
    const order = fake.snapshot(`orders/${ACCOUNT}:${EVENT_ID}:0`);
    expect(order.get('status')).toBe('deposited');
    expect(order.get('tokenId')).toBe(TOKEN_ID.toString());
    expect(order.get('depositTxHash')).toBe(DEP_TX);
    expect(sendFromTreasury).toHaveBeenCalledTimes(1);
  });

  it('rejects a payment amount that does not match the tier price', async () => {
    seedPrice();
    await expect(purchaseTicket({ data: buyReq({ payment: { method: 'card-mock', amountUsdCents: 2500 } }), auth } as never)).rejects.toMatchObject({ details: { code: 'PRICE_MISMATCH' } });
    expect(runRelayClaim).not.toHaveBeenCalled();
  });

  it('rejects when no price is set for the tier', async () => {
    await expect(purchaseTicket({ data: buyReq(), auth } as never)).rejects.toMatchObject({ details: { code: 'NO_PRICE' } });
  });

  it('marks minted-pending and returns sent when the claim is only sent', async () => {
    seedPrice();
    runRelayClaim.mockResolvedValueOnce({ relayId: `${ACCOUNT}:${EVENT_ID}:0`, status: 'sent', txHash: TX } as never);
    const res = (await purchaseTicket({ data: buyReq(), auth } as never)) as { status: string };
    expect(res.status).toBe('sent');
    expect(fake.snapshot(`orders/${ACCOUNT}:${EVENT_ID}:0`).get('status')).toBe('minted-pending');
    expect(sendFromTreasury).not.toHaveBeenCalled();
  });

  it('is idempotent — an already deposited order returns without re-minting', async () => {
    seedPrice();
    fake.write(`orders/${ACCOUNT}:${EVENT_ID}:0`, { status: 'deposited', personId: PERSON_ID, tokenId: TOKEN_ID.toString(), depositTxHash: DEP_TX });
    const res = (await purchaseTicket({ data: buyReq(), auth } as never)) as { status: string; tokenId?: string };
    expect(res.status).toBe('deposited');
    expect(res.tokenId).toBe(TOKEN_ID.toString());
    expect(runRelayClaim).not.toHaveBeenCalled();
  });

  it('treats an AlreadyDeposited revert as a successful deposit (idempotent escrow)', async () => {
    seedPrice();
    estimateContractGas.mockRejectedValueOnce(reverted('AlreadyDeposited'));
    const res = (await purchaseTicket({ data: buyReq(), auth } as never)) as { status: string };
    expect(res.status).toBe('deposited');
    expect(sendFromTreasury).not.toHaveBeenCalled();
  });
});

describe('onCheckInConfirmed (release trigger)', () => {
  it('releases the escrow for a deposited order on check-in', async () => {
    fake.write(`orders/${ACCOUNT}:${EVENT_ID}:0`, { status: 'deposited', personId: PERSON_ID, eventId: EVENT_ID.toString(), tokenId: TOKEN_ID.toString() });
    await settlement.onCheckInConfirmed(EVENT_ID, TOKEN_ID);
    expect(sendRelayed).toHaveBeenCalledTimes(1);
    const order = fake.snapshot(`orders/${ACCOUNT}:${EVENT_ID}:0`);
    expect(order.get('status')).toBe('released');
    expect(order.get('releaseTxHash')).toBe(TX);
  });

  it('does nothing when there is no deposited order for the token (e.g. free event)', async () => {
    await settlement.onCheckInConfirmed(EVENT_ID, TOKEN_ID);
    expect(sendRelayed).not.toHaveBeenCalled();
  });
});

describe('settlementSweep', () => {
  const stale = () => Timestamp.fromMillis(Date.now() - 10 * 60 * 1000);

  it('releases a deposited order whose ticket has been admitted', async () => {
    usedAt = 1_730_000_000;
    fake.write(`orders/${ACCOUNT}:${EVENT_ID}:0`, { status: 'deposited', eventId: EVENT_ID.toString(), tokenId: TOKEN_ID.toString(), updatedAt: stale() });
    await settlement.settlementSweep();
    expect(fake.snapshot(`orders/${ACCOUNT}:${EVENT_ID}:0`).get('status')).toBe('released');
    expect(sendRelayed).toHaveBeenCalled();
  });

  it('settles a no-show (unused + event ended) via settleNoShows', async () => {
    usedAt = 0;
    eventStatus = 3; // Ended
    waitForTransactionReceipt.mockResolvedValue({
      status: 'success',
      logs: [{ address: VAULT, ...noShowLog(TOKEN_ID) }],
    });
    fake.write(`orders/${ACCOUNT}:${EVENT_ID}:0`, { status: 'deposited', eventId: EVENT_ID.toString(), tokenId: TOKEN_ID.toString(), updatedAt: stale() });
    await settlement.settlementSweep();
    expect(sendRelayed).toHaveBeenCalled();
    // settleNoShows 는 relayer 로 나간다(permissionless). 주문 거울은 released 로 닫힌다.
    expect(fake.snapshot(`orders/${ACCOUNT}:${EVENT_ID}:0`).get('status')).toBe('released');
  });

  it('finishes a stuck minted-pending order by depositing', async () => {
    fake.write(`orders/${ACCOUNT}:${EVENT_ID}:0`, { status: 'minted-pending', eventId: EVENT_ID.toString(), tokenId: TOKEN_ID.toString(), amountUsdCents: 3000, updatedAt: stale() });
    await settlement.settlementSweep();
    expect(sendFromTreasury).toHaveBeenCalledTimes(1);
    expect(fake.snapshot(`orders/${ACCOUNT}:${EVENT_ID}:0`).get('status')).toBe('deposited');
  });
});

/** settleNoShows 영수증에 넣을 NoShowSettled 로그(토큰 반영 확인용). */
function noShowLog(tokenId: bigint) {
  return {
    topics: encodeEventTopics({ abi: settlementAbi, eventName: 'NoShowSettled', args: { eventId: EVENT_ID, tokenId } }),
    data: encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [USDC, 30_000_000n]),
    blockNumber: 1n,
    blockHash: `0x${'bb'.repeat(32)}`,
    transactionHash: TX,
    transactionIndex: 0,
    logIndex: 0,
    removed: false,
  };
}

describe('refundOrder', () => {
  it('refunds a deposited order for its owner via the treasury', async () => {
    fake.write(`orders/order-1`, { status: 'deposited', personId: PERSON_ID, eventId: EVENT_ID.toString(), tokenId: TOKEN_ID.toString() });
    const res = (await refundOrder({ data: { orderId: 'order-1' }, auth } as never)) as { status: string; refundTxHash?: string };
    expect(res.status).toBe('refunded');
    expect(res.refundTxHash).toBe(DEP_TX);
    expect(fake.snapshot('orders/order-1').get('status')).toBe('refunded');
    expect(sendFromTreasury).toHaveBeenCalledTimes(1);
  });

  it('lets an event organizer refund someone else’s order', async () => {
    orgAllowed = true;
    fake.write(`orders/order-2`, { status: 'deposited', personId: OTHER_PERSON, eventId: EVENT_ID.toString(), tokenId: TOKEN_ID.toString() });
    const res = (await refundOrder({ data: { orderId: 'order-2' }, auth } as never)) as { status: string };
    expect(res.status).toBe('refunded');
  });

  it('denies a non-owner non-organizer', async () => {
    orgAllowed = false;
    fake.write(`orders/order-3`, { status: 'deposited', personId: OTHER_PERSON, eventId: EVENT_ID.toString(), tokenId: TOKEN_ID.toString() });
    await expect(refundOrder({ data: { orderId: 'order-3' }, auth } as never)).rejects.toMatchObject({ code: 'permission-denied' });
    expect(sendFromTreasury).not.toHaveBeenCalled();
  });

  it('refuses to refund an order that is not deposited', async () => {
    fake.write(`orders/order-4`, { status: 'released', personId: PERSON_ID, eventId: EVENT_ID.toString(), tokenId: TOKEN_ID.toString() });
    await expect(refundOrder({ data: { orderId: 'order-4' }, auth } as never)).rejects.toMatchObject({ details: { code: 'NOT_REFUNDABLE' } });
  });

  it('maps an AlreadyCheckedIn refund revert to a precondition code', async () => {
    fake.write(`orders/order-5`, { status: 'deposited', personId: PERSON_ID, eventId: EVENT_ID.toString(), tokenId: TOKEN_ID.toString() });
    estimateContractGas.mockRejectedValueOnce(reverted('AlreadyCheckedIn'));
    await expect(refundOrder({ data: { orderId: 'order-5' }, auth } as never)).rejects.toMatchObject({ details: { code: 'ALREADY_CHECKED_IN' } });
  });
});
