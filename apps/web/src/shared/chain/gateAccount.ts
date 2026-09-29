import { encodeAbiParameters, getAddress, keccak256, type Address, type Hex } from 'viem';

/**
 * The gate terminal's on-chain identifier.
 *
 * Since Phase 2 a gate never sends its own transaction: a check-in is relayed with the gate's
 * P-256 signature (recomputed and verified on chain against `Organizers.gateInfo`) and the
 * relayer's own EOA pays the gas. `Ticket._admit` no longer checks `msg.sender == gate`, so the
 * "gate account" is no longer a Coinbase Smart Wallet — there is nothing to deploy and nothing to
 * sign a UserOperation with. It is only the address `Organizers.registerGate` records and that any
 * verifier can recompute from the same public key.
 *
 * It is the low 20 bytes of `keccak256(abi.encode(kx, ky))` over the gate's 64-byte P-256 public
 * key — the TypeScript equivalent of Solidity's
 * `address(uint160(uint256(keccak256(abi.encode(kx, ky)))))`. `kx` and `ky` are the two `bytes32`
 * halves `gateKeyCoordinates` reports and `registerGate` stores, so the same key always resolves
 * to the same identifier on any device and for any reader.
 */
export function gateAccountAddress(kx: Hex, ky: Hex): Address {
  const packed = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }], [kx, ky]));
  return getAddress(`0x${packed.slice(-40)}`);
}
