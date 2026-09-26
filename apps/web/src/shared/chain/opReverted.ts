import type { Hex } from 'viem';

/** The operation did not succeed — the contract reverted, or `wait` timed out before it
 * landed (`revertReason` is then the `'TIMEOUT'` sentinel). Either way, user-facing failure.
 *
 * `userOpHash` is carried so a caller that saw the sentinel can come back to the same
 * operation later instead of sending a second one: the first may still be in flight, and two
 * `createEvent` operations are two events.
 *
 * It sits in a module of its own rather than in `ops.ts` because `unsponsored.ts` needs it and
 * `ops.ts` needs `unsponsored.ts` — a cycle that only appeared once an estimate-time revert
 * had to be told apart from a paymaster refusal. Every existing importer still reads it from
 * `ops.ts`, which re-exports it. */
export class OpReverted extends Error {
  constructor(
    readonly functionName: string,
    readonly revertReason?: Hex | 'TIMEOUT',
    readonly userOpHash?: Hex,
  ) {
    super(`OpReverted: ${functionName}${revertReason ? ` (${revertReason})` : ''}`);
    this.name = 'OpReverted';
  }
}
