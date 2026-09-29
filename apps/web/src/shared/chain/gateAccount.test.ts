import { encodeAbiParameters, getAddress, keccak256, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';

import { gateAccountAddress } from './gateAccount';

/** One fixed gate device key: Task 11 reports `x` and `y` as separate 32-byte words. */
const KX = `0x${'11'.repeat(32)}` as Hex;
const KY = `0x${'22'.repeat(32)}` as Hex;

/**
 * The identifier `Organizers.registerGate` records for this key, pinned against the Solidity it
 * mirrors: `address(uint160(uint256(keccak256(abi.encode(kx, ky)))))`. Read off viem itself once
 * and frozen here, so a drift in the derivation stops matching. Since Phase 2 the gate never sends
 * a transaction (check-ins are relayed with its P-256 signature), so this is a deterministic label
 * rather than a deployable smart-account address — anyone holding the public key recomputes it.
 */
const GATE_ADDRESS = '0xf62fffa4D92bcDfc310dcCbE943747FE8302e871';

describe('gateAccountAddress', () => {
  it('is the low 20 bytes of keccak256(abi.encode(kx, ky)), checksummed', () => {
    expect(gateAccountAddress(KX, KY)).toBe(GATE_ADDRESS);

    // The formula written out, so the literal above is the derivation and not a copy of the output.
    const packed = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }], [KX, KY]));
    expect(gateAccountAddress(KX, KY)).toBe(getAddress(`0x${packed.slice(-40)}`));
  });

  it('is a pure function of the key: swapped halves and any other key give another address', () => {
    expect(gateAccountAddress(KY, KX)).not.toBe(GATE_ADDRESS);
    expect(gateAccountAddress(`0x${'33'.repeat(32)}`, KY)).not.toBe(GATE_ADDRESS);
  });

  it('returns a checksummed 20-byte address', () => {
    const address = gateAccountAddress(KX, KY);
    expect(address).toBe(getAddress(address));
    expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});
