import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import {
  ContractFunctionRevertedError,
  TransactionReceiptNotFoundError,
  WaitForTransactionReceiptTimeoutError,
  decodeFunctionData,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  getAddress,
  type Hex,
} from 'viem';
import { ticketAbi } from '@monti/shared';
import { createFakeFirestore } from './helpers/fakeFirestore.js';
import { purchaseSimAbi, settlementAbi } from '../src/lib/settlementAbi.js';

process.env.GCP_PROJECT_ID = 'monti-dev';

const PERSON_ID = `0x${'aa'.repeat(32)}` as Hex;
const OTHER_PERSON = `0x${'bb'.repeat(32)}` as Hex;
const ACCOUNT = getAddress(`0x${'11'.repeat(20)}`);
const VAULT = getAddress(`0x${'ce'.repeat(20)}`);
const USDC = getAddress(`0x${'dc'.repeat(20)}`);
const TICKET = getAddress(`0x${'71'.repeat(20)}`);
const IDENTITY = getAddress(`0x${'1d'.repeat(20)}`);
const RELAYER = getAddress(`0x${'fa'.repeat(20)}`);
const TREASURY = getAddress(`0x${'77'.repeat(20)}`);
const TX = `0x${'ab'.repeat(32)}` as Hex;
const BUY_TX = `0x${'de'.repeat(32)}` as Hex;
const APPROVE_TX = `0x${'a9'.repeat(32)}` as Hex;
const DEVICE_SIG = `0x${'cd'.repeat(64)}` as Hex;
const EVENT_ID = 1001n;
const TOKEN_ID = (EVENT_ID << 96n) | 1n;
const ORDER_ID = `${ACCOUNT}:${EVENT_ID}:0`;
const PRICE_CENTS = 3000;
const PRICE_UNITS = 30_000_000n; // 3000 cents × 1e4

// 체인 읽기 가짜 상태(테스트마다 덮어쓴다).
let member = true;
let locked = false;
let chainNonce = 0n;
let tierPrices: number[] = [PRICE_CENTS];
let treasuryBalance = 10n ** 12n;
let allowance = 2n ** 200n; // 충분 → approve 생략
let usedAt = 0;
let eventStatus = 1; // Published

const fake = createFakeFirestore();

const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
  if (functionName === 'isMember') return member;
  if (functionName === 'isLocked') return locked;
  if (functionName === 'claimNonce') return chainNonce;
  if (functionName === 'tiers') {
    return tierPrices.map((p, i) => ({ name: `T${i}`, priceUsdCents: BigInt(p), supply: 100, minted: 0, maxPerWallet: 4, seated: false }));
  }
  if (functionName === 'balanceOf') return treasuryBalance;
  if (functionName === 'allowance') return allowance;
  if (functionName === 'usedAt') return usedAt;
  if (functionName === 'eventStatus') return eventStatus;
  throw new Error(`UNEXPECTED_READ:${functionName}`);
});
const estimateContractGas = vi.fn(async (_args: Record<string, unknown>) => 300_000n);
const waitForTransactionReceipt = vi.fn(async (): Promise<unknown> => okReceipt());
const getTransactionReceipt = vi.fn(async (): Promise<unknown> => okReceipt());
const sendRelayed = vi.fn(async () => ({ hash: TX, nonce: 3, gasLimit: 206_000n, sentAt: Date.now() }));
const sendFromTreasury = vi.fn(async (_req: { to: Hex; data: Hex; gasLimit: bigint }) => ({
  hash: BUY_TX,
  nonce: 5,
  gasLimit: 309_000n,
  sentAt: Date.now(),
}));
const waitTreasury = vi.fn(async () => ({ status: 'success', logs: [] }));
const recordEventUsage = vi.fn(async () => undefined);

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
  publicClient: () => ({ readContract, estimateContractGas, waitForTransactionReceipt, getTransactionReceipt }),
  deployment: () => ({ ticket: TICKET, identity: IDENTITY, settlementVault: VAULT, usdc: USDC }),
}));
vi.mock('../src/lib/relayer.js', () => ({ sendRelayed, getRelayerAccount: () => ({ address: RELAYER }) }));
vi.mock('../src/lib/treasury.js', () => ({
  sendFromTreasury,
  waitTreasury,
  getTreasuryAccount: () => ({ address: TREASURY }),
}));
vi.mock('../src/lib/usage.js', () => ({ recordEventUsage }));
vi.mock('../src/lib/auth.js', () => ({
  resolveCallerAccount: async () => callerAccount,
  isEventOrganizer: async () => orgAllowed,
}));

