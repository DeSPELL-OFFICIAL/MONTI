import type { ReactElement, ReactNode } from 'react';

import {
  AdmitCard,
  ConfirmingCard,
  DenyCard,
  LastTapChip,
  OfflineAdmitCard,
  OfflineBadge,
  OverrideDialog,
  QueueBanner,
  ReceivedCard,
  RefusedToast,
  StaffShell,
  TapPrompt,
} from './components';
import type { SettledTap, TapRefusal } from './gate/machine';
import type { GateContext, OverrideReason, PrecheckResult } from './types';

/** 표 번호에서 마지막 두 글자만 남긴다. 관객이 같이 보는 화면에 전체 번호를 띄우지 않는다. */
const MASK = '••';

function maskTicketId(tokenId: string | undefined): string {
  return tokenId === undefined ? MASK : `${MASK}${tokenId.slice(-2)}`;
}

/**
 * 명단만으로 답할 수 있었던 것. `deny` 가 있으면 명단이 이미 문제를 찾은 것이고, 표를 알아본
 * 것만으로는 통과가 아니다 — 모르는 표(`'unknown'`)는 온라인에서는 체결로 넘어가고 오프라인
 * 에서는 거절이 되므로, 이 카드는 판정하지 않고 "확인할게요"라고만 한다.
 */
function precheckOf(context: GateContext): PrecheckResult {
  if (context.deny !== undefined) return 'fail';
  return context.ticket === undefined ? 'unknown' : 'ok';
}

const noop = (): void => {};

export interface GateConsoleProps {
  gateName: string;
  eventTitle: string;
  staffName?: string;
  /** 기계의 `snapshot()`(`staff/types.ts`). */
  context: GateContext;
  entriesCount: number;
  /** `machine.lastSettled()`. */
  lastTap?: SettledTap;
  /** `machine.refusal()` — 받지 않은 탭. */
  refusal?: TapRefusal;
  /**
   * 입장 카드에 띄울 사진. 기본값은 명단에 서명돼 온 그대로의 사진이고(스펙 §12),
   * 배선(04 T30)이 넣어주는 것은 단 한 경우다 — 명단을 받은 뒤에 만들어진 표라 명단에
   * 사진이 없어 서버에 따로 물어봤을 때. 빈 문자열은 "사진 없는 행사"라는 뜻이며,
   * 그때 카드는 아바타와 닉네임을 그린다.
   */
  photo?: string;
  /**
   * 스펙 §13. `GateContext` 에 넣지 않는 이유는 그것이 판정의 일부가 아니기 때문이다 —
   * `Identity.deviceUpdatedAt` 을 읽고 온 배선이 카드로 곱바로 넘긴다.
   */
  deviceChangedRecently?: boolean;
  parkedCount?: number;
  queueError?: string;
  /**
   * 판정 아래, 직전 탭 옆에 붙는 손동 장치 — 오늘은 QR 폴백 단추(04 T31) 하나다.
   * 이 파일이 그것을 그리지 않는 이유는 카메라가 판정의 일부가 아니기 때문이다: 콘솔은
   * 기계가 내놓은 상태 하나만 그리고, 탭을 받는 방법은 배선이 고른다.
   */
  actions?: ReactNode;
  canApprove?: boolean;
  onDone?: () => void;
  onOverrideSubmit?: (pin: string, reason: OverrideReason) => void;
  onOverrideCancel?: () => void;
}

/**
 * 게이트 콘솔. 상태 하나에 카드 하나, 그 이상은 하지 않는다.
 *
 * 이 파일에는 상태 기계도, 라우팅도, 데이터 호출도 없다. 기계(`gate/machine.ts`)가 내놓은
 * `GateContext` 하나를 받아 **그대로** 그린다. 화면이 스스로 상태를 만들기 시작하면 "무른
 * 승인"이 생길 자리가 여기가 된다 — 5초가 지났으니 초록으로 바꿔볼까, 같은 것. 기계가 판정을
 * 주지 않으면 이 화면에도 판정이 없다.
 *
 * `entryNumber`·`deviceChangedRecently`·`photo` 는 `GateContext` 에 없다. 화면이 쓰기 좋으라고
 * 기계의 상태에 필드를 파는 것은 순서가 거꾸로다 — 셋 다 판정이 아니라 판정 옆에 붙는
 * 사실이다. 그래서 그걸 실제로 아는 자리(04 T30 의 배선)에서 프롭으로 넘어온다.
 */
