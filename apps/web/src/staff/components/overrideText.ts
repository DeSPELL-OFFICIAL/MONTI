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
 * 승인한 사람을 글자로. 승인자는 언제나 이 단말기를 든 스태프 본인의 계정이라(`types.ts`
 * `approver`), 0x 주소 대신 "나"와 그 권한으로 말한다 — 스태프가 읽을 수 있는 말은 그쪽이다.
 */
export function approverLine(copy: StaffCopy, role: OverrideRole | undefined): string {
  if (role === 'approver') return copy.override.approverMeApprover;
  if (role === 'manager') return copy.override.approverMeManager;
  return copy.override.approverMe;
}

/** 스태프가 티켓 번호 끝 네 자리로 사람을 맞춘다. 그 네 자리만 남기고 가린다. */
const TICKET_TAIL = 4;

/**
 * 찾기 결과와 고른 사람 한 줄: 표시 이름(비워 뒀으면 "게스트")과 티켓 번호 끝 네 자리.
 * 티켓 번호는 31자리 숫자라 문자열로만 자른다.
 */
export function guestLine(copy: StaffCopy, ticket: { displayName: string; tokenId: string }): string {
  const name = ticket.displayName.trim() === '' ? copy.override.guest : ticket.displayName;
  return `${name} ••${ticket.tokenId.slice(-TICKET_TAIL)}`;
}

/** 막힌 이유를 문장으로. 숫자를 끼워 넣는 두 가지만 여기 있고, 나머지는 키 하나로 끝난다. */
export const overrideNotice = {
  pinWrong: (copy: StaffCopy, triesLeft: number): string =>
    fmt(copy.override.pinWrong, { tries: triesLeft }),
  pinLocked: (copy: StaffCopy, retryInMs: number): string =>
    fmt(copy.override.pinLocked, { seconds: Math.ceil(retryInMs / 1000) }),
};
