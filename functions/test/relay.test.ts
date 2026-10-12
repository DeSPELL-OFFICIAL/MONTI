import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ContractFunctionRevertedError,
  WaitForTransactionReceiptTimeoutError,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  getAddress,
} from 'viem';
import { ticketAbi, type Hex } from '@monti/shared';
import { createFakeFirestore } from './helpers/fakeFirestore.js';

process.env.GCP_PROJECT_ID = 'monti-dev';

const PERSON_ID = `0x${'aa'.repeat(32)}` as Hex;
const ACCOUNT_LOWER = `0x${'11'.repeat(20)}` as Hex;
const ACCOUNT = getAddress(ACCOUNT_LOWER);
const OTHER_ACCOUNT = `0x${'22'.repeat(20)}` as Hex;
const TICKET = `0x${'ce'.repeat(20)}` as Hex;
const IDENTITY = `0x${'1d'.repeat(20)}` as Hex;
const VAULT = `0x${'5a'.repeat(20)}` as Hex;
const RELAYER = `0x${'fa'.repeat(20)}` as Hex;
const TX_HASH = `0x${'ab'.repeat(32)}` as Hex;
const DEVICE_SIG = `0x${'cd'.repeat(64)}` as Hex;
const GATE_SIG = `0x${'ef'.repeat(64)}` as Hex;
const CODE_NONCE = `0x${'77'.repeat(32)}` as Hex;
const EVENT_ID = 42n;
const TOKEN_ID = 1234n;
const GATE_ID = 9n;
const ORG_ID = 7n;

// 체인 읽기의 가짜 응답. 각 테스트가 beforeEach 뒤에 필요한 값만 덮어쓴다.
let member = true;
let locked = false;
let chainNonce = 0n;
let usedAtChain = 0;
/** 금고 escrowOf.status — 0 None · 1 Held · 2 Released · 3 Refunded. */
let escrowStatus = 0;

const fake = createFakeFirestore();

const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
  if (functionName === 'isMember') return member;
  if (functionName === 'isLocked') return locked;
  if (functionName === 'claimNonce') return chainNonce;
  if (functionName === 'usedAt') return usedAtChain;
  if (functionName === 'eventOrg') return ORG_ID;
  if (functionName === 'escrowOf') return [VAULT, 0n, VAULT, 0n, escrowStatus];
  throw new Error(`UNEXPECTED_READ:${functionName}`);
});
const estimateContractGas = vi.fn(async () => 215_000n);
const waitForTransactionReceipt = vi.fn(async () => ({ status: 'success', logs: [] as unknown[], blockNumber: 100n }));
const sendRelayed = vi.fn(async () => ({ hash: TX_HASH, nonce: 7, gasLimit: 231_000n, sentAt: Date.now() }));

vi.mock('../src/lib/db.js', () => ({
  db: fake.db,
  RELAYS: 'relays',
  ADMISSIONS: 'admissions',
  ADMISSION_TOKENS: 'tokens',
  USAGE: 'usage',
  USERS: 'users',
  PERSONS: 'persons',
}));

vi.mock('../src/lib/chain.js', () => ({
  publicClient: () => ({ readContract, estimateContractGas, waitForTransactionReceipt }),
  deployment: () => ({ ticket: TICKET, identity: IDENTITY, settlementVault: VAULT }),
}));

vi.mock('../src/lib/relayer.js', () => ({
  sendRelayed,
  getRelayerAccount: () => ({ address: RELAYER }),
}));

const { relayClaim, relayCheckIn } = await import('../src/functions/relay.js');
const functionsTest = (await import('firebase-functions-test')).default();
const claim = functionsTest.wrap(relayClaim);
const checkIn = functionsTest.wrap(relayCheckIn);

const auth = { uid: 'uid-1', token: { account: ACCOUNT_LOWER, personId: PERSON_ID } };

/** viem 이 디코딩할 수 있는 커스텀-에러 revert. estimateContractGas 가 이걸 던진다. */
function reverted(errorName: string) {
  const data = encodeErrorResult({ abi: ticketAbi, errorName } as never);
  return new ContractFunctionRevertedError({ abi: ticketAbi, data, functionName: 'claimFor' });
}

