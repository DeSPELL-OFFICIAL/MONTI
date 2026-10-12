/**
 * The ten Firebase Auth TEST phone numbers the controller provisioned. They send no real SMS;
 * the code is always `123456`. By default `…01` is the admin/organiser and `…02`–`…10` are nine
 * attendees, but any test number can take the admin seat — see `selectPersonas` / `E2E_ADMIN`.
 *
 * The TEST block is rotated by a dialled offset (`E2E_PERSONA_OFFSET`, default 10): persona indices
 * 1…10 map to the live numbers `+821000000011`…`+821000000020`. The original `…0001`–`…0010` block
 * was burned — all ten are registered, so a fresh signup is impossible on them. The persona *id*
 * stays `persona-01…10` whatever the offset (so state files and the ledger key stably); only the
 * dialled digits shift. `E2E_PERSONA_OFFSET=0` restores the original `…0001`–`…0010` block.
 *
 * These are fictional test numbers, never real people. They are the only phone numbers this
 * harness may ever type, and the SMS code below is the only code it may ever type.
 */
export const OTP_CODE = '123456';

/** How many TEST phone numbers the controller provisioned (…01 … …10). */
export const PERSONA_COUNT = 10;

/** Default dialled offset — the live block starts at `…0011`, the original `…0001` block is burned. */
export const DEFAULT_PERSONA_OFFSET = 10;

/**
 * Parse the dialled-number offset from `E2E_PERSONA_OFFSET`. The offset is added to each 1…`PERSONA_COUNT`
 * index to form the phone/national digits, so with the default 10 index 1 dials `…0011` and index 10
 * dials `…0020`. The persona id is unaffected. Non-integer or negative input falls back to the default,
 * so a typo never silently dials a stray number.
 */
export function parsePersonaOffset(raw: string | undefined): number {
  const s = String(raw ?? '').trim();
  if (s === '') return DEFAULT_PERSONA_OFFSET; // absent/blank → default (Number('') is 0, offset 0 is valid)
  const n = Number(s);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_PERSONA_OFFSET;
}

export interface Persona {
  /** Stable key used for the persisted state file name. */
  readonly id: string;
  /** E.164, as Firebase has it. */
  readonly phone: string;
  /** What the person types on the phone screen (national format, +82 selected by default). */
  readonly national: string;
  /** The name printed on their ticket (optional display name step). */
  readonly displayName: string;
  readonly role: 'admin' | 'user';
}

/**
 * The ticket display name for each 1-based persona index. Index 1 keeps the organiser name it has
 * always had; 2…10 are the nine attendee names, in order. The name is intrinsic to the number, not
 * to the role, so a persona keeps its name whether it is the admin or an attendee on a given run.
 */
const DISPLAY_NAMES = [
  'Monti Admin', 'Seojun', 'Jiwoo', 'Hayun', 'Doyun', 'Seoyeon', 'Minjun', 'Jiho', 'Sua', 'Yejun',
] as const;

function persona(index: number, role: 'admin' | 'user', offset: number): Persona {
  const suffix = String(index).padStart(2, '0');
  const dialled = String(index + offset).padStart(4, '0');
  return {
    id: `persona-${suffix}`,
    phone: `+82100000${dialled}`,
    national: `0100000${dialled}`,
    displayName: DISPLAY_NAMES[index - 1] ?? `Persona ${suffix}`,
    role,
  };
}

/**
 * Parse a 1…`PERSONA_COUNT` persona index from a flag like `05`, `5` or `persona-05`. Anything out
 * of range, non-numeric or absent falls back, so a typo never silently selects the wrong number.
 */
export function parsePersonaIndex(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(String(raw).trim().replace(/^persona-/, ''));
  return Number.isInteger(n) && n >= 1 && n <= PERSONA_COUNT ? n : fallback;
}

export interface PersonaSelection {
  admin: Persona;
  users: Persona[];
}

/**
 * Choose which TEST number is the organiser/admin and which are the attendees, from the two flags.
 * Pure — it reads only the values handed in — so it is unit-tested directly.
 *
 *  - `E2E_ADMIN`     the admin's 1…10 index (default 1). Any number can take the admin seat; its
 *                    persisted on-chain identity then belongs to the organiser for the run.
 *  - `E2E_USER_FROM` the index the attendee pool starts at (default: the one right after the admin).
 *
 * The attendee pool is always the other nine numbers, taken in index order from the start index and
 * wrapping past …10 back to …01, skipping the admin. So the default (admin 1, from 2) is …02–…10
 * unchanged, and admin 5 gives …06–…10 then …01–…04 — a full nine either way.
 */
export function selectPersonas(
  env: { E2E_ADMIN?: string; E2E_USER_FROM?: string; E2E_PERSONA_OFFSET?: string } = {},
): PersonaSelection {
  const adminIndex = parsePersonaIndex(env.E2E_ADMIN, 1);
  const defaultFrom = (adminIndex % PERSONA_COUNT) + 1;
  const fromIndex = parsePersonaIndex(env.E2E_USER_FROM, defaultFrom);
  const offset = parsePersonaOffset(env.E2E_PERSONA_OFFSET);
  const admin = persona(adminIndex, 'admin', offset);
  const users: Persona[] = [];
  for (let step = 0; step < PERSONA_COUNT; step++) {
    const index = ((fromIndex - 1 + step) % PERSONA_COUNT) + 1;
    if (index !== adminIndex) users.push(persona(index, 'user', offset));
  }
  return { admin, users };
}

/** The dialled offset resolved for this run (default 10). State files are namespaced by it. */
export const PERSONA_OFFSET: number = parsePersonaOffset(process.env.E2E_PERSONA_OFFSET);

const selected = selectPersonas({
  E2E_ADMIN: process.env.E2E_ADMIN,
  E2E_USER_FROM: process.env.E2E_USER_FROM,
  E2E_PERSONA_OFFSET: process.env.E2E_PERSONA_OFFSET,
});

/** The organiser for this run — …01 by default, or whatever `E2E_ADMIN` selects. */
export const ADMIN: Persona = selected.admin;

/** The nine attendees for this run, the admin excluded, in claim order. */
export const USERS: Persona[] = selected.users;

export const ALL_PERSONAS: Persona[] = [ADMIN, ...USERS];
