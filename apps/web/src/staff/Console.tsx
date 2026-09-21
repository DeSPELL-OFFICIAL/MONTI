import type { ReactElement } from 'react';

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
  type OverrideReason,
  type PrecheckResult,
} from './components';
import type { SettledTap, TapRefusal } from './gate/machine';
import type { GateContext } from './types';

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
  parkedCount?: number;
  queueError?: string;
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
 * `AdmitCard` 의 `entryNumber` 와 `deviceChangedRecently` 를 여기서 채우지 않는 이유: 둘 다
 * `GateContext` 에 없다. 화면이 쓰기 좋으라고 기계의 상태에 필드를 새로 파는 것은 순서가
 * 거꾸로다. 두 값은 그걸 실제로 아는 자리(04 T30 의 배선)에서 카드로 직접 넘어온다.
 */
export function GateConsole({
  gateName,
  eventTitle,
  staffName,
  context,
  entriesCount,
  lastTap,
  refusal,
  parkedCount,
  queueError,
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
        return <ConfirmingCard checking={context.checking} waitHint={context.retapHint} />;
      case 'admit':
        return (
          <AdmitCard
            displayName={ticket?.displayName ?? ''}
            photoJpegB64={ticket?.photoJpegB64}
            tierLabel={ticket?.tierName}
            seat={ticket?.seat}
            blockNumber={context.blockNumber}
            finalized={context.finalized}
            onDone={onDone}
          />
        );
      case 'offlineAdmit':
        return (
          <OfflineAdmitCard
            displayName={ticket?.displayName ?? ''}
            photoJpegB64={ticket?.photoJpegB64}
            tierLabel={ticket?.tierName}
            seat={ticket?.seat}
            queuedCount={context.pendingCount}
            onDone={onDone}
          />
        );
      case 'deny':
        return <DenyCard code={context.deny ?? 'UNKNOWN_REVERT'} detail={context.denyDetail} onDone={onDone} />;
      case 'override':
        return (
          <OverrideDialog
            canApprove={canApprove ?? false}
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
        </>
      }
      footer={<LastTapChip lastTap={lastTap} />}
    >
      {refusal === undefined ? null : <RefusedToast refusal={refusal} />}
      {card}
    </StaffShell>
  );
}