const settlement = await import('../src/functions/settlement.js');
const functionsTest = (await import('firebase-functions-test')).default();
const purchaseTicket = functionsTest.wrap(settlement.purchaseTicket);
const refundOrder = functionsTest.wrap(settlement.refundOrder);

const auth = { uid: 'uid-1', token: { account: ACCOUNT, personId: PERSON_ID } };

type BuyResult = { orderId: string; relayId: string; status: string; tokenId?: string; txHash?: string };

/** viem 이 purchaseSimAbi(금고 + Ticket 오류 + TransferFromFailed)로 디코딩할 수 있는 revert. */
function reverted(errorName: string) {
  const data = encodeErrorResult({ abi: purchaseSimAbi, errorName } as never);
  return new ContractFunctionRevertedError({ abi: purchaseSimAbi, data, functionName: 'purchase' });
}

/** purchase 영수증의 Ticket.Claimed 로그. */
function claimedLog(tokenId: bigint) {
  return {
    address: TICKET,
    topics: encodeEventTopics({ abi: ticketAbi, eventName: 'Claimed', args: { tokenId, eventId: EVENT_ID, to: ACCOUNT } }),
    data: encodeAbiParameters([{ type: 'uint8' }], [0]),
    blockNumber: 1n,
    blockHash: `0x${'bb'.repeat(32)}`,
    transactionHash: BUY_TX,
    transactionIndex: 0,
    logIndex: 1,
    removed: false,
  };
}
function okReceipt() {
  return { status: 'success', logs: [claimedLog(TOKEN_ID)], gasUsed: 300_000n, effectiveGasPrice: 1n };
}

/** settleNoShows 영수증에 넣을 NoShowSettled 로그(토큰 반영 확인용). */
function noShowLog(tokenId: bigint) {
  return {
    address: VAULT,
    topics: encodeEventTopics({ abi: settlementAbi, eventName: 'NoShowSettled', args: { eventId: EVENT_ID, tokenId } }),
    data: encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [USDC, PRICE_UNITS]),
    blockNumber: 1n,
    blockHash: `0x${'bb'.repeat(32)}`,
    transactionHash: TX,
    transactionIndex: 0,
    logIndex: 0,
    removed: false,
  };
}

function buyReq(over: Record<string, unknown> = {}) {
  return {
    eventId: EVENT_ID.toString(),
    tier: 0,
    auth: { eventId: EVENT_ID.toString(), tier: 0, account: ACCOUNT, nonce: '0', deadline: '99999999999' },
    deviceSig: DEVICE_SIG,
    payment: { method: 'card-mock', amountUsdCents: PRICE_CENTS },
    ...over,
  };
}
const buy = (over: Record<string, unknown> = {}) => purchaseTicket({ data: buyReq(over), auth } as never) as Promise<BuyResult>;

beforeEach(() => {
  fake.docs.clear();
  member = true;
  locked = false;
  chainNonce = 0n;
  tierPrices = [PRICE_CENTS];
  treasuryBalance = 10n ** 12n;
  allowance = 2n ** 200n;
  usedAt = 0;
  eventStatus = 1;
  callerAccount = ACCOUNT;
  orgAllowed = false;
  readContract.mockClear();
  estimateContractGas.mockReset();
  estimateContractGas.mockResolvedValue(300_000n);
  waitForTransactionReceipt.mockReset();
  waitForTransactionReceipt.mockResolvedValue(okReceipt());
  getTransactionReceipt.mockReset();
  getTransactionReceipt.mockResolvedValue(okReceipt());
  sendRelayed.mockClear();
  sendFromTreasury.mockReset();
  sendFromTreasury.mockResolvedValue({ hash: BUY_TX, nonce: 5, gasLimit: 309_000n, sentAt: Date.now() });
  waitTreasury.mockClear();
  recordEventUsage.mockClear();
});

