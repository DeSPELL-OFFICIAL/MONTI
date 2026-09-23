import { describe, expect, it } from 'vitest';
import { getAddress } from 'viem';
import { readGateKey } from './gateKey';

const GATE = getAddress(`0x${'dd'.repeat(20)}`);
const KX = `0x${'01'.repeat(32)}`;
const KY = `0x${'02'.repeat(32)}`;
const ZERO = `0x${'00'.repeat(32)}`;

describe('readGateKey', () => {
  it('normalises a good terminal to the arguments registerGate takes', () => {
    expect(readGateKey({ gateAccount: GATE.toLowerCase(), kx: KX.toUpperCase(), ky: KY })).toEqual({
      args: { gateAccount: GATE, kx: KX, ky: KY },
    });
  });

  it('trims what was pasted, because a copied value brings whitespace with it', () => {
    expect(readGateKey({ gateAccount: ` ${GATE} `, kx: ` ${KX}\n`, ky: `${KY} ` })).toEqual({
      args: { gateAccount: GATE, kx: KX, ky: KY },
    });
  });

  /**
   * The rule this module exists for. `Organizers.registerGate` reverts `InvalidGateKey` only
   * when `kx == 0 && ky == 0`, so a key with one zero half is written to the allowlist exactly
   * as given — and it is not a point on P-256, so that terminal verifies no entry at all.
   * Catching it costs a sentence; missing it costs a `revokeGate` and a re-registration at the
   * venue door. The backend's queue applies the same rule.
   */
  it('refuses a key with one zero half, which the contract accepts', () => {
    expect(readGateKey({ gateAccount: GATE, kx: ZERO, ky: KY })).toEqual({ problem: 'halfZero' });
    expect(readGateKey({ gateAccount: GATE, kx: KX, ky: ZERO })).toEqual({ problem: 'halfZero' });
    expect(readGateKey({ gateAccount: GATE, kx: ZERO, ky: ZERO })).toEqual({ problem: 'halfZero' });
  });

  it('refuses a key that is not 32 bytes of hex', () => {
    expect(readGateKey({ gateAccount: GATE, kx: '0x01', ky: KY })).toEqual({ problem: 'key' });
    expect(readGateKey({ gateAccount: GATE, kx: KX, ky: `0x${'zz'.repeat(32)}` })).toEqual({ problem: 'key' });
  });

  it('refuses an address that is not one, or whose checksum does not add up', () => {
    expect(readGateKey({ gateAccount: '0xnope', kx: KX, ky: KY })).toEqual({ problem: 'account' });
    expect(readGateKey({ gateAccount: '', kx: KX, ky: KY })).toEqual({ problem: 'account' });
    // One character of a mixed-case address mistyped: exactly what EIP-55 is for.
    const broken = `0xA${GATE.slice(3)}`;
    expect(readGateKey({ gateAccount: broken, kx: KX, ky: KY })).toEqual({ problem: 'account' });
  });
});
