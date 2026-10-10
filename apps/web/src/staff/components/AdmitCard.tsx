import type { ReactElement } from 'react';

import { fmt } from '../../shared/i18n';
import { Button } from '../../shared/ui';
import { useStaffCopy, type StaffCopy } from '../copy';

/**
 * 관객의 얼굴, 또는 얼굴이 없을 때 그 자리에 놓이는 것.
 *
 * `requireKyc` 가 꺼진 공연에서는 `photoJpegB64` 가 빈 문자열로 온다(`SnapshotTicket`). 그때
 * 빈 `<img>` 를 내보내면 깨진 그림 아이콘이 뜨고, 스태프는 사진을 못 받은 것인지 사진이 없는
 * 공연인지 구분하지 못한다. 그래서 글자 하나짜리 자리그림을 대신 그리고, 그것도 `role="img"`
 * 로 이름을 갖는다 — 낭독기에는 둘 다 "박서준 님 …"으로 들려야 한다.
 *
 * 입장 카드와 연결 없는 입장 카드가 **같은 함수**를 쓰는 이유는, 두 카드의 차이가 사진 처리에
 * 있어서는 안 되기 때문이다. 차이는 색과 글자와 테두리에만 있다.
 */
export function AttendeeFace({ copy, displayName, photoJpegB64 }: {
  copy: StaffCopy;
  displayName: string;
  photoJpegB64?: string;
}): ReactElement {
  if (typeof photoJpegB64 === 'string' && photoJpegB64 !== '') {
    return (
      <img
        className="gate-card__photo"
        src={`data:image/jpeg;base64,${photoJpegB64}`}
        alt={fmt(copy.admit.photoAlt, { name: displayName })}
      />
    );
  }
  return (
    <div className="gate-card__avatar" role="img" aria-label={fmt(copy.admit.avatarAlt, { name: displayName })}>
      <span aria-hidden="true">{[...displayName][0] ?? ''}</span>
    </div>
  );
}

/** 티어와 좌석은 둘 다 없을 수 있다(`SnapshotTicket` 이 빈 문자열로 준다). 있는 것만 잇는다. */
export function attendeeDetail(tierLabel?: string, seat?: string): string {
  return [tierLabel, seat].filter((part): part is string => typeof part === 'string' && part !== '').join(' · ');
}

export interface AdmitCardProps {
  displayName: string;
  /** KYC 가 없는 공연에서는 비어 있다 — 그때는 `<img>` 가 아니라 글자 자리그림을 그린다. */
  photoJpegB64?: string;
  tierLabel?: string;
  seat?: string;
  entryNumber?: number;
  finalized: boolean;
  deviceChangedRecently?: boolean;
  onDone?: () => void;
}

/**
 * 입장. 초록은 이 카드에만 쓴다.
 *
 * **색은 세 신호 중 하나일 뿐이다.** 판정은 언제나 색(`--admit`) + 글자(`admit.title`) +
 * 글리프(✓, `aria-hidden`) 세 가지를 함께 낸다. 색각 이상인 스태프, 햇빛 아래에서 채도가
 * 날아간 액정, 흑백으로 인화된 현장 사진 — 셋 다 색을 지우지만 글자와 모양은 남는다. 이
 * 규칙은 `OfflineAdmitCard`(!)와 `DenyCard`(✕)에도 똑같이 적용된다.
 *
 * `finalized` 를 굳이 화면에 적는 이유는, "입장"과 "입장했고 되돌릴 수 없다"가 스태프에게 같은
 * 약속이 아니기 때문이다. 아직 기록 중인 입장은 되돌아올 수 있고, 그 사실을 아는 사람만이
 * 나중에 무엇을 다시 확인해야 하는지 안다.
 */
export function AdmitCard({
  displayName,
  photoJpegB64,
  tierLabel,
  seat,
  entryNumber,
  finalized,
  deviceChangedRecently,
  onDone,
}: AdmitCardProps): ReactElement {
  const copy = useStaffCopy();
  const detail = attendeeDetail(tierLabel, seat);

  return (
    <div className="gate-card gate-card--admit">
      <h2 className="gate-card__label">
        <span className="gate-card__glyph" aria-hidden="true">✓</span>
        {copy.admit.title}
      </h2>
      <AttendeeFace copy={copy} displayName={displayName} photoJpegB64={photoJpegB64} />
      <div className="gate-card__body">
        <p className="gate-card__name">{displayName}</p>
        {detail === '' ? null : <p className="gate-card__detail">{detail}</p>}
        <p className="gate-card__facts">
          {entryNumber === undefined ? null : (
            <>
              <span>{copy.admit.entryLabel}</span>
              <span className="gate-card__value">{fmt(copy.admit.entryValue, { count: entryNumber })}</span>
            </>
          )}
        </p>
        <p className="gate-card__line">{finalized ? copy.admit.settled : copy.admit.recording}</p>
      </div>
      {deviceChangedRecently === true ? (
        <p className="gate-card__warning">{copy.admit.deviceChanged}</p>
      ) : null}
      {onDone === undefined ? null : (
        <div className="gate-card__actions">
          <Button onClick={onDone}>{copy.done}</Button>
        </div>
      )}
    </div>
  );
}
