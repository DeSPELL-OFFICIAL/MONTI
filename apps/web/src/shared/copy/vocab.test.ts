import { describe, expect, it } from 'vitest';
import { en, ko } from './index';
import { organizerCopy } from '../../organizer/copy';

/**
 * The B5 glossary sweep (plan T-SIMP-7). A handful of words were retired from every screen a
 * person reads, and this is the regression that keeps them from creeping back into the copy:
 * it walks the copy objects themselves, so it sees the strings a user is shown and not the
 * code identifiers (`publishEvent`, the `Published` status key) or the comments that explain
 * them — those are allowed to keep the old words.
 */
function values(node: unknown): string[] {
  if (typeof node === 'string') return [node];
  if (node && typeof node === 'object') return Object.values(node).flatMap(values);
  return [];
}

const ALL = [
  ...values(ko),
  ...values(en),
  ...values(organizerCopy.ko),
  ...values(organizerCopy.en),
];

describe('B5 vocabulary sweep (T-SIMP-7)', () => {
  // 발행 → 공개하기, 양도 → 친구에게 주기, 주최사 → 우리 팀. Gone from every user-facing string.
  for (const word of ['양도', '발행', '주최사']) {
    it(`never uses "${word}" in user-facing copy`, () => {
      expect(ALL.filter((v) => v.includes(word))).toEqual([]);
    });
  }

  // 공개 기록 (the on-chain explorer link) is removed from the attendee event screen. It stays
  // only on the profile screen, where a person opens their own record on purpose (plan B5:
  // "관객 화면에서 삭제"); that link is covered by profile.test.tsx.
  it('drops the 공개 기록 explorer link from the attendee event copy', () => {
    expect('publicRecord' in ko.discover).toBe(false);
    expect(values(ko.discover).some((v) => v.includes('공개 기록'))).toBe(false);
  });
});
