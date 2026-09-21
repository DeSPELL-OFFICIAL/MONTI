import { useState, type ReactElement } from 'react';

import { Button } from '../../shared/ui';
import { useStaffCopy, type StaffCopy } from '../copy';

/** 스펙이 인정하는 네 가지 사유. 숫자는 결재 기록에 그대로 남으므로 순서를 바꾸지 않는다. */
export type OverrideReason = 1 | 2 | 3 | 4;

const REASONS: ReadonlyArray<readonly [OverrideReason, keyof StaffCopy['override']]> = [
  [1, 'reason1'],
  [2, 'reason2'],
  [3, 'reason3'],
  [4, 'reason4'],
];

const NON_DIGITS = /\D/g;

function toReason(value: string): OverrideReason {
  const parsed = Number(value);
  return parsed === 2 || parsed === 3 || parsed === 4 ? parsed : 1;
}

export interface OverrideDialogProps {
  canApprove: boolean;
  onSubmit: (pin: string, reason: OverrideReason) => void;
  onCancel: () => void;
}

/**
 * 수동 승인 창의 **껍데기**. 승인 판단 자체는 04 T32 가 가져간다.
 *
 * 그래서 이 파일은 PIN 과 사유를 받아 그대로 넘기는 일만 하고, 그 값이 옳은지는 묻지 않는다.
 * 여기서 조금이라도 판단을 하면 — 예컨대 "PIN 이 네 자리면 승인" 같은 것 — 승인 규칙이 화면과
 * 서버 두 곳에 살게 되고, 문을 여는 권한의 규칙이 두 곳에 사는 것은 그 자체로 사고다.
 *
 * 단추 문구가 권한에 따라 갈리는 것은 판단이 아니라 사실의 표시다: 승인할 수 있는 사람에게는
 * "수동 승인", 없는 사람에게는 "결재 요청 보내기" — 누를 수 없는 단추를 비활성으로 보여주고
 * 끝내면, 권한 없는 스태프 앞에 선 관객은 아무 데도 갈 수 없다.
 *
 * PIN 은 가려서 받는다. 줄 서 있는 사람들이 보고 있는 화면이다.
 */
export function OverrideDialog({ canApprove, onSubmit, onCancel }: OverrideDialogProps): ReactElement {
  const copy = useStaffCopy();
  const [pin, setPin] = useState('');
  const [reason, setReason] = useState<OverrideReason>(1);

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
          onChange={(event) => setPin(event.target.value.replace(NON_DIGITS, ''))}
        />
      </label>

      <label className="gate-dialog__field">
        <span>{copy.override.reasonLabel}</span>
        <select value={String(reason)} onChange={(event) => setReason(toReason(event.target.value))}>
          {REASONS.map(([value, key]) => (
            <option key={value} value={String(value)}>
              {copy.override[key]}
            </option>
          ))}
        </select>
      </label>

      <Button onClick={() => onSubmit(pin, reason)}>
        {canApprove ? copy.override.approve : copy.override.request}
      </Button>
      <Button variant="ghost" onClick={onCancel}>{copy.override.cancel}</Button>
    </div>
  );
}
