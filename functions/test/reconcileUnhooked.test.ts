import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import { getAddress } from 'viem';
import type { Hex } from '@monti/shared';
import { createFakeFirestore } from './helpers/fakeFirestore.js';
import { eventCreatedLog, policySetLog, publishCalldata } from './helpers/publishCalldata.js';

vi.mock('firebase-functions/logger', () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }));
vi.mock('../src/lib/chain.js', () => ({ publicClient: () => ({}) }));

const fake = createFakeFirestore();
vi.mock('../src/lib/db.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/db.js')>('../src/lib/db.js');
  return { ...actual, db: fake.db };
});

const { sweepUnhookedRelays } = await import('../src/functions/reconcileRelays.js');

const TICKET = getAddress(`0x${'ce'.repeat(20)}`);
const VAULT = getAddress(`0x${'5a'.repeat(20)}`);
const ORGANIZER = getAddress(`0x${'11'.repeat(20)}`);
const PAYEE = getAddress(`0x${'33'.repeat(20)}`);
const TX = `0x${'ab'.repeat(32)}` as Hex;
const data = publishCalldata({
  orgId: 1001n,
  prices: [1500n],
  recipients: [{ account: PAYEE, bps: 10_000, reason: 'all', tag: 'artist' }],
});
const logs = [eventCreatedLog(TICKET, 1001n, 1001n, ORGANIZER), policySetLog(VAULT, 1001n, ORGANIZER, `0x${'77'.repeat(32)}`)];

function pc(status = 'success') {
  return { getTransactionReceipt: vi.fn(async () => ({ status, logs })) } as never;
}

function confirmed(id: string, over: Record<string, unknown> = {}) {
  fake.write(`relays/${id}`, {
    kind: 'publishEvent',
    status: 'confirmed',
    account: ORGANIZER,
    data,
    reasons: ['all'],
    txHash: TX,
    confirmedAt: Timestamp.fromMillis(Date.now() - 60_000),
    ...over,
  });
}

beforeEach(() => fake.docs.clear());

describe('sweepUnhookedRelays — confirmed by someone else (e.g. the v1 sweep) but never hooked', () => {
  it('fills result.eventId and writes the settlement mirror from the receipt', async () => {
    confirmed('r1');
    await sweepUnhookedRelays(pc());
    expect(fake.snapshot('relays/r1').get('result')).toEqual({ eventId: '1001' });
    expect(fake.snapshot('settlements/1001').data()).toMatchObject({
      orgId: '1001',
      priceUsdCentsByTier: { '0': 1500 },
      policy: { recipients: [{ account: PAYEE, bps: 10_000, reason: 'all', tag: 'artist' }] },
      txHash: TX,
    });
  });

  it('leaves relays that already have a result, other kinds and old confirmations alone', async () => {
    confirmed('done', { result: { eventId: '999' } });
    confirmed('claim', { kind: 'claim' });
    confirmed('old', { confirmedAt: Timestamp.fromMillis(Date.now() - 7 * 60 * 60 * 1000) });
    const client = pc();
    await sweepUnhookedRelays(client);
    expect(fake.snapshot('relays/done').get('result')).toEqual({ eventId: '999' });
    expect(fake.snapshot('relays/claim').get('result')).toBeUndefined();
    expect(fake.snapshot('relays/old').get('result')).toBeUndefined();
    expect(fake.docs.has('settlements/1001')).toBe(false);
  });

  it('is idempotent — a second sweep changes nothing', async () => {
    confirmed('r1');
    await sweepUnhookedRelays(pc());
    const first = fake.snapshot('settlements/1001').data();
    const client = pc();
    await sweepUnhookedRelays(client);
    expect((client as unknown as { getTransactionReceipt: ReturnType<typeof vi.fn> }).getTransactionReceipt).not.toHaveBeenCalled();
    expect(fake.snapshot('settlements/1001').data()).toEqual(first);
  });
});
