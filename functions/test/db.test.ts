import { describe, expect, it } from 'vitest';
import { ALLOWED_COLLECTIONS, assertStatusTransition } from '../src/lib/db.js';

describe('assertStatusTransition', () => {
  it('allows pending → active, the normal signup path now that KYC is per-event', () => {
    expect(() => assertStatusTransition('pending', 'active')).not.toThrow();
  });

  it('allows the per-event KYC round trip active → kyc_ok → active', () => {
    expect(() => assertStatusTransition('active', 'kyc_ok')).not.toThrow();
    expect(() => assertStatusTransition('kyc_ok', 'active')).not.toThrow();
  });

  it('lets a rejected person retry KYC', () => {
    expect(() => assertStatusTransition('active', 'rejected')).not.toThrow();
    expect(() => assertStatusTransition('rejected', 'kyc_ok')).not.toThrow();
  });

  it('blocks jumping from pending straight to kyc_ok', () => {
    expect(() => assertStatusTransition('pending', 'kyc_ok')).toThrow('BAD_STATUS_TRANSITION:pending->kyc_ok');
  });

  it('allows rotation from active', () => {
    expect(() => assertStatusTransition('active', 'rotated')).not.toThrow();
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
    for (const forbidden of ['tickets', 'checkIns', 'roles', 'gates', 'events', 'admins', 'managers']) {
      expect(ALLOWED_COLLECTIONS).not.toContain(forbidden);
    }
  });
});
