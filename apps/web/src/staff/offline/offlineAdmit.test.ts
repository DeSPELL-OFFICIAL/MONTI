import { bytesToHex, hexToBytes } from 'viem';
import { describe, expect, it, vi } from 'vitest';

import { GATE_DENY_CODES, type SnapshotWire } from '@monti/shared';

import { GATE_STATES, type GateCodeWire, type GateResponseWire, type Hex, type SnapshotTicket } from '../types';
import { offlineAdmit, type QueuedTaps } from './offlineAdmit';
import { checkInMessage, type DeviceDigestDomain } from './offlineVerify';

const P256 = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const ECDSA_SHA256 = { name: 'ECDSA', hash: 'SHA-256' } as const;
const copy = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => Uint8Array.from(bytes);

const DOMAIN: DeviceDigestDomain = {
  chainId: 31337n,
  ticket: '0x7111111111111111111111111111111111111111',
};

const code: GateCodeWire = {
  v: 1,
  gateId: '7',
  eventId: '42',
  issuedAt: 1_700_000_000,
  nonce: `0x${'11'.repeat(32)}`,
  kx: `0x${'aa'.repeat(32)}`,
  ky: `0x${'bb'.repeat(32)}`,
  sig: `0x${'cc'.repeat(64)}`,
};

