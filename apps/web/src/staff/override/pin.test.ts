// The local PIN, and the two things it is for: unlocking the manual-approval dialog, and making
// a phone somebody picked up off a table useless for opening a door.
//
// Everything below is about the second one. The first is trivial — a PIN either matches or it
// does not — and it is the failure path that has to be right, because the attack is not clever:
// it is four digits and a bored person with the terminal in their hands. Five wrong tries and a
// minute of silence turns a 10,000-guess afternoon into a 35-hour one, which is longer than any
// event, and the counter lives **on disk** so closing the app is not a way around it.
import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it } from 'vitest';

import { PIN_LOCKOUT_MS, PIN_MAX_ATTEMPTS } from '../constants';
import { staffDb } from '../snapshot/store';
import { checkPin, hasPin, setPin, verifyPin, type StoredPin } from './pin';

const RIGHT = '4821';
const WRONG = '4822';

async function pinRow(): Promise<StoredPin | undefined> {
  return (await (await staffDb()).get('settings', 'pin')) as StoredPin | undefined;
}

beforeEach(async () => {
  await (await staffDb()).delete('settings', 'pin');
});

describe('local staff PIN', () => {
  it('accepts the right PIN and refuses the wrong one', async () => {
    await setPin(RIGHT);
    expect(await verifyPin(RIGHT)).toBe(true);
    expect(await verifyPin(WRONG)).toBe(false);
  });

  it('never stores the PIN itself', async () => {
    await setPin(RIGHT);
    const row = await pinRow();
    expect(JSON.stringify(row)).not.toContain(RIGHT);
    expect(row?.salt).toMatch(/^[0-9a-f]{32}$/);
    expect(row?.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('salts every PIN separately, so two devices on the same four digits do not match', async () => {
    await setPin(RIGHT);
    const first = await pinRow();
    await setPin(RIGHT);
    const second = await pinRow();
    expect(second?.salt).not.toBe(first?.salt);
    expect(second?.hash).not.toBe(first?.hash);
  });

  it('refuses to set a PIN too short to be worth the lockout', async () => {
    await expect(setPin('12')).rejects.toThrow('PIN_TOO_SHORT');
    expect(await hasPin()).toBe(false);
  });

  it('says nothing is set until something is', async () => {
    expect(await hasPin()).toBe(false);
    expect(await checkPin(RIGHT)).toEqual({ ok: false, reason: 'UNSET' });
    await setPin(RIGHT);
    expect(await hasPin()).toBe(true);
  });

  it('counts down the tries left and locks on the fifth wrong one', async () => {
    await setPin(RIGHT);
    const at = 1_000_000;
    for (let attempt = 1; attempt < PIN_MAX_ATTEMPTS; attempt += 1) {
      expect(await checkPin(WRONG, at)).toEqual({
        ok: false,
        reason: 'WRONG',
        triesLeft: PIN_MAX_ATTEMPTS - attempt,
      });
    }
    expect(await checkPin(WRONG, at)).toEqual({ ok: false, reason: 'LOCKED', retryInMs: PIN_LOCKOUT_MS });
  });

  it('refuses even the right PIN while it is locked', async () => {
    await setPin(RIGHT);
    const at = 1_000_000;
    for (let attempt = 0; attempt < PIN_MAX_ATTEMPTS; attempt += 1) await checkPin(WRONG, at);
    expect(await checkPin(RIGHT, at + 1_000)).toEqual({
      ok: false,
      reason: 'LOCKED',
      retryInMs: PIN_LOCKOUT_MS - 1_000,
    });
  });

  it('holds the lockout on disk, so restarting the app does not clear it', async () => {
    await setPin(RIGHT);
    const at = 1_000_000;
    for (let attempt = 0; attempt < PIN_MAX_ATTEMPTS; attempt += 1) await checkPin(WRONG, at);
    const row = await pinRow();
    expect(row?.lockedUntil).toBe(at + PIN_LOCKOUT_MS);
    expect(row?.failures).toBe(PIN_MAX_ATTEMPTS);
  });

  it('opens again once the minute is up, and forgets the failures', async () => {
    await setPin(RIGHT);
    const at = 1_000_000;
    for (let attempt = 0; attempt < PIN_MAX_ATTEMPTS; attempt += 1) await checkPin(WRONG, at);
    expect(await checkPin(RIGHT, at + PIN_LOCKOUT_MS)).toEqual({ ok: true });
    const row = await pinRow();
    expect(row?.failures).toBe(0);
    expect(row?.lockedUntil).toBe(0);
  });

  it('forgets the failures the moment the right PIN lands', async () => {
    await setPin(RIGHT);
    await checkPin(WRONG);
    await checkPin(WRONG);
    expect(await checkPin(RIGHT)).toEqual({ ok: true });
    expect((await pinRow())?.failures).toBe(0);
    // The count really did reset: a fresh run of wrong tries starts from the top again.
    expect(await checkPin(WRONG)).toEqual({ ok: false, reason: 'WRONG', triesLeft: PIN_MAX_ATTEMPTS - 1 });
  });

  it('starts a newly set PIN unlocked, whatever the old one was doing', async () => {
    await setPin(RIGHT);
    const at = 1_000_000;
    for (let attempt = 0; attempt < PIN_MAX_ATTEMPTS; attempt += 1) await checkPin(WRONG, at);
    await setPin('9999');
    expect(await checkPin('9999', at)).toEqual({ ok: true });
  });
});
