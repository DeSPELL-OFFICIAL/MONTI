import { parseAbi } from 'viem';

/**
 * A minimal hand-written slice of `SettlementVault` — the one read the web app makes: the split
 * policy frozen at publish (v2 sets it inside `Ticket.publishEvent`, so there is no nonce or
 * digest to read any more). A hand fragment carries no events, so this is reads only.
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
  'function getPolicy(uint256 eventId) view returns (((address account, uint16 bps, bytes32 reasonHash, bytes32 tag)[] recipients, uint16 platformBps, uint16 reserveBps, bool noShowRefund, bool frozen, uint32 version) policy)',
]);
