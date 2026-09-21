import type { Abi } from 'viem';

/**
 * Empty placeholders so `ops.ts` and its thin wrappers (`ticketOp`, `identityOp`,
 * `organizersOp`) compile and can be unit-tested against a mocked `./abis`.
 *
 * The real ABIs are produced by sub-plan 01 Task 33 as `packages/shared/src/abi/*.json`
 * and wired into this file by sub-plan 03 Task 9, which replaces it wholesale.
 * Do NOT hand-author fragments here.
 */
export const ticketAbi = [] as const satisfies Abi;
export const identityAbi = [] as const satisfies Abi;
export const organizersAbi = [] as const satisfies Abi;
