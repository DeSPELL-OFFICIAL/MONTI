/**
 * `Organizers.sol`'s permission bits, by the names the contract and the backend give them
 * (contracts/src/Organizers.sol, functions/src/lib/auth.ts). Nothing in this app passes a
 * bare number to `hasPermission` or to `setAdmin`: the bit a screen asks about is the point
 * of the question, and `2` on its own says nothing about entrances.
 */
export const PERM_CREATE_EVENT = 1;
export const PERM_MANAGE_GATES = 2;
export const PERM_APPROVE_OVERRIDE = 4;
export const PERM_MANAGE_MANAGERS = 8;
export const PERM_MANAGE_BUDGET = 16;

/** The sum of every bit the contract declares. `createInvite` refuses anything wider. */
export const ALL_PERMISSION_BITS =
  PERM_CREATE_EVENT | PERM_MANAGE_GATES | PERM_APPROVE_OVERRIDE | PERM_MANAGE_MANAGERS | PERM_MANAGE_BUDGET;

/** The admin bits an organiser screen offers, in the order they are shown. */
export const PERMISSION_BITS = [
  { bit: PERM_CREATE_EVENT, name: 'createEvent' },
  { bit: PERM_MANAGE_GATES, name: 'manageGates' },
  { bit: PERM_APPROVE_OVERRIDE, name: 'approveOverride' },
  { bit: PERM_MANAGE_MANAGERS, name: 'manageManagers' },
  { bit: PERM_MANAGE_BUDGET, name: 'manageBudget' },
] as const;

export type PermissionName = (typeof PERMISSION_BITS)[number]['name'];
