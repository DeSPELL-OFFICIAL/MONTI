import { describe, expect, it } from 'vitest';

import { OVERRIDE_REASONS } from '@monti/shared';

import { staffEn, staffKo, staffSetupEn, staffSetupKo } from './copy';
import { DENY_CODES } from './types';
import type { OverrideRole } from './types';

/**
 * **문장이 아니라 표(table) 자체를 검사한다.** 화면 테스트는 자기가 쓰는 문장 하나가 있는지만
 * 보므로, 아무도 부르지 않는 가지 하나가 영어에서 통째로 빠져 있어도 전부 초록이다. 그 구멍은
 * 스태프 폰이 영어로 설정된 그 하루에만 열린다. 대기·충돌 화면과 QR 대체 경로의 문장도 이제 이
 * 표의 가지이므로, 아래 네 가지를 따로 손대지 않아도 함께 받는다.
 *
 * 여기서 거는 것은 네 가지다.
 * 1. 두 로케일의 키 집합이 **재귀적으로** 같다 — 가지 하나가 통째로 빠지는 경우까지 잡는다.
 * 2. 잎이 전부 비지 않은 문자열이다 — 빈 문자열은 렌더링되면 그냥 사라진다.
 * 3. 영어 잎이 한국어 잎과 **다르다**. 한국어를 그대로 복사해 둔 자리는 타입이 잡아주지 못하고
 *    (`typeof staffKo` 는 둘 다 `string` 이라 만족한다) 화면에서도 멀쩡해 보인다. 다만 로케일이
 *    달라도 같아야 하는 낱말은 실제로 있으므로(`PIN`), 허용 목록을 두되 **허용 목록이 곧 일치
 *    집합과 정확히 같은지**까지 확인한다 — 게으른 복사가 하나 늘면 목록이 어긋나서 실패한다.
 * 4. `{{placeholder}}` 가 양쪽에 같은 집합으로 있다. 영어에서 `{{count}}` 가 빠지면 숫자가 없는
 *    문장이 나가고, 한국어에 없는 이름이 영어에 있으면 `{{name}}` 이 그대로 화면에 찍힌다.
 *
 * 금지어(스펙 §3.2) 검사는 여기서 하지 않는다. `scanText` 가 `@monti/shared` 의 엔트리에 실려
 * 있지 않고(`index.ts` 는 types·encoding·constants·abi 만 내보낸다), 이 테스트 하나 때문에
 * 린터 내부를 공개 API 로 끌어올릴 이유는 없다. 그 검사는 루트 `pnpm lint:copy` 가 이제
 * `apps/web/src/staff` 를 훑으면서 CI 에서 대신 건다.
 */

/** 두 단계까지 내려가는 카피 표를 `'shell.snapshotAge'` 같은 점 경로 잎 목록으로 편다. */
function flattenKeys(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix];
  return Object.entries(value).flatMap(([key, child]) =>
    flattenKeys(child, prefix ? `${prefix}.${key}` : key),
  );
}

function leafAt(table: unknown, path: string): string {
  let cursor: unknown = table;
  for (const step of path.split('.')) cursor = (cursor as Record<string, unknown>)[step];
  return cursor as string;
}

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]!).sort();
}

/**
 * 로케일이 달라도 같은 글자여야 하는 잎. `PIN` 은 번역하는 낱말이 아니라 스태프가 누르는 자판
 * 이름이라서, 한국어 화면에서도 `PIN` 이다.
 */
const IDENTICAL_ACROSS_LOCALES = ['override.pin'];

const KEYS = flattenKeys(staffKo).sort();

describe('staff copy', () => {
  it('has identical key sets in both locales, all the way down', () => {
    expect(flattenKeys(staffEn).sort()).toEqual(KEYS);
  });

  it('says something at every leaf in both locales', () => {
    for (const path of KEYS) {
      for (const [locale, table] of [
        ['ko', staffKo],
        ['en', staffEn],
      ] as const) {
        const leaf = leafAt(table, path);
        expect(typeof leaf, `${locale}.${path}`).toBe('string');
        expect(leaf.trim().length, `${locale}.${path}`).toBeGreaterThan(0);
      }
    }
  });

  it('translates every leaf except the ones that are the same word in both', () => {
    const identical = KEYS.filter((path) => leafAt(staffKo, path) === leafAt(staffEn, path));
    expect(identical).toEqual(IDENTICAL_ACROSS_LOCALES);
  });

  it('carries the same interpolation placeholders in both locales', () => {
    for (const path of KEYS) {
      expect(placeholders(leafAt(staffEn, path)), path).toEqual(
        placeholders(leafAt(staffKo, path)),
      );
    }
  });
});

/**
 * 거절 화면은 코드 하나에 문장 하나로 산다. 계약이 새 사유를 하나 추가하면 `DENY_CODES` 가 먼저
 * 늘고, 여기 문장이 없는 코드는 `undefined` 를 렌더링해 **아무 이유 없는 빨간 화면**이 된다 —
 * 스태프가 관객에게 읽어 줄 말이 없는 상태. 그래서 열세 줄을 두 로케일 모두에서 센다.
 */
describe('staff deny copy', () => {
  it.each([
    ['ko', staffKo.deny],
    ['en', staffEn.deny],
  ])('covers every spec §13 refusal code in %s', (_locale, table) => {
    expect(Object.keys(table).sort()).toEqual([...DENY_CODES].sort());
  });
});

/**
 * 설치 화면(T15)과 게이트 콘솔(T31)이 **한 표를 읽는다**는 보증. 예전 `staff/setup/copy.ts` 가
 * 사라지면서 이름만 남았으니, 그 이름이 다시 제 문장을 따로 들고 갈라지면 여기서 끊는다.
 * 훅(`useStaffSetupCopy`)은 설치 화면 자신의 테스트가 이미 렌더링으로 덮는다.
 */
describe('staff setup copy', () => {
  it('is the setup branch of the one staff table, not a copy of it', () => {
    expect(staffSetupKo).toBe(staffKo.setup);
    expect(staffSetupEn).toBe(staffEn.setup);
  });
});

/**
 * 수동 승인 창도 거절 화면과 같은 모양의 구멍을 낼 수 있다. 사유 코드는 계약이 정하고
 * (`@monti/shared` 의 `OVERRIDE_REASONS`), 역할 표식은 `Ticket.ManualOverride` 가 정한다.
 * 01b 가 다섯 번째 사유를 더하는 날 문장이 없는 선택지가 생기면 `undefined` 가 그려진 채로
 * 승인이 기록되고, 그것은 사유 없이 열린 문과 같은 말이다.
 */
describe('staff override copy', () => {
  it.each([
    ['ko', staffKo.override],
    ['en', staffEn.override],
  ])('has a sentence for every reason code the contracts record, in %s', (_locale, table) => {
    for (const code of OVERRIDE_REASONS) {
      const leaf = (table as Record<string, string | undefined>)[`reason${code}`];
      expect(leaf?.trim().length ?? 0, `reason${code}`).toBeGreaterThan(0);
    }
  });

  it.each([
    ['ko', staffKo.override],
    ['en', staffEn.override],
  ])('has a sentence for every role the chain can tag an override with, in %s', (_locale, table) => {
    const roles: readonly OverrideRole[] = ['approver', 'manager', 'none'];
    for (const role of roles) {
      const key = `role${role[0]!.toUpperCase()}${role.slice(1)}`;
      const leaf = (table as Record<string, string | undefined>)[key];
      expect(leaf?.trim().length ?? 0, key).toBeGreaterThan(0);
    }
  });
});
