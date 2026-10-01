/**
 * The ten Firebase Auth TEST phone numbers the controller provisioned. They send no real SMS;
 * the code is always `123456`. By default `…01` is the admin/organiser and `…02`–`…10` are nine
 * attendees, but any test number can take the admin seat — see `selectPersonas` / `E2E_ADMIN`.
 *
 * These are fictional test numbers, never real people. They are the only phone numbers this
 * harness may ever type, and the SMS code below is the only code it may ever type.
 */
export const OTP_CODE = '123456';

/** How many TEST phone numbers the controller provisioned (…01 … …10). */
export const PERSONA_COUNT = 10;

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
  '관리자 몬티', '서준', '지우', '하윤', '도윤', '서연', '민준', '지호', '수아', '예준',
] as const;

function persona(index: number, role: 'admin' | 'user'): Persona {
  const suffix = String(index).padStart(2, '0');
  return {
    id: `persona-${suffix}`,
    phone: `+82100000${suffix.padStart(4, '0')}`,
    national: `0100000${suffix.padStart(4, '0')}`,
    displayName: DISPLAY_NAMES[index - 1] ?? `페르소나 ${suffix}`,
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
export function selectPersonas(env: { E2E_ADMIN?: string; E2E_USER_FROM?: string } = {}): PersonaSelection {
  const adminIndex = parsePersonaIndex(env.E2E_ADMIN, 1);
  const defaultFrom = (adminIndex % PERSONA_COUNT) + 1;
  const fromIndex = parsePersonaIndex(env.E2E_USER_FROM, defaultFrom);
  const admin = persona(adminIndex, 'admin');
  const users: Persona[] = [];
  for (let step = 0; step < PERSONA_COUNT; step++) {
    const index = ((fromIndex - 1 + step) % PERSONA_COUNT) + 1;
    if (index !== adminIndex) users.push(persona(index, 'user'));
  }
  return { admin, users };
}

const selected = selectPersonas({
  E2E_ADMIN: process.env.E2E_ADMIN,
  E2E_USER_FROM: process.env.E2E_USER_FROM,
});

/** The organiser for this run — …01 by default, or whatever `E2E_ADMIN` selects. */
export const ADMIN: Persona = selected.admin;

/** The nine attendees for this run, the admin excluded, in claim order. */
export const USERS: Persona[] = selected.users;

export const ALL_PERSONAS: Persona[] = [ADMIN, ...USERS];
