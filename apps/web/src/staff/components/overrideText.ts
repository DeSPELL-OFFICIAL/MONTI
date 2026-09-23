// 수동 승인 한 건을 **글자로 옮기는 법**, 한 곳.
//
// 같은 세 가지(승인한 사람 · 권한 · 사유)를 세 군데가 그린다 — 창(`OverrideDialog`), 직전 탭
// 칩(`LastTapChip`), 그리고 막혔을 때의 문장을 고르는 배선(`gate/useGate.ts`). 그 셋이 각자
// `role === 'approver' ? …` 를 쓰기 시작하면, 역할 이름이 하나 늘거나 사유 코드가 하나 늘었을 때
// 조용히 한 군데만 빠진다 — 그리고 빠지는 쪽은 언제나 나중에 읽히는 칩이다.
//
// 문장 자체는 여기에 없다. 여기 있는 것은 **어느 문장을 고르는가**뿐이고, 문장은 `copy.ts` 가
// 그대로 유일한 출처다.
import { fmt } from '../../shared/i18n';
import type { StaffCopy } from '../copy';
import type { OverrideOutcome, OverrideReason, OverrideRole } from '../types';

export const reasonKey = (code: OverrideReason): keyof StaffCopy['override'] =>
  `reason${code}` as keyof StaffCopy['override'];

export const STATUS_KEY = {
  sending: 'sending',
  requested: 'requested',
  approved: 'approved',
  failed: 'failed',
} as const satisfies Record<OverrideOutcome['status'], keyof StaffCopy['override']>;

export const ROLE_KEY = {
  approver: 'roleApprover',
  manager: 'roleManager',
  none: 'roleNone',
} as const satisfies Record<OverrideRole, keyof StaffCopy['override']>;

/**
 * 승인자 주소를 줄여서 보여준다. 줄 서 있는 사람들이 같이 보는 화면이라 전체는 띄우지 않고,
 * 그래도 나중에 체인 기록과 맞춰 볼 수 있을 만큼은 남긴다.
 */
export function shortAccount(account: string): string {
  return `${account.slice(0, 6)}…${account.slice(-4)}`;
}

/** 막힌 이유를 문장으로. 숫자를 끼워 넣는 두 가지만 여기 있고, 나머지는 키 하나로 끝난다. */
export const overrideNotice = {
  pinWrong: (copy: StaffCopy, triesLeft: number): string =>
    fmt(copy.override.pinWrong, { tries: triesLeft }),
  pinLocked: (copy: StaffCopy, retryInMs: number): string =>
    fmt(copy.override.pinLocked, { seconds: Math.ceil(retryInMs / 1000) }),
};
