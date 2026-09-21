import { useLocale } from '../../shared/i18n';

/**
 * 대기·충돌 화면의 문구. `staff/setup/copy.ts` 와 같은 규칙을 따른다 — 관객 카피
 * (`shared/copy`)와 한 덩어리로 묶지 않고(`copy-lint` 가 `staff` 를 건너뛰는 건 규칙이다),
 * 그래도 두 로케일·같은 키·문장은 여기 말고 어디에도 쓰지 않는다. 관객에게 금지된 낱말은
 * 스태프 화면에서도 쓰지 않았다: 여기 나오는 건 '입장 기록'과 '게이트'뿐이다.
 *
 * Every line says what happened and what to do next. The conflict lines especially: nobody
 * already inside can be sent back, so the screen's job is to let a staff member read the record
 * out loud, not to offer a fix that does not exist.
 */
export const staffQueueKo = {
  title: '대기 · 충돌',
  counts: '대기 {{waiting}}건 · 기록 완료 {{done}}건 · 충돌 {{conflicts}}건 · 멈춤 {{parked}}건',
  empty: '대기 중인 입장 기록이 없어요.',
  reconcile: '지금 맞춰 보기',
  reconciling: '맞춰 보는 중',
  conflictsTitle: '충돌',
  conflictsHint: '같은 티켓이 이미 들어온 것으로 기록돼 있어요. 들어온 사람을 되돌릴 수는 없고, 아래는 그 기록이에요.',
  conflictLine: '티켓 {{tokenId}} · {{gateId}}번 게이트가 {{time}}에 먼저 받았어요',
  conflictLineManual: '티켓 {{tokenId}} · {{gateId}}번 게이트에서 {{time}}에 수동 승인됐어요',
  parkedTitle: '멈춘 기록',
  parkedHint: '여러 번 보내지 못해 멈춰 있어요. 신호가 돌아왔으면 하나씩 다시 보내세요.',
  ticket: '티켓 {{tokenId}}',
  retry: '다시 보내기',
  retrying: '보내는 중',
  reasonLateWindow: '행사 마감이 지나서 보내지 못했어요.',
  reasonNotDeployed: '이 단말기 버전으로는 아직 보낼 수 없어요. 앱을 업데이트한 뒤 다시 보내세요.',
  reasonResendExhausted: '여러 번 다시 보냈는데도 기록되지 않았어요. 주최자에게 알리세요.',
  reasonOther: '보내지 못했어요.',
};

export const staffQueueEn: typeof staffQueueKo = {
  title: 'Waiting · Conflicts',
  counts: 'Waiting {{waiting}} · Recorded {{done}} · Conflicts {{conflicts}} · Stopped {{parked}}',
  empty: 'Nothing is waiting.',
  reconcile: 'Check now',
  reconciling: 'Checking',
  conflictsTitle: 'Conflicts',
  conflictsHint: 'The same ticket is already recorded as admitted. Nobody already inside can be sent back — what follows is the record.',
  conflictLine: 'Ticket {{tokenId}} · gate {{gateId}} took it first at {{time}}',
  conflictLineManual: 'Ticket {{tokenId}} · approved by hand at gate {{gateId}} at {{time}}',
  parkedTitle: 'Stopped',
  parkedHint: 'These could not be sent after several tries. If the signal is back, send them again one at a time.',
  ticket: 'Ticket {{tokenId}}',
  retry: 'Send again',
  retrying: 'Sending',
  reasonLateWindow: 'The event deadline passed before this could be sent.',
  reasonNotDeployed: 'This device version cannot send it yet. Update the app, then send it again.',
  reasonResendExhausted: 'Sent again several times and still not recorded. Tell the organizer.',
  reasonOther: 'Could not be sent.',
};

export type StaffQueueCopy = typeof staffQueueKo;

/** Same locale the attendee screens follow, so one device speaks one language. */
export function useStaffQueueCopy(): StaffQueueCopy {
  return useLocale() === 'en' ? staffQueueEn : staffQueueKo;
}
