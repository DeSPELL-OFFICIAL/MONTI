import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ContractFunctionRevertedError,
  WaitForTransactionReceiptTimeoutError,
  encodeErrorResult,
  encodeEventTopics,
  encodeFunctionData,
  getAddress,
  toFunctionSelector,
  type Abi,
} from 'viem';
import { forwarderAbi, identityAbi, organizersAbi, ticketAbi, type Hex } from '@monti/shared';
import { Timestamp } from 'firebase-admin/firestore';
import { createFakeFirestore } from './helpers/fakeFirestore.js';
import { ACTION_ALLOWLIST } from '../src/lib/actionAllowlist.js';

process.env.GCP_PROJECT_ID = 'monti-dev';

const PERSON_ID = `0x${'aa'.repeat(32)}` as Hex;
const ACCOUNT_LOWER = `0x${'11'.repeat(20)}` as Hex;
const ACCOUNT = getAddress(ACCOUNT_LOWER);
const TICKET = getAddress(`0x${'ce'.repeat(20)}`);
const ORGANIZERS = getAddress(`0x${'02'.repeat(20)}`);
const IDENTITY = getAddress(`0x${'1d'.repeat(20)}`);
const FORWARDER = getAddress(`0x${'f0'.repeat(20)}`);
const OTHER = getAddress(`0x${'22'.repeat(20)}`);
const RELAYER = `0x${'fa'.repeat(20)}` as Hex;
const TX_HASH = `0x${'ab'.repeat(32)}` as Hex;
const DEVICE_SIG = `0x${'cd'.repeat(64)}` as Hex;
const EVENT_ID = 42n;
const ORG_ID = 7n;
const GATE_ID = 9n;

// 체인 읽기의 가짜 응답. 각 테스트가 beforeEach 뒤에 필요한 값만 덮어쓴다.
let chainNonce = 0n;

const fake = createFakeFirestore();

const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
  if (functionName === 'nonces') return chainNonce;
  if (functionName === 'eventOrg') return ORG_ID;
  throw new Error(`UNEXPECTED_READ:${functionName}`);
});
const estimateContractGas = vi.fn(async () => 215_000n);
const waitForTransactionReceipt = vi.fn(async () => ({ status: 'success', logs: [] as unknown[], blockNumber: 100n }));
const sendRelayed = vi.fn(async () => ({ hash: TX_HASH, nonce: 7, gasLimit: 231_000n, sentAt: Date.now() }));

vi.mock('../src/lib/db.js', () => ({
  db: fake.db,
  RELAYS: 'relays',
  USAGE: 'usage',
  USERS: 'users',
  PERSONS: 'persons',
}));

vi.mock('../src/lib/chain.js', () => ({
  publicClient: () => ({ readContract, estimateContractGas, waitForTransactionReceipt }),
  deployment: () => ({ ticket: TICKET, organizers: ORGANIZERS, identity: IDENTITY, forwarder: FORWARDER }),
}));

vi.mock('../src/lib/relayer.js', () => ({
  sendRelayed,
  getRelayerAccount: () => ({ address: RELAYER }),
}));

const { relayAction } = await import('../src/functions/relayAction.js');
const functionsTest = (await import('firebase-functions-test')).default();
const action = functionsTest.wrap(relayAction);

const auth = { uid: 'uid-1', token: { account: ACCOUNT_LOWER, personId: PERSON_ID } };

/** viem 이 디코딩할 수 있는 커스텀-에러 revert. estimateContractGas 가 이걸 던진다. */
function reverted(abi: Abi, errorName: string) {
  const data = encodeErrorResult({ abi, errorName } as never);
  return new ContractFunctionRevertedError({ abi, data, functionName: 'execute' });
}

function eventCreatedLog() {
  return {
    address: TICKET,
    topics: encodeEventTopics({ abi: ticketAbi, eventName: 'EventCreated', args: { eventId: EVENT_ID, orgId: ORG_ID, creator: ACCOUNT } }),
    data: '0x' as Hex,
    blockNumber: 100n,
    blockHash: `0x${'bb'.repeat(32)}`,
    transactionHash: TX_HASH,
    transactionIndex: 0,
    logIndex: 0,
    removed: false,
  };
}

const CREATE_EVENT = ACTION_ALLOWLIST.createEvent!.selector;

function futureDeadline(): string {
  return String(Math.floor(Date.now() / 1000) + 600);
}
function actionReq(over: Record<string, unknown> = {}) {
  return {
    kind: 'createEvent',
    req: { from: ACCOUNT, to: TICKET, nonce: '0', deadline: futureDeadline(), data: CREATE_EVENT },
    deviceSig: DEVICE_SIG,
    ...over,
  };
}

