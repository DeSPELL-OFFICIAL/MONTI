import type { Abi } from 'viem';

/**
 * Task 9 (sub-plan 03) binds these to the compiled project ABIs. Until then they
 * are empty placeholders so `ops.ts` and its thin wrappers (`ticketOp`,
 * `identityOp`, `organizersOp`) compile and can be unit-tested against a mocked
 * `./abis`. Do NOT hand-author fragments here; Task 9 replaces the file wholesale.
 */
export const ticketAbi = [] as const satisfies Abi;
export const identityAbi = [] as const satisfies Abi;
export const organizersAbi = [] as const satisfies Abi;
