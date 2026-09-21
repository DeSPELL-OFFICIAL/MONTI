import { describe, expect, it } from 'vitest';
import type { PersonStatus } from '@monti/shared';
import { ALLOWED_COLLECTIONS, ALLOWED_TRANSITIONS, assertStatusTransition } from '../src/lib/db.js';

const STATUSES = Object.keys(ALLOWED_TRANSITIONS) as PersonStatus[];
const allowed: Array<[PersonStatus, PersonStatus]> = STATUSES.flatMap((from) =>
  ALLOWED_TRANSITIONS[from].map((to) => [from, to] as [PersonStatus, PersonStatus]),
);
const forbidden: Array<[PersonStatus, PersonStatus]> = STATUSES.flatMap((from) =>
  STATUSES.filter((to) => !ALLOWED_TRANSITIONS[from].includes(to)).map(
    (to) => [from, to] as [PersonStatus, PersonStatus],
  ),
);

describe('assertStatusTransition', () => {
  // 표가 곧 명세다. 허용된 모든 간선을 손으로 나열하지 않고 표에서 뽑아 전부 검사한다.
  it.each(allowed)('allows %s → %s', (from, to) => {
    expect(() => assertStatusTransition(from, to)).not.toThrow();
  });

  it.each(forbidden)('blocks %s → %s', (from, to) => {
    expect(() => assertStatusTransition(from, to)).toThrow(`BAD_STATUS_TRANSITION:${from}->${to}`);
  });

  it('covers every status in the union, so a new status cannot slip in untested', () => {
    expect(STATUSES.sort()).toEqual(['active', 'kyc_ok', 'pending', 'rejected', 'rotated']);
    expect(allowed.length + forbidden.length).toBe(STATUSES.length ** 2);
  });

  it('blocks jumping from pending straight to kyc_ok', () => {
    expect(() => assertStatusTransition('pending', 'kyc_ok')).toThrow('BAD_STATUS_TRANSITION:pending->kyc_ok');
  });

  it('blocks going backwards and resurrecting a rotated person', () => {
    expect(() => assertStatusTransition('active', 'pending')).toThrow('BAD_STATUS_TRANSITION');
    expect(() => assertStatusTransition('rotated', 'active')).toThrow('BAD_STATUS_TRANSITION');
  });

  it('is a no-op for an identical status (idempotent replays)', () => {
    expect(() => assertStatusTransition('active', 'active')).not.toThrow();
  });
});

describe('ALLOWED_COLLECTIONS', () => {
  it('contains no chain-authoritative collection', () => {
    for (const forbiddenCollection of ['tickets', 'checkIns', 'roles', 'gates', 'events', 'admins', 'managers']) {
      expect(ALLOWED_COLLECTIONS).not.toContain(forbiddenCollection);
    }
  });
});