export function GateConsole({
  gateName,
  eventTitle,
  staffName,
  context,
  entriesCount,
  lastTap,
  refusal,
  photo,
  deviceChangedRecently,
  parkedCount,
  queueError,
  actions,
  canApprove,
  onDone,
  onOverrideSubmit,
  onOverrideCancel,
}: GateConsoleProps): ReactElement {
  const ticket = context.ticket;

  const card = ((): ReactElement => {
    switch (context.state) {
      case 'idle':
      case 'ready':
        return <TapPrompt rotating={context.state === 'ready'} />;
      case 'received':
        return <ReceivedCard tokenIdMasked={maskTicketId(ticket?.tokenId)} precheck={precheckOf(context)} />;
      case 'confirming':
        return <ConfirmingCard checking={context.checking} waitHint={context.waitHint} />;
      case 'admit':
        return (
          <AdmitCard
            displayName={ticket?.displayName ?? ''}
            photoJpegB64={photo ?? ticket?.photoJpegB64}
            tierLabel={ticket?.tierName}
            seat={ticket?.seat}
            entryNumber={entriesCount}
            blockNumber={context.blockNumber}
            finalized={context.finalized}
            deviceChangedRecently={deviceChangedRecently}
            onDone={onDone}
          />
        );
      case 'offlineAdmit':
        return (
          <OfflineAdmitCard
            displayName={ticket?.displayName ?? ''}
            photoJpegB64={photo ?? ticket?.photoJpegB64}
            tierLabel={ticket?.tierName}
            seat={ticket?.seat}
            queuedCount={context.pendingCount}
            onDone={onDone}
          />
        );
      case 'deny':
        // 거절인데 사유가 없는 상태는 기계가 만들지 않는다 — `deny` 로 들어가는 모든 길이
        // 코드를 함께 준다. 그래도 당하면 여기서 "알 수 없는 거절"을 **지어내지** 않는다:
        // 게이트가 받지 않은 사유를 사람 앞에 띄우는 것이고, 그 화면을 읽는 사람은 방금 문 앞에서
        // 돌아선 관객이다. 대신 판정이 없는 화면으로 돌아간다(펌진 꺼진 채로 — 이 상태의
        // 게이트는 다음 관객을 받을 수 있다고 말할 처지도 아니다).
        return context.deny === undefined ? (
          <TapPrompt rotating={false} />
        ) : (
          <DenyCard code={context.deny} detail={context.denyDetail} onDone={onDone} />
        );
      case 'override':
        return (
          <OverrideDialog
            canApprove={canApprove ?? false}
            outcome={context.override}
            onSubmit={onOverrideSubmit ?? noop}
            onCancel={onOverrideCancel ?? noop}
          />
        );
    }
  })();

  return (
    <StaffShell
      gateName={gateName}
      eventTitle={eventTitle}
      staffName={staffName}
      blockNumber={context.blockNumber}
      finalized={context.finalized}
      online={context.online}
      snapshotAgeMs={context.snapshotAgeMs}
      entriesCount={entriesCount}
      banner={
        <>
          {/* 남은 건수는 바로 옆 `QueueBanner` 가 말한다. 같은 문장을 두 번 띄우지 않는다. */}
          <OfflineBadge online={context.online} snapshotAgeMs={context.snapshotAgeMs} />
          <QueueBanner
            pendingCount={context.pendingCount}
            parkedCount={parkedCount ?? 0}
            lastError={queueError}
          />
          {/*
            받지 않은 탭은 판정이 아니므로 판정 영역 밖에 산다. 생김새가 아니라 낝독 문제다:
            `RefusedToast` 는 `role="status"`(암시적 live 영역)이고, `StaffShell` 의 판정 영역은
            `aria-live` + `aria-atomic` 이다. 중첩된 live 영역은 안쪽이 바뀜 때 바깥 영역 전체가
            통째로 다시 읽히게 만든다 — 스태프가 듣는 것은 "잠시만 기다려 주세요"와 앞사람
            판정이 섞인 한 덩어리가 된다. 배너 자리에서는 자기 문장만 읽힌다.
          */}
          {refusal === undefined ? null : <RefusedToast refusal={refusal} />}
        </>
      }
      footer={
        <>
          <LastTapChip lastTap={lastTap} />
          {actions}
        </>
      }
    >
      {card}
    </StaffShell>
  );
}
