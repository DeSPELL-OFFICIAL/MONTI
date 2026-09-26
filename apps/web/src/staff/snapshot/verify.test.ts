import { describe, expect, it, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';

import type { SnapshotTicket, SnapshotWire, UnsignedSnapshot } from '@monti/shared';

const account = privateKeyToAccount(`0x${'11'.repeat(32)}`);

// The attester address is the deployments file's (`packages/shared/src/deployments/10143.json`,
// the same bytes as `contracts/deployments/10143.json`), read through `attesterAddress(chainId)`.
// Here it is replaced with a key this test owns, because the test needs to be able to *produce*
// a valid signature; `attesterAddress` itself is pinned by the shared package's own test.
vi.mock('@monti/shared', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  attesterAddress: () => account.address,
}));
vi.mock('../../shared/config', () => ({ getConfig: () => ({ chainId: 10143 }) }));

const { canonicalJson, snapshotDigest } = await import('@monti/shared');
const {
  SNAPSHOT_MAX_BYTES,
  SNAPSHOT_MAX_PHOTO_BASE64_BYTES,
  SNAPSHOT_MAX_TICKETS,
  SnapshotError,
  snapshotBody,
  snapshotFitsCaps,
  verifySnapshot,
} = await import('./verify');

const X = `0x${'11'.repeat(32)}` as const;
const Y = `0x${'22'.repeat(32)}` as const;
const ACC = '0x0000000000000000000000000000000000000001' as const;

/**
 * **The fixture is not this task's invention.** It is copied field for field from
 * `packages/shared/src/encoding.canonical.test.ts`, which is byte-identical in the backend
 * worktree (sub-plan 02) — the issuer and this verifier pin the same bytes, which is the whole
 * reason the canonicaliser lives in `@monti/shared` and is never re-implemented here.
 */
const body: UnsignedSnapshot = {
  v: 1,
  eventId: '11',
  eventTitle: '몬티 데모 공연',
  requireKyc: true,
  epoch: 3,
  expiresAt: 1_789_862_400,
  tickets: [
    {
      tokenId: '7',
      account: ACC,
      deviceX: X,
      deviceY: Y,
      photoJpegB64: 'AAA=',
      displayName: '홍길동',
      tier: 0,
      tierName: '일반',
      seat: '',
      checkedIn: false,
    },
  ],
};

/** The exact string both sides hash, and the keccak256 of it. Changing either is a wire break. */
const CANONICAL_JSON =
  `{"epoch":3,"eventId":"11","eventTitle":"몬티 데모 공연","expiresAt":1789862400,"requireKyc":true,` +
  `"tickets":[{"account":"${ACC}","checkedIn":false,"deviceX":"${X}","deviceY":"${Y}",` +
  `"displayName":"홍길동","photoJpegB64":"AAA=","seat":"","tier":0,"tierName":"일반","tokenId":"7"}],"v":1}`;
const CANONICAL_DIGEST = '0xeef6e400e1e294b333d2b8eacda0fddf69f580a6eb0875b07cf192ea781261a1';

const signed = async (over: UnsignedSnapshot = body): Promise<SnapshotWire> => ({
  ...over,
  attesterSig: await account.sign({ hash: snapshotDigest(over) }),
});

const ticketAt = (tokenId: number): SnapshotTicket => ({ ...body.tickets[0]!, tokenId: String(tokenId) });

describe('the canonical JSON the attester signed', () => {
  it('rebuilds the exact bytes sub-plan 02 pinned, and their keccak256', () => {
    expect(canonicalJson(body)).toBe(CANONICAL_JSON);
    expect(snapshotDigest(body)).toBe(CANONICAL_DIGEST);
  });

  it('snapshotBody strips attesterSig before the digest is taken', async () => {
    const wire = await signed();
    expect(snapshotBody(wire)).toEqual(body);
    expect(snapshotDigest(snapshotBody(wire))).toBe(CANONICAL_DIGEST);
  });

  it('lowercases 0x strings, so hex case cannot move the digest', () => {
    const withCase = (hex: string) => ({
      ...body,
      tickets: [{ ...body.tickets[0]!, deviceX: hex as typeof X }],
    });
    expect(snapshotDigest(withCase(`0x${'AB'.repeat(32)}`))).toBe(
      snapshotDigest(withCase(`0x${'ab'.repeat(32)}`)),
    );
  });

  it('rejects a non-integer number rather than rounding it into a different snapshot', () => {
    expect(() => snapshotDigest({ ...body, epoch: 3.5 })).toThrow('NON_INTEGER_NUMBER');
  });
});