function claimedLog(tokenId: bigint, tier: number) {
  return {
    address: TICKET,
    topics: encodeEventTopics({ abi: ticketAbi, eventName: 'Claimed', args: { tokenId, eventId: EVENT_ID, to: ACCOUNT } }),
    data: encodeAbiParameters([{ type: 'uint8' }], [tier]),
    blockNumber: 100n,
    blockHash: `0x${'bb'.repeat(32)}`,
    transactionHash: TX_HASH,
    transactionIndex: 0,
    logIndex: 0,
    removed: false,
  };
}
function checkedInLog(ts: bigint) {
  return {
    address: TICKET,
    topics: encodeEventTopics({ abi: ticketAbi, eventName: 'CheckedIn', args: { tokenId: TOKEN_ID, eventId: EVENT_ID, gateId: GATE_ID } }),
    data: encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint64' }], [`0x${'00'.repeat(32)}`, ts]),
    blockNumber: 100n,
    blockHash: `0x${'bb'.repeat(32)}`,
    transactionHash: TX_HASH,
    transactionIndex: 0,
    logIndex: 0,
    removed: false,
  };
}

function claimReq(over: Record<string, unknown> = {}) {
  return {
    mode: 'claim',
    auth: { eventId: EVENT_ID.toString(), tier: 0, account: ACCOUNT_LOWER, nonce: '0', deadline: '99999999999' },
    deviceSig: DEVICE_SIG,
    ...over,
  };
}
function checkInReq(over: Record<string, unknown> = {}) {
  return {
    tokenId: TOKEN_ID.toString(),
    code: { gateId: GATE_ID.toString(), eventId: EVENT_ID.toString(), issuedAt: '1730000000', nonce: CODE_NONCE },
    gateSig: GATE_SIG,
    deviceSig: DEVICE_SIG,
    late: false,
    ...over,
  };
}

beforeEach(() => {
  fake.docs.clear();
  member = true;
  locked = false;
  chainNonce = 0n;
  usedAtChain = 0;
  escrowStatus = 0;
  readContract.mockClear();
  estimateContractGas.mockClear();
  waitForTransactionReceipt.mockClear();
  sendRelayed.mockClear();
  waitForTransactionReceipt.mockResolvedValue({ status: 'success', logs: [], blockNumber: 100n });
  estimateContractGas.mockResolvedValue(215_000n);
  sendRelayed.mockResolvedValue({ hash: TX_HASH, nonce: 7, gasLimit: 231_000n, sentAt: Date.now() });
});

const RELAY_ID = `${ACCOUNT}:${EVENT_ID}:0`;
const CHECKIN_RELAY_ID = `${EVENT_ID}:${TOKEN_ID}`;