const RELAY_ID = `${ACCOUNT}:0`;

beforeEach(() => {
  fake.docs.clear();
  chainNonce = 0n;
  readContract.mockClear();
  estimateContractGas.mockClear();
  waitForTransactionReceipt.mockClear();
  sendRelayed.mockClear();
  waitForTransactionReceipt.mockResolvedValue({ status: 'success', logs: [], blockNumber: 100n });
  estimateContractGas.mockResolvedValue(215_000n);
  sendRelayed.mockResolvedValue({ hash: TX_HASH, nonce: 7, gasLimit: 231_000n, sentAt: Date.now() });
});

describe('relayAction', () => {
  it('confirms and decodes the target event result when the receipt lands', async () => {
    waitForTransactionReceipt.mockResolvedValueOnce({ status: 'success', logs: [eventCreatedLog()], blockNumber: 100n });
    const res = (await action({ data: actionReq(), auth } as never)) as {
      relayId: string;
      status: string;
      txHash?: string;
      result?: { eventId?: string };
    };
    expect(res).toEqual({ relayId: RELAY_ID, status: 'confirmed', txHash: TX_HASH, result: { eventId: EVENT_ID.toString() } });
    expect(sendRelayed).toHaveBeenCalledTimes(1);
    // 릴레이어가 부른 대상은 forwarder 다(대상 컨트랙트가 아니라).
    expect(sendRelayed).toHaveBeenCalledWith(expect.objectContaining({ to: FORWARDER }));
    const doc = fake.snapshot(`relays/${RELAY_ID}`);
    expect(doc.get('status')).toBe('confirmed');
    expect(doc.get('kind')).toBe('createEvent');
    expect(doc.get('account')).toBe(ACCOUNT);
    expect(doc.get('gasLimit')).toBe(231_000);
  });

  it('ignores a client-supplied from and keys the relay on the session account', async () => {
    const res = (await action({ data: actionReq({ req: { from: OTHER, to: TICKET, nonce: '0', deadline: futureDeadline(), data: CREATE_EVENT } }), auth } as never)) as { relayId: string };
    expect(res.relayId).toBe(RELAY_ID); // 세션 계정(ACCOUNT) 기준, OTHER 아님
    expect(fake.snapshot(`relays/${RELAY_ID}`).get('account')).toBe(ACCOUNT);
  });

  it('returns sent (not an error) when the receipt does not arrive in time', async () => {
    waitForTransactionReceipt.mockRejectedValueOnce(new WaitForTransactionReceiptTimeoutError({ hash: TX_HASH }));
    const res = (await action({ data: actionReq(), auth } as never)) as { status: string; txHash?: string };
    expect(res.status).toBe('sent');
    expect(res.txHash).toBe(TX_HASH);
    expect(fake.snapshot(`relays/${RELAY_ID}`).get('status')).toBe('sent');
  });

  it('rejects calldata whose selector is not the one allowed for the kind', async () => {
    const wrong = ACTION_ALLOWLIST.publishEvent!.selector; // createEvent 가 아닌 selector
    await expect(action({ data: actionReq({ req: { from: ACCOUNT, to: TICKET, nonce: '0', deadline: futureDeadline(), data: wrong } }), auth } as never)).rejects.toMatchObject({
      code: 'failed-precondition',
      details: { code: 'SELECTOR_NOT_ALLOWED' },
    });
    expect(sendRelayed).not.toHaveBeenCalled();
    expect(estimateContractGas).not.toHaveBeenCalled();
  });

  it('rejects a to that is not the kind target contract', async () => {
    await expect(action({ data: actionReq({ req: { from: ACCOUNT, to: OTHER, nonce: '0', deadline: futureDeadline(), data: CREATE_EVENT } }), auth } as never)).rejects.toMatchObject({
      code: 'failed-precondition',
      details: { code: 'WRONG_TARGET' },
    });
    expect(sendRelayed).not.toHaveBeenCalled();
  });

  it('rejects a stale nonce and returns the current forwarder nonce for a re-sign', async () => {
    chainNonce = 3n;
    await expect(action({ data: actionReq(), auth } as never)).rejects.toMatchObject({
      code: 'failed-precondition',
      details: { code: 'BAD_NONCE', nonce: '3' },
    });
    expect(sendRelayed).not.toHaveBeenCalled();
  });

  it.each([
    ['Expired', 'EXPIRED'],
    ['BadNonce', 'BAD_NONCE'],
    ['TargetNotAllowed', 'TARGET_NOT_ALLOWED'],
    ['NotMember', 'NOT_MEMBER'],
    ['DeviceLocked', 'DEVICE_LOCKED'],
    ['BadDeviceSignature', 'BAD_DEVICE_SIG'],
  ])('maps a %s forwarder revert to code %s without spending gas', async (errorName, code) => {
    estimateContractGas.mockRejectedValueOnce(reverted(forwarderAbi as Abi, errorName));
    await expect(action({ data: actionReq(), auth } as never)).rejects.toMatchObject({
      code: 'failed-precondition',
      details: { code },
    });
    expect(sendRelayed).not.toHaveBeenCalled();
    expect(fake.docs.has(`relays/${RELAY_ID}`)).toBe(false);
  });

  it('bubbles a target-contract revert to its Solidity error name', async () => {
    estimateContractGas.mockRejectedValueOnce(reverted(ticketAbi, 'Unauthorized'));
    await expect(action({ data: actionReq(), auth } as never)).rejects.toMatchObject({
      code: 'failed-precondition',
      details: { code: 'Unauthorized' },
    });
    expect(sendRelayed).not.toHaveBeenCalled();
  });

  it('is idempotent — an existing sent relay returns the same id with no second send', async () => {
    fake.write(`relays/${RELAY_ID}`, { status: 'sent', txHash: TX_HASH, personId: PERSON_ID });
    const res = (await action({ data: actionReq(), auth } as never)) as { relayId: string; status: string };
    expect(res).toEqual({ relayId: RELAY_ID, status: 'sent', txHash: TX_HASH });
    expect(sendRelayed).not.toHaveBeenCalled();
    expect(estimateContractGas).not.toHaveBeenCalled();
  });

  it('rate-limits a person with five pending relays', async () => {
    for (let i = 0; i < 5; i++) fake.write(`relays/pending-${i}`, { status: 'pending', personId: PERSON_ID });
    await expect(action({ data: actionReq(), auth } as never)).rejects.toMatchObject({
      code: 'resource-exhausted',
      details: { code: 'TOO_MANY_PENDING' },
    });
    expect(sendRelayed).not.toHaveBeenCalled();
  });
});

