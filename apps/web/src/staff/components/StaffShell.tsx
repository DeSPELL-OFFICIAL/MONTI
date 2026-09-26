import type { ReactElement, ReactNode } from 'react';

import { fmt } from '../../shared/i18n';
import { useStaffCopy, type StaffCopy } from '../copy';

/** 1분. 그 안에 받은 명단은 나이를 숫자로 말할 만큼 늙지 않았다. */
const FRESH_MS = 60_000;

/**
 * 명단이 얼마나 묵었는지 한 문장으로.
 *
 * 머리글과 `OfflineBadge` 가 **같은 문장**을 말해야 해서 나눗셈이 여기 한 번만 있다. 두 곳이
 * 각자 계산하면 한쪽만 고쳐지는 날이 오고, 그날 스태프는 같은 화면에서 서로 다른 두 나이를
 * 읽는다.
 */
export function snapshotAgeLine(copy: StaffCopy, snapshotAgeMs: number): string {
  return snapshotAgeMs < FRESH_MS
    ? copy.shell.snapshotFresh
    : fmt(copy.shell.snapshotAge, { minutes: Math.floor(snapshotAgeMs / FRESH_MS) });
}

export interface StaffShellProps {
  gateName: string;
  eventTitle: string;
  staffName?: string;
  blockNumber?: bigint;
  finalized: boolean;
  online: boolean;
  snapshotAgeMs: number;
  entriesCount: number;
  /** `OfflineBadge` / `QueueBanner` 자리. 판정 영역 위에 붙는다. */
  banner?: ReactNode;
  /** `LastTapChip` 자리. 판정 영역 아래에 붙는다. */
  footer?: ReactNode;
  children: ReactNode;
}

/**
 * 콘솔의 틀. 머리글 한 덩어리, 판정 한 덩어리, 그 위아래 슬롯 두 개가 전부다.
 *
 * 머리글은 **이 문이 지금 무엇을 믿고 열리는지**를 말한다. 연결 상태가 `finalized` 보다 앞에
 * 오는 이유가 그것이다: 연결이 끊긴 단말기에서 "확정"은 아무것도 확정하지 않는다 — 마지막으로
 * 들은 이야기일 뿐이고, 그 사이 무엇이 바뀌었는지 이 단말기는 알 길이 없다. 그래서 오프라인은
 * 다른 무엇도 덮어쓰지 못하는 첫 번째 사실이다.
 *
 * `aria-live` 는 **이 파일에만** 있다. 카드마다 live 영역을 두면 카드가 교체될 때마다 낭독이
 * 겹치고, 스태프가 듣는 것은 두 판정이 섞인 소리가 된다. 한 자리에서 통째로(`aria-atomic`)
 * 읽히는 편이 "입장, 박서준, 확정됐어요"라는 한 문장에 가깝다.
 */
export function StaffShell({
  gateName,
  eventTitle,
  staffName,
  blockNumber,
  finalized,
  online,
  snapshotAgeMs,
  entriesCount,
  banner,
  footer,
  children,
}: StaffShellProps): ReactElement {
  const copy = useStaffCopy();
  const stage = !online
    ? copy.shell.stageOffline
    : finalized
      ? copy.shell.stageSettled
      : copy.shell.stageRecording;

  return (
    <div className="gate">
      <header className="gate__header">
        <h1 className="gate__gate-name">{gateName}</h1>
        <p className="gate__event">
          <span>{eventTitle}</span>
          {staffName === undefined ? null : (
            <span className="gate__staff">
              {copy.shell.staffLabel} {staffName}
            </span>
          )}
        </p>
        <p className="gate__stage">
          <span className="gate__stage-word">{stage}</span>
          {blockNumber === undefined ? null : (
            <span className="gate__block">
              {copy.shell.blockLabel} {String(blockNumber)}
            </span>
          )}
        </p>
        <p className="gate__list">
          <span>{copy.shell.snapshotLabel}</span>
          <span className="gate__list-value">{snapshotAgeLine(copy, snapshotAgeMs)}</span>
          <span>{copy.shell.entriesLabel}</span>
          <span className="gate__list-value">{fmt(copy.shell.entriesCount, { count: entriesCount })}</span>
        </p>
      </header>

      {banner === undefined ? null : <div className="gate__banner">{banner}</div>}

      <section className="gate__verdict" aria-live="polite" aria-atomic="true">
        {children}
      </section>

      {footer === undefined ? null : <div className="gate__footer">{footer}</div>}
    </div>
  );
}