describe('relayClaim', () => {
  it('confirms and returns the minted tokenId when the receipt lands', async () => {
    waitForTransactionReceipt.mockResolvedValueOnce({ status: 'success', logs: [claimedLog(TOKEN_ID, 0)], blockNumber: 100n, gasUsed: 100n, effectiveGasPrice: 2n } as never);
    const res = (await claim({ data: claimReq(), auth } as never)) as { relayId: string; status: string; tokenId?: string; txHash?: string };
    expect(res).toEqual({ relayId: RELAY_ID, status: 'confirmed', txHash: TX_HASH, tokenId: TOKEN_ID.toString() });
    expect(sendRelayed).toHaveBeenCalledTimes(1);
    const doc = fake.snapshot(`relays/${RELAY_ID}`);
    expect(doc.get('status')).toBe('confirmed');
    expect(doc.get('tokenId')).toBe(TOKEN_ID.toString());
    expect(doc.get('gasLimit')).toBe(231_000);
    // 확정 가스가 이벤트의 조직 원장에 집계된다(설계 §4).
    const usage = fake.snapshot('usage/org:7');
    expect(usage.get('count')).toBe(1);
    expect(usage.get('lastKind')).toBe('claim');
    expect(usage.get('monSpentWei')).toBe('200');
  });

  it('returns sent (not an error) when the receipt does not arrive in time', async () => {
    waitForTransactionReceipt.mockRejectedValueOnce(new WaitForTransactionReceiptTimeoutError({ hash: TX_HASH }));
    const res = (await claim({ data: claimReq(), auth } as never)) as { status: string; txHash?: string };
    expect(res.status).toBe('sent');
    expect(res.txHash).toBe(TX_HASH);
    expect(fake.snapshot(`relays/${RELAY_ID}`).get('status')).toBe('sent');
  });

  it('ignores a client-supplied account and mints to the session account', async () => {
    // 요청 본문의 account 를 신뢰하지 않는다 — relayId·수령 계정은 언제나 세션 계정이다.
    waitForTransactionReceipt.mockResolvedValueOnce({ status: 'success', logs: [claimedLog(TOKEN_ID, 0)], blockNumber: 100n });
    const res = (await claim({
      data: claimReq({ auth: { eventId: EVENT_ID.toString(), tier: 0, account: OTHER_ACCOUNT, nonce: '0', deadline: '99999999999' } }),
      auth,
    } as never)) as { relayId: string; status: string };
    expect(res.relayId).toBe(RELAY_ID); // 세션 계정(ACCOUNT) 기준, OTHER_ACCOUNT 아님
    expect(fake.snapshot(`relays/${RELAY_ID}`).get('account')).toBe(ACCOUNT);
  });

  it('rejects a stale nonce and returns the current chain nonce for a re-sign', async () => {
    chainNonce = 3n;
    await expect(claim({ data: claimReq({ auth: { eventId: EVENT_ID.toString(), tier: 0, account: ACCOUNT_LOWER, nonce: '0', deadline: '99999999999' } }), auth } as never)).rejects.toMatchObject({
      code: 'failed-precondition',
      details: { code: 'BAD_NONCE', nonce: '3' },
    });
    expect(sendRelayed).not.toHaveBeenCalled();
  });

  it.each([
    ['SoldOut', 'SOLD_OUT'],
    ['MaxPerWalletExceeded', 'LIMIT'],
    ['SaleClosed', 'NOT_ON_SALE'],
    ['KycRequired', 'KYC_REQUIRED'],
    ['ApprovalRequired', 'APPROVAL_REQUIRED'],
  ])('maps a %s simulation revert to code %s without spending gas', async (errorName, code) => {
    estimateContractGas.mockRejectedValueOnce(reverted(errorName));
    await expect(claim({ data: claimReq(), auth } as never)).rejects.toMatchObject({
      code: 'failed-precondition',
      details: { code },
    });
    expect(sendRelayed).not.toHaveBeenCalled();
    expect(fake.docs.has(`relays/${RELAY_ID}`)).toBe(false);
  });

  it('rejects a locked device and a non-member before simulating', async () => {
    locked = true;
    await expect(claim({ data: claimReq(), auth } as never)).rejects.toMatchObject({ details: { code: 'DEVICE_LOCKED' } });
    locked = false;
    member = false;
    await expect(claim({ data: claimReq(), auth } as never)).rejects.toMatchObject({ details: { code: 'NOT_MEMBER' } });
    expect(estimateContractGas).not.toHaveBeenCalled();
  });

  it('is idempotent — an existing sent relay returns the same id with no second send', async () => {
    fake.write(`relays/${RELAY_ID}`, { status: 'sent', txHash: TX_HASH, personId: PERSON_ID });
    const res = (await claim({ data: claimReq(), auth } as never)) as { relayId: string; status: string };
    expect(res).toEqual({ relayId: RELAY_ID, status: 'sent', txHash: TX_HASH });
    expect(sendRelayed).not.toHaveBeenCalled();
    expect(estimateContractGas).not.toHaveBeenCalled();
  });

  it('rate-limits a person with five pending relays', async () => {
    for (let i = 0; i < 5; i++) fake.write(`relays/pending-${i}`, { status: 'pending', personId: PERSON_ID });
    await expect(claim({ data: claimReq(), auth } as never)).rejects.toMatchObject({
      code: 'resource-exhausted',
      details: { code: 'TOO_MANY_PENDING' },
    });
    expect(sendRelayed).not.toHaveBeenCalled();
  });
});