describe('relayAction — usage ledger + org rate limit (design §4)', () => {
  const SET_ADMIN = encodeFunctionData({ abi: organizersAbi, functionName: 'setAdmin', args: [ORG_ID, OTHER, 1] });
  const APPROVE = encodeFunctionData({ abi: ticketAbi, functionName: 'approveClaims', args: [EVENT_ID, [1n, 2n]] });
  const SET_NICK = ACTION_ALLOWLIST.setNickname!.selector;
  const GAS = { status: 'success', logs: [] as unknown[], blockNumber: 100n, gasUsed: 210_000n, effectiveGasPrice: 50_000_000_000n };

  function req(kind: string, to: string, data: string, nonce = '0') {
    return { data: { kind, req: { from: ACCOUNT, to, nonce, deadline: futureDeadline(), data }, deviceSig: DEVICE_SIG }, auth };
  }

  it('records org-scoped usage as a bigint wei string and stamps orgId on the relay (orgId-first kind)', async () => {
    waitForTransactionReceipt.mockResolvedValueOnce(GAS);
    await action(req('setAdmin', ORGANIZERS, SET_ADMIN) as never);
    const u = fake.snapshot('usage/org:7');
    expect(u.get('count')).toBe(1);
    expect(u.get('lastKind')).toBe('setAdmin');
    // 210000 × 50e9 = 1.05e16 (> 2^53) — 반드시 문자열 bigint 로 남는다.
    expect(u.get('monSpentWei')).toBe('10500000000000000');
    expect(typeof u.get('monSpentWei')).toBe('string');
    expect(fake.snapshot(`relays/${ACCOUNT}:0`).get('orgId')).toBe('7');
  });

  it('derives the org from eventOrg(eventId) for an eventId-first kind', async () => {
    waitForTransactionReceipt.mockResolvedValueOnce({ status: 'success', logs: [], blockNumber: 100n, gasUsed: 100n, effectiveGasPrice: 2n } as never);
    await action(req('approveClaims', TICKET, APPROVE) as never);
    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: 'eventOrg' }));
    expect(fake.snapshot('usage/org:7').get('monSpentWei')).toBe('200');
    expect(fake.snapshot(`relays/${ACCOUNT}:0`).get('orgId')).toBe('7');
  });

  it('records person-scoped usage for a personal kind and stamps no orgId', async () => {
    waitForTransactionReceipt.mockResolvedValueOnce(GAS);
    await action(req('setNickname', IDENTITY, SET_NICK) as never);
    const u = fake.snapshot(`usage/person:${PERSON_ID}`);
    expect(u.get('count')).toBe(1);
    expect(u.get('lastKind')).toBe('setNickname');
    expect(fake.snapshot(`relays/${ACCOUNT}:0`).get('orgId')).toBeUndefined();
  });

  it('accumulates monSpentWei across two confirmations for the same org', async () => {
    waitForTransactionReceipt.mockResolvedValueOnce(GAS);
    await action(req('setAdmin', ORGANIZERS, SET_ADMIN, '0') as never);
    chainNonce = 1n;
    waitForTransactionReceipt.mockResolvedValueOnce(GAS);
    await action(req('setAdmin', ORGANIZERS, SET_ADMIN, '1') as never);
    const u = fake.snapshot('usage/org:7');
    expect(u.get('count')).toBe(2);
    expect(u.get('monSpentWei')).toBe('21000000000000000');
  });

  it('rejects an org that already has 60 relays in the last hour', async () => {
    for (let i = 0; i < 60; i += 1) {
      fake.write(`relays/o-${i}`, { orgId: '7', createdAt: Timestamp.now(), personId: `0x${i.toString().padStart(64, '0')}` });
    }
    await expect(action(req('setAdmin', ORGANIZERS, SET_ADMIN) as never)).rejects.toMatchObject({
      code: 'resource-exhausted',
      details: { code: 'TOO_MANY_FOR_ORG' },
    });
    expect(sendRelayed).not.toHaveBeenCalled();
  });

  it('counts only the last hour — an old relay does not fill the window', async () => {
    fake.write('relays/o-old', { orgId: '7', createdAt: Timestamp.fromMillis(Date.now() - 2 * 60 * 60 * 1000), personId: `0x${'01'.repeat(32)}` });
    for (let i = 0; i < 59; i += 1) {
      fake.write(`relays/o-${i}`, { orgId: '7', createdAt: Timestamp.now(), personId: `0x${i.toString().padStart(64, '0')}` });
    }
    waitForTransactionReceipt.mockResolvedValueOnce(GAS);
    const res = (await action(req('setAdmin', ORGANIZERS, SET_ADMIN) as never)) as { status: string };
    expect(res.status).toBe('confirmed');
  });
});