async function attendee(): Promise<{ x: Hex; y: Hex; sign: (message: Hex) => Promise<Hex> }> {
  const pair = (await crypto.subtle.generateKey(P256, true, ['sign', 'verify'])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return {
    x: bytesToHex(raw.slice(1, 33)),
    y: bytesToHex(raw.slice(33, 65)),
    sign: async (message) =>
      bytesToHex(new Uint8Array(await crypto.subtle.sign(ECDSA_SHA256, pair.privateKey, copy(hexToBytes(message))))),
  };
}

function ticketRow(x: Hex, y: Hex, over: Partial<SnapshotTicket> = {}): SnapshotTicket {
  return {
    tokenId: '123',
    account: `0x${'aa'.repeat(20)}`,
    deviceX: x,
    deviceY: y,
    photoJpegB64: 'x',
    displayName: '김입장',
    tier: 0,
    tierName: 'General',
    seat: '',
    checkedIn: false,
    ...over,
  };
}

function snapshotOf(ticket: SnapshotTicket, over: Partial<SnapshotWire> = {}): SnapshotWire {
  return {
    v: 1,
    eventId: '42',
    eventTitle: '가을 밤 콘서트',
    requireKyc: true,
    epoch: 1,
    expiresAt: 2_000_000_000,
    tickets: [ticket],
    attesterSig: `0x${'00'.repeat(65)}`,
    ...over,
  };
}

/** A tap signed for real by the key the snapshot carries — the only thing that can be admitted. */
async function goodTap(): Promise<{ snapshot: SnapshotWire; response: GateResponseWire; ticket: SnapshotTicket }> {
  const phone = await attendee();
  const ticket = ticketRow(phone.x, phone.y);
  const deviceSig = await phone.sign(checkInMessage({ tokenId: '123', code, domain: DOMAIN }));
  return { snapshot: snapshotOf(ticket), ticket, response: { v: 2, tokenId: '123', nonce: code.nonce, deviceSig } };
}

const noTaps: QueuedTaps = async () => [];

function ports() {
  return { enqueue: vi.fn(async () => ({ id: '123-x' }) as never), queued: noTaps };
}

describe('a tap the snapshot and the device key both accept', () => {
  it('is OFFLINE ADMIT, and hands the tap to the durable queue', async () => {
    const { snapshot, response, ticket } = await goodTap();
    const { enqueue } = ports();
    const decision = await offlineAdmit({
      snapshot,
      code,
      response,
      orgId: 5n,
      domain: DOMAIN,
      enqueue,
      queued: noTaps,
    });

    expect(decision.outcome).toBe('offlineAdmit');
    expect(decision.ticket).toEqual(ticket);
    expect(decision.deny).toBeUndefined();
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith({ code, response, orgId: 5n });
  });

  it('is never the online green: the outcome is the gate state that says "not on chain yet"', async () => {
    const { snapshot, response } = await goodTap();
    const decision = await offlineAdmit({ snapshot, code, response, orgId: 5n, domain: DOMAIN, ...ports() });
    expect(decision.outcome).not.toBe('admit');
    expect(GATE_STATES).toContain('offlineAdmit');
    expect(GATE_STATES).toContain(decision.outcome);
  });

  it('hands back the row the queue committed, so the card is drawn from a persisted tap', async () => {
    const { snapshot, response } = await goodTap();
    const entry = { id: `123-${code.nonce}`, tokenId: '123' };
    const decision = await offlineAdmit({
      snapshot,
      code,
      response,
      orgId: 5n,
      domain: DOMAIN,
      enqueue: vi.fn(async () => entry as never),
      queued: noTaps,
    });
    expect(decision.entry).toBe(entry);
  });

  it('admits the same tap twice — one NFC presentation read twice is one row, not a refusal', async () => {
    const { snapshot, response } = await goodTap();
    const enqueue = vi.fn(async () => ({ id: `123-${code.nonce}` }) as never);
    const queued: QueuedTaps = async () => [{ tokenId: '123', gateCode: { nonce: code.nonce } }];
    const decision = await offlineAdmit({ snapshot, code, response, orgId: 5n, domain: DOMAIN, enqueue, queued });
    expect(decision.outcome).toBe('offlineAdmit');
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
});

describe('the local rules, each with its own DENY code', () => {
  it('ALREADY_USED when the snapshot already carries the check-in', async () => {
    const { snapshot, response } = await goodTap();
    const used = snapshotOf({ ...(snapshot.tickets[0] as SnapshotTicket), checkedIn: true });
    const { enqueue } = ports();
    const decision = await offlineAdmit({
      snapshot: used,
      code,
      response,
      orgId: 5n,
      domain: DOMAIN,
      enqueue,
      queued: noTaps,
    });
    expect(decision).toMatchObject({ outcome: 'deny', deny: 'ALREADY_USED' });
    expect(decision.ticket?.tokenId).toBe('123');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('ALREADY_USED when this gate already queued this ticket under another code', async () => {
    const { snapshot, response } = await goodTap();
    const { enqueue } = ports();
    const queued: QueuedTaps = async () => [{ tokenId: '123', gateCode: { nonce: `0x${'99'.repeat(32)}` } }];
    const decision = await offlineAdmit({ snapshot, code, response, orgId: 5n, domain: DOMAIN, enqueue, queued });
    expect(decision).toMatchObject({ outcome: 'deny', deny: 'ALREADY_USED' });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('lets another ticket through while one is queued', async () => {
    const { snapshot, response } = await goodTap();
    const { enqueue } = ports();
    const queued: QueuedTaps = async () => [{ tokenId: '999', gateCode: { nonce: `0x${'99'.repeat(32)}` } }];
    const decision = await offlineAdmit({ snapshot, code, response, orgId: 5n, domain: DOMAIN, enqueue, queued });
    expect(decision.outcome).toBe('offlineAdmit');
  });

  it('WRONG_EVENT when the gate’s own code and the gate’s own snapshot disagree', async () => {
    const { snapshot, response } = await goodTap();
    const { enqueue } = ports();
    const decision = await offlineAdmit({
      snapshot: { ...snapshot, eventId: '43' },
      code,
      response,
      orgId: 5n,
      domain: DOMAIN,
      enqueue,
      queued: noTaps,
    });
    expect(decision).toMatchObject({ outcome: 'deny', deny: 'WRONG_EVENT' });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('DEVICE_LOCKED when the snapshot carries no device key for the ticket', async () => {
    const { snapshot, response } = await goodTap();
    const cleared = snapshotOf({ ...(snapshot.tickets[0] as SnapshotTicket), deviceX: `0x${'00'.repeat(32)}` });
    const { enqueue } = ports();
    const decision = await offlineAdmit({
      snapshot: cleared,
      code,
      response,
      orgId: 5n,
      domain: DOMAIN,
      enqueue,
      queued: noTaps,
    });
    expect(decision).toMatchObject({ outcome: 'deny', deny: 'DEVICE_LOCKED' });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('NO_TICKET for a token this guest list has never heard of — offline there is nothing to ask', async () => {
    const { snapshot, response } = await goodTap();
    const { enqueue } = ports();
    const decision = await offlineAdmit({
      snapshot,
      code,
      response: { ...response, tokenId: '999' },
      orgId: 5n,
      domain: DOMAIN,
      enqueue,
      queued: noTaps,
    });
    expect(decision).toMatchObject({ outcome: 'deny', deny: 'NO_TICKET' });
    expect(decision.ticket).toBeUndefined();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('NO_TICKET before the first snapshot lands — a revoked ticket looks exactly like this too', async () => {
    const { response } = await goodTap();
    const { enqueue } = ports();
    const decision = await offlineAdmit({
      snapshot: undefined,
      code,
      response,
      orgId: 5n,
      domain: DOMAIN,
      enqueue,
      queued: noTaps,
    });
    expect(decision).toMatchObject({ outcome: 'deny', deny: 'NO_TICKET' });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('DEVICE_MISMATCH when the signature is not the snapshot key’s (T15)', async () => {
    const { snapshot, response } = await goodTap();
    const impostor = await attendee();
    const forged = await impostor.sign(checkInMessage({ tokenId: '123', code, domain: DOMAIN }));
    const { enqueue } = ports();
    const decision = await offlineAdmit({
      snapshot,
      code,
      response: { ...response, deviceSig: forged },
      orgId: 5n,
      domain: DOMAIN,
      enqueue,
      queued: noTaps,
    });
    expect(decision).toMatchObject({ outcome: 'deny', deny: 'DEVICE_MISMATCH' });
    expect(decision.ticket?.tokenId).toBe('123');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('DEVICE_MISMATCH for a signature over a code this gate is not asking about', async () => {
    const phone = await attendee();
    const snapshot = snapshotOf(ticketRow(phone.x, phone.y));
    const elsewhere = { ...code, nonce: `0x${'22'.repeat(32)}` as Hex };
    const deviceSig = await phone.sign(checkInMessage({ tokenId: '123', code: elsewhere, domain: DOMAIN }));
    const { enqueue } = ports();
    const decision = await offlineAdmit({
      snapshot,
      code,
      response: { v: 2, tokenId: '123', nonce: code.nonce, deviceSig },
      orgId: 5n,
      domain: DOMAIN,
      enqueue,
      queued: noTaps,
    });
    expect(decision).toMatchObject({ outcome: 'deny', deny: 'DEVICE_MISMATCH' });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('names a code the attendee’s phone can show a sentence for, every time', async () => {
    const { snapshot, response } = await goodTap();
    const refusals = await Promise.all([
      offlineAdmit({ snapshot: { ...snapshot, eventId: '43' }, code, response, orgId: 5n, domain: DOMAIN, ...ports() }),
      offlineAdmit({ snapshot: undefined, code, response, orgId: 5n, domain: DOMAIN, ...ports() }),
      offlineAdmit({
        snapshot: snapshotOf({ ...(snapshot.tickets[0] as SnapshotTicket), checkedIn: true }),
        code,
        response,
        orgId: 5n,
        domain: DOMAIN,
        ...ports(),
      }),
    ]);
    for (const decision of refusals) {
      expect(decision.outcome).toBe('deny');
      expect(GATE_DENY_CODES).toContain(decision.deny);
    }
  });
});

describe('what an offline admit refuses to do', () => {
  it('never admits on a tap it could not verify, whatever the snapshot says about the person', async () => {
    const { snapshot, response } = await goodTap();
    const { enqueue } = ports();
    const decision = await offlineAdmit({
      snapshot,
      code,
      response: { ...response, deviceSig: `0x${'00'.repeat(64)}` },
      orgId: 5n,
      domain: DOMAIN,
      enqueue,
      queued: noTaps,
    });
    expect(decision.outcome).toBe('deny');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('does not admit if the queue could not write the tap down', async () => {
    const { snapshot, response } = await goodTap();
    const enqueue = vi.fn(async () => {
      throw new Error('QuotaExceededError');
    });
    await expect(
      offlineAdmit({ snapshot, code, response, orgId: 5n, domain: DOMAIN, enqueue: enqueue as never, queued: noTaps }),
    ).rejects.toThrow('QuotaExceededError');
  });
});
