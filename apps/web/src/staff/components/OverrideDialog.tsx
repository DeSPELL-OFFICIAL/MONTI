import { useState, type ReactElement } from 'react';

import { OVERRIDE_REASONS } from '@monti/shared';

import { fmt } from '../../shared/i18n';
import { Button } from '../../shared/ui';
import { useStaffCopy, type StaffCopy } from '../copy';
import type { OverrideOutcome, OverrideReason, OverrideRole } from '../types';

/**
 * 사유 목록은 `@monti/shared` 의 코드에서 나온다. 이 파일이 자기 목록을 들고 있으면 계약이
 * 기록하는 숫자와 화면이 보여주는 차례가 각자 따로 살게 되고, 그 둘이 어긋난 날 남는 것은
 * "사유 3"으로 기록된 "사유 2"다.
 */
const REASON_KEY = (code: OverrideReason): keyof StaffCopy['override'] =>
  `reason${code}` as keyof StaffCopy['override'];

const STATUS_KEY = {
  sending: 'sending',
  requested: 'requested',
  approved: 'approved',
  failed: 'failed',
} as const satisfies Record<OverrideOutcome['status'], keyof StaffCopy['override']>;

const ROLE_KEY = {
  approver: 'roleApprover',
  manager: 'roleManager',
  none: 'roleNone',
} as const satisfies Record<OverrideRole, keyof StaffCopy['override']>;

const NON_DIGITS = /\D/g;

function toReason(value: string): OverrideReason {
  const parsed = Number(value);
  return (OVERRIDE_REASONS as readonly number[]).includes(parsed)
    ? (parsed as OverrideReason)
    : OVERRIDE_REASONS[0];
}

/** 승인자 주소를 줄여서 보여준다. 줄 서 있는 사람들이 같이 보는 화면이라 전체는 띄우지 않는다. */
function shortAccount(account: string): string {
  return `${account.slice(0, 6)}…${account.slice(-4)}`;
}

export interface OverrideDialogProps {
  canApprove: boolean;
  /**
   * 이 승인이 어떻게 됐는지(04 T32). 창을 닫지 않고 여기서 그대로 보여준다 — 손으로 들여보낸
   * 기록은 체인 사건 말고는 이 화면이 유일하고, 특히 `requestOverride` 는 입장 자체를 만들지
   * 않으므로 "요청됨 — 승인 대기"를 읽지 못하면 스태프는 보냈는지조차 알 수 없다.
   */
  outcome?: OverrideOutcome;
  onSubmit: (pin: string, reason: OverrideReason) => void;
  onCancel: () => void;
}

/**
 * 수동 승인 창.
 *
 * 이 파일은 여전히 **판단하지 않는다.** PIN 이 맞는지도, 이 계정이 승인할 수 있는지도 묻지
 * 않는다 — 앞의 것은 `override/pin.ts`, 뒤의 것은 `Organizers` 를 그 자리에서 읽는
 * `override/route.ts` 의 몫이다. 여기서 조금이라도 판단을 하면 문을 여는 규칙이 화면과 체인
 * 두 곳에 살게 되고, 그것은 그 자체로 사고다.
 *
 * 단추 문구가 권한에 따라 갈리는 것은 판단이 아니라 **체인이 방금 답한 사실의 표시**다:
 * 승인할 수 있는 사람에게는 "수동 승인", 없는 사람에게는 "결재 요청 보내기" — 누를 수 없는
 * 단추를 비활성으로 보여주고 끝내면, 권한 없는 스태프 앞에 선 관객은 아무 데도 갈 수 없다.
 *
 * 보낸 뒤에 적는 세 가지(승인한 사람 · 권한 · 사유)는 `ManualOverride` 가 체인에 남길 것과
 * 같은 세 가지다. 화면과 기록이 다른 말을 하면 나중에 물어볼 곳이 없어진다.
 *
 * PIN 은 가려서 받는다. 줄 서 있는 사람들이 보고 있는 화면이다.
 */
export function OverrideDialog({ canApprove, outcome, onSubmit, onCancel }: OverrideDialogProps): ReactElement {
  const copy = useStaffCopy();
  const [pin, setPin] = useState('');
  const [reason, setReason] = useState<OverrideReason>(OVERRIDE_REASONS[0]);

  // 보내는 중이거나 이미 끝난 승인은 두 번 보내지 않는다. 실패만 다시 누를 수 있다.
  const settled = outcome?.status === 'requested' || outcome?.status === 'approved';
  const busy = outcome?.status === 'sending';

  return (
    <div className="gate-dialog" role="dialog" aria-modal="true" aria-label={copy.override.title}>
      <h2 className="gate-dialog__title">{copy.override.title}</h2>

      <label className="gate-dialog__field">
        <span aria-hidden="true">{copy.override.pin}</span>
        <input
          type="password"
          inputMode="numeric"
          autoComplete="off"
          aria-label={copy.override.pin}
          value={pin}
          disabled={busy || settled}
          onChange={(event) => setPin(event.target.value.replace(NON_DIGITS, ''))}
        />
      </label>

      <label className="gate-dialog__field">
        <span>{copy.override.reasonLabel}</span>
        <select
          value={String(reason)}
          disabled={busy || settled}
          onChange={(event) => setReason(toReason(event.target.value))}
        >
          {OVERRIDE_REASONS.map((code) => (
            <option key={code} value={String(code)}>
              {copy.override[REASON_KEY(code)]}
            </option>
          ))}
        </select>
      </label>

      {outcome === undefined ? null : <Outcome outcome={outcome} />}

      {settled ? null : (
        <Button onClick={() => onSubmit(pin, reason)} disabled={busy}>
          {canApprove ? copy.override.approve : copy.override.request}
        </Button>
      )}
      <Button variant="ghost" onClick={onCancel}>{settled ? copy.done : copy.override.cancel}</Button>
    </div>
  );
}

/**
 * 결과 한 덩이. `role="status"` 라서 스태프가 단추에서 눈을 떼고 있어도 읽힌다 — 이 창이 열려
 * 있는 동안 게이트는 탭을 받지 않으므로, 여기 말고 다른 곳에서 읽힐 문장은 없다.
 */
function Outcome({ outcome }: { outcome: OverrideOutcome }): ReactElement {
  const copy = useStaffCopy();
  return (
    <div className="gate-dialog__outcome" role="status">
      <p className="gate-dialog__outcome-line">
        {outcome.detail ?? copy.override[STATUS_KEY[outcome.status]]}
      </p>
      <dl className="gate-dialog__facts">
        <dt>{copy.override.reasonLabel}</dt>
        <dd>{copy.override[REASON_KEY(outcome.reason)]}</dd>
        {outcome.role === undefined ? null : (
          <>
            <dt>{copy.override.roleLabel}</dt>
            <dd>{copy.override[ROLE_KEY[outcome.role]]}</dd>
          </>
        )}
        {outcome.approver === undefined ? null : (
          <>
            <dt>{copy.override.approverLabel}</dt>
            <dd className="mono">{shortAccount(outcome.approver)}</dd>
          </>
        )}
      </dl>
    </div>
  );
}

/** 잠금·오입력 문장을 배선이 만들 때 쓰는 한 곳. 문장은 여전히 `copy.ts` 에서만 온다. */
export const overrideNotice = {
  pinWrong: (copy: StaffCopy, triesLeft: number): string =>
    fmt(copy.override.pinWrong, { tries: triesLeft }),
  pinLocked: (copy: StaffCopy, retryInMs: number): string =>
    fmt(copy.override.pinLocked, { seconds: Math.ceil(retryInMs / 1000) }),
};
