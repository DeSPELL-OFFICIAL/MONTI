import { describe, expect, it } from 'vitest';
import { canonicalJson, snapshotDigest, type UnsignedSnapshot } from './encoding.js';
import type { Hex } from './types.js';

const X = ('0x' + '11'.repeat(32)) as Hex;
const Y = ('0x' + '22'.repeat(32)) as Hex;
const ACC = '0x0000000000000000000000000000000000000001' as Hex;

const snapshot: UnsignedSnapshot = {
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

describe('canonicalJson', () => {
  it('sorts keys recursively and emits no whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it('lowercases 0x hex strings but leaves other strings alone', () => {
    expect(canonicalJson({ k: '0xAaBb' })).toBe('{"k":"0xaabb"}');
    expect(canonicalJson({ k: 'Alex' })).toBe('{"k":"Alex"}');
  });

  it('keeps array order because it is meaningful', () => {
    expect(canonicalJson([2, 1])).toBe('[2,1]');
  });

  it('rejects a non-integer or non-finite number', () => {
    expect(() => canonicalJson({ k: 1.5 })).toThrow('NON_INTEGER_NUMBER');
    expect(() => canonicalJson({ k: Number.NaN })).toThrow('NON_INTEGER_NUMBER');
  });

  it('produces the exact snapshot string the staff device rebuilds offline', () => {
    expect(canonicalJson(snapshot)).toBe(
      `{"epoch":3,"eventId":"11","eventTitle":"몬티 데모 공연","expiresAt":1789862400,"requireKyc":true,"tickets":[{"account":"${ACC}","checkedIn":false,"deviceX":"${X}","deviceY":"${Y}","displayName":"홍길동","photoJpegB64":"AAA=","seat":"","tier":0,"tierName":"일반","tokenId":"7"}],"v":1}`,
    );
  });

  it('is independent of key insertion order', () => {
    const shuffled = {
      requireKyc: true,
      expiresAt: snapshot.expiresAt,
      tickets: [
        {
          checkedIn: false, seat: '', tier: 0, tierName: '일반', displayName: '홍길동',
          photoJpegB64: 'AAA=', deviceY: Y, deviceX: X, account: ACC, tokenId: '7',
        },
      ],
      epoch: 3,
      eventTitle: '몬티 데모 공연',
      eventId: '11',
      v: 1,
    } as UnsignedSnapshot;
    expect(canonicalJson(shuffled)).toBe(canonicalJson(snapshot));
  });
});

describe('snapshotDigest', () => {
  it('matches the fixed keccak256 vector shared with sub-plan 04', () => {
    expect(snapshotDigest(snapshot)).toBe(
      '0xeef6e400e1e294b333d2b8eacda0fddf69f580a6eb0875b07cf192ea781261a1',
    );
  });

  it('refuses a snapshot that still carries attesterSig', () => {
    expect(() =>
      snapshotDigest({ ...snapshot, attesterSig: '0xdead' } as unknown as UnsignedSnapshot),
    ).toThrow('SNAPSHOT_ALREADY_SIGNED');
  });

  it('changes when one photo changes', () => {
    const tampered: UnsignedSnapshot = {
      ...snapshot,
      tickets: [{ ...snapshot.tickets[0]!, photoJpegB64: 'BBB=' }],
    };
    expect(snapshotDigest(tampered)).not.toBe(snapshotDigest(snapshot));
  });
});
