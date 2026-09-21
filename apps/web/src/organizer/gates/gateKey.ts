import { getAddress, isAddress, type Hex } from 'viem';

/**
 * What the organiser may not send to `Organizers.registerGate`, whether it came off the
 * pending queue or was typed in by hand. Each one is a key in `organizerCopy.gates.problems`.
 */
export type GateKeyProblem = 'account' | 'key' | 'halfZero';

const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;
const ZERO_KEY = `0x${'00'.repeat(32)}`;

export interface GateKeyInput {
  gateAccount: string;
  kx: string;
  ky: string;
}

export interface GateKeyArgs {
  gateAccount: Hex;
  kx: Hex;
  ky: Hex;
}

/**
 * The terminal's address and its P-256 public point, or the first rule they break.
 *
 * The half-zero rule is the one worth spelling out. `registerGate` refuses a key only when
 * `kx` **and** `ky` are both zero (`InvalidGateKey`), so a key with one zero half is written
 * to the allowlist exactly as given — and it is not a point on the curve, so that terminal
 * then verifies no entry at all. Catching it here costs a sentence; catching it afterwards
 * costs a `revokeGate` and a second registration at the venue. The backend's queue applies the
 * same rule before a row is ever listed (functions/src/functions/pendingGates.ts).
 *
 * The address is checked with viem's strict test, so a mixed-case address whose EIP-55
 * checksum does not add up is refused rather than registered — one mistyped character in an
 * address copied off a terminal screen is exactly what the checksum exists to catch.
 */
export function readGateKey(input: GateKeyInput): { args: GateKeyArgs } | { problem: GateKeyProblem } {
  const gateAccount = input.gateAccount.trim();
  if (!isAddress(gateAccount, { strict: true })) return { problem: 'account' };

  const kx = input.kx.trim().toLowerCase();
  const ky = input.ky.trim().toLowerCase();
  if (!BYTES32_RE.test(kx) || !BYTES32_RE.test(ky)) return { problem: 'key' };
  if (kx === ZERO_KEY || ky === ZERO_KEY) return { problem: 'halfZero' };

  return { args: { gateAccount: getAddress(gateAccount), kx: kx as Hex, ky: ky as Hex } };
}
