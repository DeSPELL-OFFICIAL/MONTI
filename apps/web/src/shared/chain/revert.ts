import { encodeErrorResult, type Abi, type Hex } from 'viem';

/**
 * Reading a contract's refusal out of the four bytes it reverted with.
 *
 * It lives here rather than beside any one screen because three of them now need it against
 * three different ABIs: the hand-over reads `Ticket`'s eight transfer rules, the wizard reads
 * `Ticket.createEvent`'s three, and the organiser's gate screen reads `Organizers`. The table
 * of names stays with the screen that owns the sentences; only the lookup is shared.
 */

/** Every one of these errors is argument-less, but slicing keeps a padded reason working. */
export function selectorOf(revertReason: Hex): string {
  return revertReason.slice(0, 10).toLowerCase();
}

/**
 * The selector this ABI gives that error, or nothing when it does not carry the name.
 * `encodeErrorResult` throws on a name it cannot find, and every caller runs inside a `catch` —
 * a rename in sub-plan 01 would otherwise throw a second time there and leave a screen stuck
 * mid-send instead of falling through to its generic sentence.
 */
export function errorSelector(abi: Abi, errorName: string): string | undefined {
  try {
    return encodeErrorResult({ abi, errorName });
  } catch {
    return undefined;
  }
}

/** The first entry of `table` whose error name is what this reason reverted with. */
export function revertMatch<T>(
  abi: Abi,
  revertReason: Hex,
  table: ReadonlyArray<readonly [string, T]>,
): T | undefined {
  const selector = selectorOf(revertReason);
  for (const [errorName, value] of table) {
    if (errorSelector(abi, errorName) === selector) return value;
  }
  return undefined;
}