describe('purchaseTicket — atomic purchase (v2 D1)', () => {
  it('sends ONE treasury purchase tx and finalizes the order as deposited with the Claimed tokenId', async () => {
    const res = await buy();
    expect(res).toEqual({ orderId: ORDER_ID, relayId: ORDER_ID, status: 'deposited', tokenId: TOKEN_ID.toString(), txHash: BUY_TX });

    expect(sendFromTreasury).toHaveBeenCalledTimes(1);
    const req = sendFromTreasury.mock.calls[0]![0];
    expect(req.to).toBe(VAULT);
    const decoded = decodeFunctionData({ abi: settlementAbi, data: req.data });
    expect(decoded.functionName).toBe('purchase');
    const [a, sig, token] = decoded.args as [Record<string, unknown>, Hex, Hex];
    expect(a).toMatchObject({ eventId: EVENT_ID, tier: 0, account: ACCOUNT, nonce: 0n, deadline: 99999999999n });
    expect(sig).toBe(DEVICE_SIG);
    expect(token).toBe(USDC);
    // 시뮬은 트레저리(=depositor)로, 디코드 ABI 는 purchaseSimAbi.
    expect(estimateContractGas.mock.calls[0]![0]).toMatchObject({ address: VAULT, functionName: 'purchase', account: TREASURY, abi: purchaseSimAbi });
    expect(sendRelayed).not.toHaveBeenCalled();

    const order = fake.snapshot(`orders/${ORDER_ID}`);
    expect(order.get('status')).toBe('deposited');
    expect(order.get('tokenId')).toBe(TOKEN_ID.toString());
    expect(order.get('txHash')).toBe(BUY_TX);
    expect(order.get('depositTxHash')).toBe(BUY_TX);
    expect(order.get('amountUsdCents')).toBe(PRICE_CENTS);
    expect(order.get('method')).toBe('card-mock');
    expect(order.get('personId')).toBe(PERSON_ID);
    expect(order.get('account')).toBe(ACCOUNT);
    expect(order.get('eventId')).toBe(EVENT_ID.toString());
    expect(order.get('tier')).toBe(0);

    const relay = fake.snapshot(`relays/${ORDER_ID}`);
    expect(relay.get('kind')).toBe('purchase');
    expect(relay.get('status')).toBe('confirmed');
    expect(relay.get('tokenId')).toBe(TOKEN_ID.toString());
    expect(relay.get('txHash')).toBe(BUY_TX);
    expect(relay.get('personId')).toBe(PERSON_ID);

    expect(recordEventUsage).toHaveBeenCalledWith(EVENT_ID, 'purchase', expect.objectContaining({ status: 'success' }));
  });

  it('approves the vault once (max) before the first purchase when the allowance is short', async () => {
    allowance = 0n;
    sendFromTreasury.mockResolvedValueOnce({ hash: APPROVE_TX, nonce: 4, gasLimit: 50_000n, sentAt: Date.now() });
    const res = await buy();
    expect(res.status).toBe('deposited');
    expect(sendFromTreasury).toHaveBeenCalledTimes(2);
    expect(sendFromTreasury.mock.calls[0]![0].to).toBe(USDC);
    expect(waitTreasury).toHaveBeenCalledWith(APPROVE_TX);
    expect(sendFromTreasury.mock.calls[1]![0].to).toBe(VAULT);
  });

  describe('pre-checks (no gas spent)', () => {
    it('rejects a free tier with NOT_PAID_TIER (on-chain price is canonical)', async () => {
      tierPrices = [0];
      await expect(buy()).rejects.toMatchObject({ details: { code: 'NOT_PAID_TIER' } });
      expect(sendFromTreasury).not.toHaveBeenCalled();
    });

    it('rejects an amount that differs from the on-chain tier price with PRICE_MISMATCH{expected}', async () => {
      await expect(buy({ payment: { method: 'card-mock', amountUsdCents: 2500 } })).rejects.toMatchObject({
        details: { code: 'PRICE_MISMATCH', expected: PRICE_CENTS },
      });
      expect(estimateContractGas).not.toHaveBeenCalled();
      expect(sendFromTreasury).not.toHaveBeenCalled();
    });

    it('prices from the publish-hook mirror settlements/{eventId} when present (no chain tier read)', async () => {
      fake.write(`settlements/${EVENT_ID}`, { priceUsdCentsByTier: { '0': 1000 } });
      await expect(buy()).rejects.toMatchObject({ details: { code: 'PRICE_MISMATCH', expected: 1000 } });
      expect(readContract.mock.calls.some(([c]) => c.functionName === 'tiers')).toBe(false);
      const res = await buy({ payment: { method: 'card-mock', amountUsdCents: 1000 } });
      expect(res.status).toBe('deposited');
    });

    it('falls back to the chain tier when the mirror lacks that tier', async () => {
      fake.write(`settlements/${EVENT_ID}`, { priceUsdCentsByTier: { '1': 1000 } });
      expect((await buy()).status).toBe('deposited');
      expect(readContract.mock.calls.some(([c]) => c.functionName === 'tiers')).toBe(true);
    });

    it('rejects a tier the event does not have with UNKNOWN_TIER', async () => {
      await expect(buy({ tier: 3 })).rejects.toMatchObject({ details: { code: 'UNKNOWN_TIER' } });
    });

    it('rejects a stale nonce with BAD_NONCE and the current chain nonce', async () => {
      chainNonce = 2n;
      await expect(buy()).rejects.toMatchObject({ details: { code: 'BAD_NONCE', nonce: '2' } });
      expect(sendFromTreasury).not.toHaveBeenCalled();
    });

    it('rejects a non-member and a locked device', async () => {
      member = false;
      await expect(buy()).rejects.toMatchObject({ details: { code: 'NOT_MEMBER' } });
      member = true;
      locked = true;
      await expect(buy()).rejects.toMatchObject({ details: { code: 'DEVICE_LOCKED' } });
    });

    it('rejects an expired authorization with AUTH_EXPIRED', async () => {
      await expect(
        buy({ auth: { eventId: EVENT_ID.toString(), tier: 0, account: ACCOUNT, nonce: '0', deadline: '1' } }),
      ).rejects.toMatchObject({ details: { code: 'AUTH_EXPIRED' } });
    });

    it('rejects with TREASURY_FUNDS when the treasury USDC balance is below the price', async () => {
      treasuryBalance = PRICE_UNITS - 1n;
      await expect(buy()).rejects.toMatchObject({ details: { code: 'TREASURY_FUNDS' } });
      expect(estimateContractGas).not.toHaveBeenCalled();
      expect(sendFromTreasury).not.toHaveBeenCalled();
      expect(fake.docs.has(`orders/${ORDER_ID}`)).toBe(false);
    });

    it('rate-limits a person with five unfinished relays (TOO_MANY_PENDING)', async () => {
      for (let i = 0; i < 5; i++) fake.write(`relays/r${i}`, { personId: PERSON_ID, status: 'sent' });
      await expect(buy()).rejects.toMatchObject({ details: { code: 'TOO_MANY_PENDING' } });
      expect(sendFromTreasury).not.toHaveBeenCalled();
    });
  });

  describe('simulation revert mapping (plan §1.2)', () => {
    const table: [string, string][] = [
      ['SoldOut', 'SOLD_OUT'],
      ['SaleClosed', 'NOT_ON_SALE'],
      ['KycRequired', 'KYC_REQUIRED'],
      ['MaxPerWalletExceeded', 'LIMIT'],
      ['NotPaidTier', 'NOT_PAID_TIER'],
      ['EventNotPublished', 'NOT_PUBLISHED'],
      ['EventEnded', 'EVENT_ENDED'],
      ['ApprovalRequired', 'APPROVAL_REQUIRED'],
      ['BadDeviceSignature', 'BAD_DEVICE_SIG'],
      ['TransferFromFailed', 'TREASURY_FUNDS'],
      ['Paused', 'PAUSED'],
      ['NotDepositor', 'CONFIG'],
      ['TokenNotAllowed', 'CONFIG'],
      ['NotVault', 'CONFIG'],
      ['RotationPending', 'REVERTED'],
    ];
    it.each(table)('%s → %s, nothing sent, no order written', async (errorName, code) => {
      estimateContractGas.mockRejectedValueOnce(reverted(errorName));
      await expect(buy()).rejects.toMatchObject({ details: { code } });
      expect(sendFromTreasury).not.toHaveBeenCalled();
      expect(fake.docs.has(`orders/${ORDER_ID}`)).toBe(false);
    });
  });

  it('marks order and relay failed with SEND_FAILED when the broadcast throws', async () => {
    sendFromTreasury.mockRejectedValueOnce(new Error('rpc down'));
    await expect(buy()).rejects.toMatchObject({ details: { code: 'SEND_FAILED' } });
    expect(fake.snapshot(`orders/${ORDER_ID}`).get('status')).toBe('failed');
    expect(fake.snapshot(`orders/${ORDER_ID}`).get('error')).toEqual({ code: 'SEND_FAILED' });
    expect(fake.snapshot(`relays/${ORDER_ID}`).get('status')).toBe('failed');
  });

  it('returns sent (not an error) when the receipt does not land within the wait', async () => {
    waitForTransactionReceipt.mockRejectedValueOnce(new WaitForTransactionReceiptTimeoutError({ hash: BUY_TX }));
    const res = await buy();
    expect(res).toEqual({ orderId: ORDER_ID, relayId: ORDER_ID, status: 'sent', txHash: BUY_TX });
    expect(fake.snapshot(`orders/${ORDER_ID}`).get('status')).toBe('sent');
    expect(fake.snapshot(`orders/${ORDER_ID}`).get('txHash')).toBe(BUY_TX);
    expect(fake.snapshot(`relays/${ORDER_ID}`).get('status')).toBe('sent');
  });

  it('marks order and relay failed with REVERTED when the receipt reverts (atomic: nothing minted, nothing charged)', async () => {
    waitForTransactionReceipt.mockResolvedValueOnce({ status: 'reverted', logs: [] });
    await expect(buy()).rejects.toMatchObject({ details: { code: 'REVERTED' } });
    expect(fake.snapshot(`orders/${ORDER_ID}`).get('status')).toBe('failed');
    expect(fake.snapshot(`orders/${ORDER_ID}`).get('error')).toEqual({ code: 'REVERTED' });
    expect(fake.snapshot(`relays/${ORDER_ID}`).get('status')).toBe('failed');
  });

  describe('idempotency (orderId = account:eventId:nonce)', () => {
    it('reflects a deposited order without touching the chain', async () => {
      fake.write(`orders/${ORDER_ID}`, { status: 'deposited', personId: PERSON_ID, tokenId: TOKEN_ID.toString(), txHash: BUY_TX });
      chainNonce = 1n; // 이미 소비됐어도 되비춤이 먼저다
      const res = await buy();
      expect(res).toEqual({ orderId: ORDER_ID, relayId: ORDER_ID, status: 'deposited', tokenId: TOKEN_ID.toString(), txHash: BUY_TX });
      expect(sendFromTreasury).not.toHaveBeenCalled();
      expect(estimateContractGas).not.toHaveBeenCalled();
    });

    it('reflects released/refunded orders as deposited', async () => {
      fake.write(`orders/${ORDER_ID}`, { status: 'released', personId: PERSON_ID, tokenId: TOKEN_ID.toString(), txHash: BUY_TX });
      expect((await buy()).status).toBe('deposited');
      expect(sendFromTreasury).not.toHaveBeenCalled();
    });

    it('reflects a sent (or pending) order as sent with no second tx', async () => {
      fake.write(`orders/${ORDER_ID}`, { status: 'sent', personId: PERSON_ID, txHash: BUY_TX });
      expect(await buy()).toEqual({ orderId: ORDER_ID, relayId: ORDER_ID, status: 'sent', txHash: BUY_TX });
      fake.write(`orders/${ORDER_ID}`, { status: 'pending', personId: PERSON_ID });
      expect((await buy()).status).toBe('sent');
      expect(sendFromTreasury).not.toHaveBeenCalled();
    });

    it('retries a failed order with the same nonce (atomic revert left the nonce unconsumed)', async () => {
      fake.write(`orders/${ORDER_ID}`, { status: 'failed', personId: PERSON_ID, error: { code: 'REVERTED' } });
      fake.write(`relays/${ORDER_ID}`, { kind: 'purchase', status: 'failed', personId: PERSON_ID });
      const res = await buy();
      expect(res.status).toBe('deposited');
      expect(sendFromTreasury).toHaveBeenCalledTimes(1);
      const order = fake.snapshot(`orders/${ORDER_ID}`);
      expect(order.get('status')).toBe('deposited');
      expect(order.get('error')).toBeUndefined();
    });

    it('a second identical call after success sends nothing', async () => {
      await buy();
      chainNonce = 1n;
      const again = await buy();
      expect(again.status).toBe('deposited');
      expect(sendFromTreasury).toHaveBeenCalledTimes(1);
    });
  });
});