describe('the attester signature', () => {
  it('accepts a signature by the attester', async () => {
    expect(await verifySnapshot(await signed())).toBe(true);
  });

  it('rejects anyone else’s signature, however well formed', async () => {
    const other = privateKeyToAccount(`0x${'22'.repeat(32)}`);
    const attesterSig = await other.sign({ hash: snapshotDigest(body) });
    expect(await verifySnapshot({ ...body, attesterSig })).toBe(false);
  });

  it('rejects a snapshot whose tickets were edited after signing', async () => {
    const wire = await signed();
    const tampered = { ...wire, tickets: [{ ...wire.tickets[0]!, checkedIn: true }] };
    expect(await verifySnapshot(tampered)).toBe(false);
  });

  it('rejects unreadable signature bytes instead of throwing at the door', async () => {
    expect(await verifySnapshot({ ...body, attesterSig: '0xdeadbeef' })).toBe(false);
  });
});

/**
 * The caps are sub-plan 02's (`functions/src/functions/snapshot.ts`). The backend refuses to
 * *issue* anything over them, so a snapshot that breaks one did not come from our backend —
 * the device refuses it whole rather than trusting part of it.
 */
describe('the caps the backend issues within', () => {
  it('agrees with the backend’s three numbers', () => {
    expect(SNAPSHOT_MAX_TICKETS).toBe(500);
    expect(SNAPSHOT_MAX_PHOTO_BASE64_BYTES).toBe(32 * 1024);
    expect(SNAPSHOT_MAX_BYTES).toBe(8 * 1024 * 1024);
  });

  it('accepts a snapshot sitting exactly on the ticket cap', () => {
    const tickets = Array.from({ length: SNAPSHOT_MAX_TICKETS }, (_, i) => ticketAt(i));
    expect(snapshotFitsCaps({ ...body, tickets })).toBe(true);
  });

  it('refuses one ticket past the cap', () => {
    const tickets = Array.from({ length: SNAPSHOT_MAX_TICKETS + 1 }, (_, i) => ticketAt(i));
    expect(snapshotFitsCaps({ ...body, tickets })).toBe(false);
  });

  it('refuses a photo the backend would never have emitted', () => {
    const fat = { ...body.tickets[0]!, photoJpegB64: 'A'.repeat(SNAPSHOT_MAX_PHOTO_BASE64_BYTES + 1) };
    expect(snapshotFitsCaps({ ...body, tickets: [fat] })).toBe(false);
  });

  it('refuses a body over the whole-snapshot byte cap', () => {
    const tickets = Array.from({ length: 300 }, (_, i) => ({
      ...ticketAt(i),
      photoJpegB64: 'A'.repeat(SNAPSHOT_MAX_PHOTO_BASE64_BYTES),
    }));
    expect(snapshotFitsCaps({ ...body, tickets })).toBe(false);
  });

  it('measures UTF-8 bytes, not JavaScript string length', () => {
    // 한글 한 글자는 3바이트다. 길이로 재면 한도를 3배 헐겁게 잡는다.
    const title = '가'.repeat(Math.ceil(SNAPSHOT_MAX_BYTES / 3));
    expect(snapshotFitsCaps({ ...body, eventTitle: title })).toBe(false);
  });
});

describe('SnapshotError', () => {
  it('names the two refusals the store can raise', () => {
    for (const code of ['SNAPSHOT_BAD_SIG', 'SNAPSHOT_TOO_LARGE'] as const) {
      const error = new SnapshotError(code);
      expect(error.code).toBe(code);
      expect(error.message).toBe(code);
      expect(error).toBeInstanceOf(Error);
    }
  });
});