describe('actionAllowlist', () => {
  const abiFor = (target: string): Abi =>
    target === 'organizers' ? organizersAbi : target === 'identity' ? identityAbi : ticketAbi;

  it('maps every kind to exactly one 4-byte selector, all distinct', () => {
    const entries = Object.values(ACTION_ALLOWLIST);
    expect(entries.length).toBe(24); // §2 표 23개 + createOrganizer
    const selectors = new Set<string>();
    for (const entry of entries) {
      expect(entry.selector).toMatch(/^0x[0-9a-f]{8}$/);
      selectors.add(entry.selector);
    }
    expect(selectors.size).toBe(entries.length);
  });

  it('every selector resolves to exactly one function in the deployed target ABI', () => {
    for (const [kind, entry] of Object.entries(ACTION_ALLOWLIST)) {
      const fns = (abiFor(entry.target) as readonly { type: string }[]).filter((i) => i.type === 'function');
      const match = fns.filter((fn) => toFunctionSelector(fn as never) === entry.selector);
      expect(match, `${kind} → ${entry.target}`).toHaveLength(1);
    }
  });

  it('contains no removed 4337/paymaster or Phase-1 issue/check-in selector', () => {
    const present = new Set(Object.values(ACTION_ALLOWLIST).map((e) => e.selector));
    const forbidden = [
      'function validatePaymasterUserOp((address,uint256,bytes,bytes,uint256,uint256,uint256,uint256,uint256,bytes,bytes),bytes32,uint256)',
      'function claimFor((uint256,uint8,address,uint256,uint64),bytes)',
      'function requestClaimFor((uint256,uint8,address,uint256,uint64),bytes)',
      'function checkInFor(uint256,(uint256,uint256,uint64,bytes32),bytes,bytes)',
      'function checkInForLate(uint256,(uint256,uint256,uint64,bytes32),bytes,bytes)',
    ];
    for (const sig of forbidden) expect(present.has(toFunctionSelector(sig))).toBe(false);
  });
});
