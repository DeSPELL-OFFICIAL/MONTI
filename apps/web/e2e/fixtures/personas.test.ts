import { describe, expect, it } from 'vitest';
import { PERSONA_COUNT, parsePersonaIndex, parsePersonaOffset, selectPersonas } from './personas';

/**
 * Pure persona-selection logic (no browser, no env side effects): E2E_ADMIN / E2E_USER_FROM map a
 * flag to an admin + nine attendees. These run under the repo's vitest (`pnpm -F web test`).
 */
describe('parsePersonaIndex', () => {
  it('accepts 1…10 in several spellings', () => {
    expect(parsePersonaIndex('05', 1)).toBe(5);
    expect(parsePersonaIndex('5', 1)).toBe(5);
    expect(parsePersonaIndex(' 7 ', 1)).toBe(7);
    expect(parsePersonaIndex('persona-07', 1)).toBe(7);
    expect(parsePersonaIndex('10', 1)).toBe(10);
    expect(parsePersonaIndex('1', 9)).toBe(1);
  });

  it('falls back on absent, non-numeric or out-of-range input', () => {
    expect(parsePersonaIndex(undefined, 1)).toBe(1);
    expect(parsePersonaIndex('', 3)).toBe(3);
    expect(parsePersonaIndex('abc', 3)).toBe(3);
    expect(parsePersonaIndex('0', 3)).toBe(3);
    expect(parsePersonaIndex('11', 3)).toBe(3);
    expect(parsePersonaIndex('-2', 3)).toBe(3);
    expect(parsePersonaIndex('2.5', 3)).toBe(3);
  });
});

describe('parsePersonaOffset', () => {
  it('defaults to 10 and accepts a non-negative integer', () => {
    expect(parsePersonaOffset(undefined)).toBe(10);
    expect(parsePersonaOffset('0')).toBe(0);
    expect(parsePersonaOffset('10')).toBe(10);
    expect(parsePersonaOffset(' 20 ')).toBe(20);
  });

  it('falls back to 10 on empty, non-numeric, negative or fractional input', () => {
    expect(parsePersonaOffset('')).toBe(10);
    expect(parsePersonaOffset('abc')).toBe(10);
    expect(parsePersonaOffset('-5')).toBe(10);
    expect(parsePersonaOffset('2.5')).toBe(10);
  });
});

describe('selectPersonas', () => {
  const ids = (ps: { id: string }[]): string[] => ps.map((p) => p.id);

  it('defaults to admin …01 and attendees …02–…10, unchanged', () => {
    const { admin, users } = selectPersonas();
    expect(admin.id).toBe('persona-01');
    expect(admin.role).toBe('admin');
    expect(admin.displayName).toBe('Monti Admin');
    expect(users).toHaveLength(PERSONA_COUNT - 1);
    expect(ids(users)).toEqual([
      'persona-02', 'persona-03', 'persona-04', 'persona-05', 'persona-06',
      'persona-07', 'persona-08', 'persona-09', 'persona-10',
    ]);
    expect(users.every((u) => u.role === 'user')).toBe(true);
  });

  it('lets any number take the admin seat and wraps the attendee pool past …10', () => {
    const { admin, users } = selectPersonas({ E2E_ADMIN: '05' });
    expect(admin.id).toBe('persona-05');
    expect(admin.role).toBe('admin');
    expect(ids(users)).toEqual([
      'persona-06', 'persona-07', 'persona-08', 'persona-09', 'persona-10',
      'persona-01', 'persona-02', 'persona-03', 'persona-04',
    ]);
    expect(ids(users)).not.toContain('persona-05');
    expect(users).toHaveLength(9);
  });

  it('wraps cleanly when …10 is the admin', () => {
    const { admin, users } = selectPersonas({ E2E_ADMIN: '10' });
    expect(admin.id).toBe('persona-10');
    expect(ids(users)).toEqual([
      'persona-01', 'persona-02', 'persona-03', 'persona-04', 'persona-05',
      'persona-06', 'persona-07', 'persona-08', 'persona-09',
    ]);
  });

  it('honours E2E_USER_FROM as the attendee start index, admin still excluded', () => {
    const { admin, users } = selectPersonas({ E2E_ADMIN: '01', E2E_USER_FROM: '04' });
    expect(admin.id).toBe('persona-01');
    expect(ids(users)).toEqual([
      'persona-04', 'persona-05', 'persona-06', 'persona-07', 'persona-08',
      'persona-09', 'persona-10', 'persona-02', 'persona-03',
    ]);
    expect(ids(users)).not.toContain('persona-01');
    expect(users).toHaveLength(9);
  });

  it('always yields nine distinct attendees that never include the admin', () => {
    for (let adminIndex = 1; adminIndex <= PERSONA_COUNT; adminIndex++) {
      const { admin, users } = selectPersonas({ E2E_ADMIN: String(adminIndex) });
      const set = new Set(users.map((u) => u.id));
      expect(set.size).toBe(9);
      expect(set.has(admin.id)).toBe(false);
    }
  });

  it('builds E.164 + national numbers from the index plus the default offset (10)', () => {
    const { admin } = selectPersonas({ E2E_ADMIN: '05' });
    expect(admin.phone).toMatch(/^\+82100000\d{4}$/);
    expect(admin.phone.endsWith('0015')).toBe(true); // index 5 + default offset 10
    expect(admin.national).toMatch(/^0100000\d{4}$/);
    expect(admin.national.endsWith('0015')).toBe(true);
  });

  it('shifts the dialled digits by E2E_PERSONA_OFFSET while keeping the id', () => {
    const original = selectPersonas({ E2E_ADMIN: '01', E2E_PERSONA_OFFSET: '0' });
    expect(original.admin.id).toBe('persona-01');
    expect(original.admin.phone).toBe('+821000000001'); // the original (burned) block
    expect(original.admin.national).toBe('01000000001');

    const live = selectPersonas({ E2E_ADMIN: '01', E2E_PERSONA_OFFSET: '10' });
    expect(live.admin.id).toBe('persona-01'); // id is unchanged by the offset
    expect(live.admin.phone).toBe('+821000000011'); // the rotated live block
    expect(selectPersonas({ E2E_ADMIN: '10', E2E_PERSONA_OFFSET: '10' }).admin.phone).toBe('+821000000020');

    // The offset shifts only the dialled digits — the state-file keys (ids) stay put.
    expect(live.users.map((u) => u.id)).toEqual(original.users.map((u) => u.id));
  });

  it('falls back to the defaults on a bad E2E_ADMIN', () => {
    const { admin, users } = selectPersonas({ E2E_ADMIN: '99' });
    expect(admin.id).toBe('persona-01');
    expect(users).toHaveLength(9);
  });
});
