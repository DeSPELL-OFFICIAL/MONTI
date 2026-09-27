import { describe, expect, it } from 'vitest';
import { emptyEventDraft, freshEventDraft, nextWeekendStart } from './useEventDraft';

/**
 * The start-time default (T-SIMP-8). It is computed from an injected `now` rather than read off
 * the wall clock, so each case fixes a `now` on a known weekday and checks the one thing that has
 * to hold: the answer is the *upcoming* Saturday at 19:00, and it is always strictly in the future.
 */
describe('nextWeekendStart', () => {
  /** `now` (epoch ms) -> the local Date the returned epoch-seconds land on. */
  const dateOf = (now: number): Date => new Date(nextWeekendStart(now) * 1000);

  it('lands on the coming Saturday at 19:00, from a weekday', () => {
    // 2026-09-30 is a Wednesday; the coming Saturday is 2026-10-03.
    const wed = new Date(2026, 8, 30, 10, 15).getTime();
    const at = dateOf(wed);
    expect(at.getDay()).toBe(6); // Sat = day 6
    expect(at.getHours()).toBe(19);
    expect(at.getMinutes()).toBe(0);
    expect(at.getSeconds()).toBe(0);
    expect(nextWeekendStart(wed) * 1000).toBeGreaterThan(wed);
  });

  it('rolls to the following Saturday when today is already Saturday', () => {
    // 2026-10-03 is a Saturday; morning is before 19:00 and evening is after it — both must roll
    // forward a whole week to 2026-10-10, never settle on the same day's 19:00.
    const satMorning = new Date(2026, 9, 3, 10, 0).getTime();
    const satEvening = new Date(2026, 9, 3, 20, 0).getTime();
    for (const now of [satMorning, satEvening]) {
      const at = dateOf(now);
      expect(at.getDay()).toBe(6);
      expect(at.getHours()).toBe(19);
      expect(at.getDate()).toBe(10);
      expect(nextWeekendStart(now) * 1000).toBeGreaterThan(now);
    }
  });

  it('is always strictly in the future, whatever the day and hour', () => {
    for (let day = 1; day <= 7; day += 1) {
      const now = new Date(2026, 8, 27 + day, 23, 30).getTime();
      expect(nextWeekendStart(now) * 1000).toBeGreaterThan(now);
    }
  });
});

describe('freshEventDraft', () => {
  it('is the zero fixture with only the start seeded, so the end still derives', () => {
    const fresh = freshEventDraft();
    const at = new Date(fresh.startsAt * 1000);
    expect(at.getDay()).toBe(6);
    expect(at.getHours()).toBe(19);
    expect(fresh.startsAt * 1000).toBeGreaterThan(Date.now());
    // The end is never seeded here: it stays 0 and `endsAtOf` derives start + 2h.
    expect(fresh.endsAt).toBe(0);
    // Everything but the start is exactly the empty fixture — nothing else was touched.
    expect({ ...fresh, startsAt: 0 }).toEqual(emptyEventDraft);
    // And the shared fixture keeps its zero start: it is the normaliser's fallback.
    expect(emptyEventDraft.startsAt).toBe(0);
  });
});
