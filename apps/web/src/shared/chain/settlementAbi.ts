import { parseAbi } from 'viem';

/**
 * A minimal hand-written slice of `SettlementVault` — only the reads the web app needs for
 * Milestone 1 (the policy nonce the organizer signs against, the digest-parity view, and the
 * frozen-on-sale policy a screen reads back). B2 swaps the full generated ABI later, exactly as
 * `abis.ts` uses the generated Identity/Organizers/Ticket ABIs; a hand fragment carries no
 * events, so this is reads only.
 *
 * `getPolicy` returns one `SplitPolicy` struct — a *single* tuple output, dynamic because of its
 * `Recipient[]`, so it is written as one named tuple (the triple paren: the returns list, the
 * `policy` tuple, then the `Recipient` tuple inside it). Modelling it as six separate outputs
 * would decode the wrong bytes, because a single dynamic struct return carries an extra offset
 * word the unpacked form does not. The field order mirrors
 * `contracts/src/interfaces/ISettlementVault.sol` exactly; viem decodes positionally, so this
 * order and {@link ChainPolicy} in `settlementReads.ts` move together.
 */
export const settlementVaultAbi = parseAbi([
  'function policyNonce(address organizer) view returns (uint256)',
  'function setPolicyDigest(uint256 eventId, bytes32 policyHash, uint256 nonce, uint64 deadline) view returns (bytes32)',
  'function getPolicy(uint256 eventId) view returns (((address account, uint16 bps, bytes32 reasonHash, bytes32 tag)[] recipients, uint16 platformBps, uint16 reserveBps, bool noShowRefund, bool frozen, uint32 version) policy)',
]);