describe('onCheckInConfirmed (release trigger)', () => {
  it('releases the escrow for a deposited order on check-in', async () => {
    fake.write(`orders/${ORDER_ID}`, { status: 'deposited', personId: PERSON_ID, eventId: EVENT_ID.toString(), tokenId: TOKEN_ID.toString() });
    await settlement.onCheckInConfirmed(EVENT_ID, TOKEN_ID);
    expect(sendRelayed).toHaveBeenCalledTimes(1);
    const order = fake.snapshot(`orders/${ORDER_ID}`);
    expect(order.get('status')).toBe('released');
    expect(order.get('releaseTxHash')).toBe(TX);
  });

  it('does nothing when there is no deposited order for the token (e.g. free event)', async () => {
    await settlement.onCheckInConfirmed(EVENT_ID, TOKEN_ID);
    expect(sendRelayed).not.toHaveBeenCalled();
  });
});

describe('settlementSweep', () => {
  const ago = (min: number) => Timestamp.fromMillis(Date.now() - min * 60 * 1000);

  function seedSent(updatedAt: Timestamp) {
    fake.write(`orders/${ORDER_ID}`, {
      status: 'sent', personId: PERSON_ID, account: ACCOUNT, eventId: EVENT_ID.toString(), tier: 0,
      amountUsdCents: PRICE_CENTS, txHash: BUY_TX, updatedAt,
    });
    fake.write(`relays/${ORDER_ID}`, { kind: 'purchase', status: 'sent', personId: PERSON_ID, txHash: BUY_TX, eventId: EVENT_ID.toString() });
  }

  it('finalizes a timed-out purchase from its receipt: deposited + Claimed tokenId (order and relay)', async () => {
    seedSent(ago(3));
    await settlement.settlementSweep();
    expect(getTransactionReceipt).toHaveBeenCalledWith({ hash: BUY_TX });
    const order = fake.snapshot(`orders/${ORDER_ID}`);
    expect(order.get('status')).toBe('deposited');
    expect(order.get('tokenId')).toBe(TOKEN_ID.toString());
    expect(order.get('depositTxHash')).toBe(BUY_TX);
    const relay = fake.snapshot(`relays/${ORDER_ID}`);
    expect(relay.get('status')).toBe('confirmed');
    expect(relay.get('tokenId')).toBe(TOKEN_ID.toString());
    expect(recordEventUsage).toHaveBeenCalledWith(EVENT_ID, 'purchase', expect.anything());
    expect(sendFromTreasury).not.toHaveBeenCalled();
  });

  it('marks a reverted purchase failed (order and relay)', async () => {
    seedSent(ago(3));
    getTransactionReceipt.mockResolvedValueOnce({ status: 'reverted', logs: [] });
    await settlement.settlementSweep();
    expect(fake.snapshot(`orders/${ORDER_ID}`).get('status')).toBe('failed');
    expect(fake.snapshot(`orders/${ORDER_ID}`).get('error')).toEqual({ code: 'REVERTED' });
    expect(fake.snapshot(`relays/${ORDER_ID}`).get('status')).toBe('failed');
  });

  it('marks a purchase with no receipt after 10 minutes failed (dropped → SEND_FAILED)', async () => {
    seedSent(ago(11));
    getTransactionReceipt.mockRejectedValueOnce(new TransactionReceiptNotFoundError({ hash: BUY_TX }));
    await settlement.settlementSweep();
    expect(fake.snapshot(`orders/${ORDER_ID}`).get('status')).toBe('failed');
    expect(fake.snapshot(`orders/${ORDER_ID}`).get('error')).toEqual({ code: 'SEND_FAILED' });
    expect(fake.snapshot(`relays/${ORDER_ID}`).get('status')).toBe('failed');
  });

  it('keeps waiting on a recent purchase with no receipt yet', async () => {
    seedSent(ago(3));
    getTransactionReceipt.mockRejectedValueOnce(new TransactionReceiptNotFoundError({ hash: BUY_TX }));
    await settlement.settlementSweep();
    expect(fake.snapshot(`orders/${ORDER_ID}`).get('status')).toBe('sent');
  });

  it('leaves a fresh sent order to the live callable', async () => {
    seedSent(ago(0.5));
    await settlement.settlementSweep();
    expect(getTransactionReceipt).not.toHaveBeenCalled();
  });

  it('releases a deposited order whose ticket has been admitted', async () => {
    usedAt = 1_730_000_000;
    fake.write(`orders/${ORDER_ID}`, { status: 'deposited', eventId: EVENT_ID.toString(), tokenId: TOKEN_ID.toString(), updatedAt: ago(10) });
    await settlement.settlementSweep();
    expect(fake.snapshot(`orders/${ORDER_ID}`).get('status')).toBe('released');
    expect(sendRelayed).toHaveBeenCalled();
  });

  it('settles a no-show (unused + event ended) via settleNoShows', async () => {
    usedAt = 0;
    eventStatus = 3; // Ended
    waitForTransactionReceipt.mockResolvedValue({ status: 'success', logs: [noShowLog(TOKEN_ID)] });
    fake.write(`orders/${ORDER_ID}`, { status: 'deposited', eventId: EVENT_ID.toString(), tokenId: TOKEN_ID.toString(), updatedAt: ago(10) });
    await settlement.settlementSweep();
    expect(sendRelayed).toHaveBeenCalled();
    expect(fake.snapshot(`orders/${ORDER_ID}`).get('status')).toBe('released');
  });
});

describe('refundOrder', () => {
  it('refunds a deposited order for its owner via the treasury', async () => {
    fake.write(`orders/order-1`, { status: 'deposited', personId: PERSON_ID, eventId: EVENT_ID.toString(), tokenId: TOKEN_ID.toString() });
    const res = (await refundOrder({ data: { orderId: 'order-1' }, auth } as never)) as { status: string; refundTxHash?: string };
    expect(res.status).toBe('refunded');
    expect(res.refundTxHash).toBe(BUY_TX);
    expect(fake.snapshot('orders/order-1').get('status')).toBe('refunded');
    expect(sendFromTreasury).toHaveBeenCalledTimes(1);
    expect(decodeFunctionData({ abi: settlementAbi, data: sendFromTreasury.mock.calls[0]![0].data }).functionName).toBe('refund');
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