describe('relayCheckIn', () => {
  it('confirms and returns usedAt from the CheckedIn event', async () => {
    waitForTransactionReceipt.mockResolvedValueOnce({ status: 'success', logs: [checkedInLog(1730000123n)], blockNumber: 100n, gasUsed: 100n, effectiveGasPrice: 2n } as never);
    const res = (await checkIn({ data: checkInReq(), auth } as never)) as { relayId: string; status: string; usedAt?: number };
    expect(res).toEqual({ relayId: CHECKIN_RELAY_ID, status: 'confirmed', txHash: TX_HASH, usedAt: 1730000123 });
    expect(sendRelayed).toHaveBeenCalledTimes(1);
    expect(fake.snapshot(`admissions/${EVENT_ID}/tokens/${TOKEN_ID}`).get('status')).toBe('confirmed');
    expect(fake.snapshot(`relays/${CHECKIN_RELAY_ID}`).get('status')).toBe('confirmed');
    expect(fake.snapshot('usage/org:7').get('lastKind')).toBe('checkIn');
    expect(fake.snapshot('usage/org:7').get('monSpentWei')).toBe('200');
  });

  it('treats an already-used ticket as a successful pass (no second send)', async () => {
    usedAtChain = 1729999999;
    const res = (await checkIn({ data: checkInReq(), auth } as never)) as { status: string; usedAt?: number };
    expect(res).toEqual({ relayId: CHECKIN_RELAY_ID, status: 'confirmed', usedAt: 1729999999 });
    expect(sendRelayed).not.toHaveBeenCalled();
    expect(fake.docs.has(`admissions/${EVENT_ID}/tokens/${TOKEN_ID}`)).toBe(false);
  });

  it('writes admissions passing and relay sent when the receipt is slow', async () => {
    waitForTransactionReceipt.mockRejectedValueOnce(new WaitForTransactionReceiptTimeoutError({ hash: TX_HASH }));
    const res = (await checkIn({ data: checkInReq(), auth } as never)) as { status: string; txHash?: string };
    expect(res.status).toBe('sent');
    expect(fake.snapshot(`admissions/${EVENT_ID}/tokens/${TOKEN_ID}`).get('status')).toBe('passing');
    expect(fake.snapshot(`relays/${CHECKIN_RELAY_ID}`).get('status')).toBe('sent');
  });

  it.each([
    ['CodeExpired', 'EXPIRED_CODE'],
    ['GateNotOpen', 'GATE_CLOSED'],
    ['TicketRevoked', 'REVOKED'],
    ['DeviceLocked', 'DEVICE_LOCKED'],
    ['BadDeviceSignature', 'DEVICE_MISMATCH'],
  ])('maps a %s revert to DENY code %s and writes no admission', async (errorName, code) => {
    estimateContractGas.mockRejectedValueOnce(reverted(errorName));
    await expect(checkIn({ data: checkInReq(), auth } as never)).rejects.toMatchObject({
      code: 'failed-precondition',
      details: { code },
    });
    expect(sendRelayed).not.toHaveBeenCalled();
    expect(fake.docs.has(`admissions/${EVENT_ID}/tokens/${TOKEN_ID}`)).toBe(false);
  });

  it('refuses a refunded ticket with REVOKED before simulating — nothing sent, no admission', async () => {
    escrowStatus = 3;
    await expect(checkIn({ data: checkInReq(), auth } as never)).rejects.toMatchObject({
      code: 'failed-precondition',
      message: 'REVOKED',
      details: { code: 'REVOKED', reason: 'TICKET_REFUNDED' },
    });
    expect(estimateContractGas).not.toHaveBeenCalled();
    expect(sendRelayed).not.toHaveBeenCalled();
    expect(fake.docs.has(`admissions/${EVENT_ID}/tokens/${TOKEN_ID}`)).toBe(false);
    expect(fake.docs.has(`relays/${CHECKIN_RELAY_ID}`)).toBe(false);
  });

  it.each([
    [0, 'free (never escrowed)'],
    [1, 'held'],
    [2, 'released'],
  ])('admits normally when escrow status is %i (%s)', async (status) => {
    escrowStatus = status;
    const res = (await checkIn({ data: checkInReq(), auth } as never)) as { status: string };
    expect(res.status).toBe('confirmed');
    expect(sendRelayed).toHaveBeenCalledTimes(1);
    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({ address: VAULT, functionName: 'escrowOf', args: [TOKEN_ID] }));
  });

  it('is idempotent — an existing confirmed check-in relay returns confirmed', async () => {
    fake.write(`relays/${CHECKIN_RELAY_ID}`, { status: 'confirmed', txHash: TX_HASH, personId: PERSON_ID });
    const res = (await checkIn({ data: checkInReq(), auth } as never)) as { relayId: string; status: string };
    expect(res).toMatchObject({ relayId: CHECKIN_RELAY_ID, status: 'confirmed' });
    expect(sendRelayed).not.toHaveBeenCalled();
    expect(estimateContractGas).not.toHaveBeenCalled();
  });
});
