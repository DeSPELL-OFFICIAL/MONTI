import { describe, expect, it } from 'vitest';
import type { AbiFunction } from 'viem';
import * as shared from '@monti/shared';
import { ABI_BY_CONTRACT, USED_ABI, identityAbi, organizersAbi, ticketAbi, type UsedContract } from './abis';

/**
 * The guard the usage manifest exists for. `USED_ABI` names every function the app calls and
 * `reads.ts`/`ops.ts` type their `functionName` against it, so this test is the other half:
 * it asks the generated JSON whether each of those names is really there, with the arity the
 * app passes. If sub-plan 01 renames a function or changes a signature, this breaks first.
 */
describe('the generated ABI covers everything this app calls', () => {
  it('re-exports @monti/shared rather than a hand-written fragment', () => {
    expect(identityAbi).toBe(shared.identityAbi);
    expect(organizersAbi).toBe(shared.organizersAbi);
    expect(ticketAbi).toBe(shared.ticketAbi);
  });

  it('carries the events a hand-written fragment would have dropped', () => {
    const events = ticketAbi.filter((entry) => entry.type === 'event').map((entry) => entry.name);
    expect(events).toContain('CheckedIn');
    expect(events).toContain('Transfer');
  });

  for (const contract of Object.keys(USED_ABI) as UsedContract[]) {
    const abi = ABI_BY_CONTRACT[contract];

    it(`${contract} is a real ABI, not an empty array`, () => {
      expect(abi.length).toBeGreaterThan(0);
      expect(abi.some((entry) => entry.type === 'function')).toBe(true);
    });

    for (const [name, arity] of Object.entries(USED_ABI[contract]) as Array<[string, number]>) {
      it(`${contract}.${name} exists and takes ${arity} argument(s)`, () => {
        const overloads = abi.filter(
          (entry): entry is AbiFunction => entry.type === 'function' && entry.name === name,
        );
        expect(overloads.length, `${contract}.${name} is missing from the generated ABI`).toBeGreaterThan(0);
        expect(
          overloads.map((entry) => entry.inputs.length),
          `${contract}.${name} has no ${arity}-argument overload`,
        ).toContain(arity);
      });
    }
  }
});
