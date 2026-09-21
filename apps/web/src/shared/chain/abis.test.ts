import { describe, expect, it } from 'vitest';
import type { AbiEvent, AbiFunction } from 'viem';
import * as shared from '@monti/shared';
import {
  ABI_BY_CONTRACT,
  PENDING_EVENTS,
  USED_ABI,
  USED_EVENTS,
  eventTopic,
  identityAbi,
  organizersAbi,
  ticketAbi,
  type UsedContract,
} from './abis';
import { STRUCT_INPUT_SHAPES, STRUCT_SHAPES } from './reads';

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
});

/**
 * The same guard as `USED_ABI`, for the logs this app subscribes to. `checkedInTopics` builds
 * `topic0` out of `USED_EVENTS.Ticket`, so an event renamed in sub-plan 01 would otherwise
 * become a subscription that silently never fires — the worst failure this screen has, because
 * it looks exactly like a gate that never confirmed.
 */
describe('the events this app subscribes to', () => {
  for (const contract of Object.keys(USED_EVENTS) as UsedContract[]) {
    const abi = ABI_BY_CONTRACT[contract];
    const pending: readonly string[] = PENDING_EVENTS[contract];

    for (const [name, arity] of Object.entries(USED_EVENTS[contract]) as Array<[string, number]>) {
      if (pending.includes(name)) continue;
      it(`${contract}.${name} is an event of ${arity} parameter(s) in the generated ABI`, () => {
        const events = abi.filter(
          (entry): entry is AbiEvent => entry.type === 'event' && entry.name === name,
        );
        expect(events.length, `${contract}.${name} is missing from the generated ABI`).toBe(1);
        expect(events[0]?.inputs.length).toBe(arity);
        expect(eventTopic(contract, name)).toMatch(/^0x[0-9a-f]{64}$/);
      });
    }

    for (const name of pending) {
      // The forcing function for the 01b redeploy: the day the ABI gains the event, this test
      // fails and whoever regenerates the ABI has to take the name out of `PENDING_EVENTS`,
      // which is what turns the subscription on.
      it(`${contract}.${name} is still absent, so it is declared pending and not subscribed`, () => {
        expect(abi.some((entry) => entry.type === 'event' && entry.name === name)).toBe(false);
        expect(eventTopic(contract, name)).toBeNull();
      });
    }
  }

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

/**
 * The other way an ABI change can go wrong quietly. Every read above is checked by name and
 * arity, which says nothing about the fields *inside* a returned tuple: viem fills
 * `EventMetaStruct` and friends positionally, so a field reordered or renamed in
 * `@monti/shared` would be decoded into the wrong property at the same width, with no error
 * on the way. `STRUCT_SHAPES` is the literal list next to those helpers; this pins it.
 */
interface AbiParam {
  name?: string;
  type: string;
  components?: readonly AbiParam[];
}

/** The field names viem decodes into, in ABI order: a struct's components, or — for a
 *  function returning several separate values, like `gateInfo` — the outputs themselves. */
function decodedFieldNames(abi: readonly unknown[], functionName: string): string[] {
  const entry = abi.find(
    (item): item is { type: 'function'; name: string; outputs: readonly AbiParam[] } =>
      (item as { type?: string }).type === 'function' && (item as { name?: string }).name === functionName,
  );
  if (!entry) throw new Error(`${functionName} is missing from the generated ABI`);
  const outputs = entry.outputs;
  const single = outputs.length === 1 ? outputs[0] : undefined;
  const params = single?.components ?? outputs;
  return params.map((param) => param.name ?? '');
}

/** The field names viem encodes from, in ABI order, for one named input of a function. */
function inputFieldNames(abi: readonly unknown[], functionName: string, inputName: string): string[] {
  const entry = abi.find(
    (item): item is { type: 'function'; name: string; inputs: readonly AbiParam[] } =>
      (item as { type?: string }).type === 'function' && (item as { name?: string }).name === functionName,
  );
  if (!entry) throw new Error(`${functionName} is missing from the generated ABI`);
  const input = entry.inputs.find((param) => param.name === inputName);
  if (!input) throw new Error(`${functionName} takes no argument named ${inputName}`);
  return (input.components ?? []).map((param) => param.name ?? '');
}

describe('the struct fields the wizard encodes positionally', () => {
  for (const contract of Object.keys(STRUCT_INPUT_SHAPES) as Array<keyof typeof STRUCT_INPUT_SHAPES>) {
    const functions: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> =
      STRUCT_INPUT_SHAPES[contract];

    for (const [functionName, inputs] of Object.entries(functions)) {
      for (const [inputName, fields] of Object.entries(inputs)) {
        it(`${contract}.${functionName}(${inputName}) takes exactly ${fields.join(', ')} in that order`, () => {
          expect(inputFieldNames(ABI_BY_CONTRACT[contract], functionName, inputName)).toEqual([...fields]);
        });
      }
    }
  }
});

describe('the struct fields reads.ts decodes positionally', () => {
  for (const contract of Object.keys(STRUCT_SHAPES) as Array<keyof typeof STRUCT_SHAPES>) {
    const shapes: Readonly<Record<string, readonly string[]>> = STRUCT_SHAPES[contract];

    for (const [functionName, fields] of Object.entries(shapes)) {
      it(`${contract}.${functionName} returns exactly ${fields.join(', ')} in that order`, () => {
        // toEqual on arrays is order-sensitive, which is the whole point: a swapped pair of
        // same-width fields is the failure this test exists to catch.
        expect(decodedFieldNames(ABI_BY_CONTRACT[contract], functionName)).toEqual([...fields]);
      });
    }
  }
});
