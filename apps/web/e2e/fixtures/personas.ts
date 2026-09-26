/**
 * The ten Firebase Auth TEST phone numbers the controller provisioned. They send no real SMS;
 * the code is always `123456`. `…01` is the admin/organiser, `…02`–`…10` are nine attendees.
 *
 * These are fictional test numbers, never real people. They are the only phone numbers this
 * harness may ever type, and the SMS code below is the only code it may ever type.
 */
export const OTP_CODE = '123456';

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

function persona(index: number, role: 'admin' | 'user', displayName: string): Persona {
  const suffix = String(index).padStart(2, '0');
  return {
    id: `persona-${suffix}`,
    phone: `+82100000${suffix.padStart(4, '0')}`,
    national: `0100000${suffix.padStart(4, '0')}`,
    displayName,
    role,
  };
}

/** …01 — the organiser. */
export const ADMIN: Persona = persona(1, 'admin', '관리자 몬티');

/** …02–…10 — nine attendees, with plain Korean display names. */
const USER_NAMES = ['서준', '지우', '하윤', '도윤', '서연', '민준', '지호', '수아', '예준'];
export const USERS: Persona[] = USER_NAMES.map((name, at) => persona(at + 2, 'user', name));

export const ALL_PERSONAS: Persona[] = [ADMIN, ...USERS];
