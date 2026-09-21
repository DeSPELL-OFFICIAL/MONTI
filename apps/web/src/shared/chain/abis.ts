/**
 * The generated ABIs, events included, exactly as sub-plan 01's `export-abi.sh` produced them
 * and `@monti/shared` re-exports them. Nothing here is hand-written: a hand-made fragment
 * carries no events, so `encodeEventTopics` would not find `CheckedIn`, and its `{name,type}`
 * key order never matches solc's `{internalType,name,type}`.
 *
 * Task 9 of this sub-plan still owes the `USED_ABI` usage manifest and its conformance test,
 * which pins the signatures this app calls against the generated JSON.
 */
export { identityAbi, organizersAbi, ticketAbi } from '@monti/shared';
