import { useLocale } from '../shared/i18n';
import type { DenyCode } from './types';

/**
 * **모든 스태프 문장이 사는 한 곳.** 설치 화면(T15)과 게이트 콘솔(T31), 대기·충돌 화면, QR 대체
 * 경로가 전부 여기서 갈라져 나온다.
 *
 * 이 모듈이 생기기 전에는 설치 문구가 `staff/setup/copy.ts` 에 따로 있었고, 그 파일은 자기 주석에
 * "`copy-lint` 는 `staff` 디렉터리를 건너뛴다 — 관객에게 금지된 낱말이 스태프에게는 그냥 일하는
 * 말이다"라고 적어 두었다. **그 규칙은 뒤집혔다.** 게이트 화면은 관객이 스태프 어깨 너머로 같이
 * 보는 화면이고("이미 입장했어요"를 읽는 사람은 거절당한 그 관객이다), 스태프도 크립토를 모르는
 * 아르바이트생이다. 그래서 `lint:copy` 가 이제 `apps/web/src/staff` 도 훑는다 — 스펙 §3.2 의
 * 금지어는 여기서도 금지어다. "체인 확인 중"이 "확인 중입니다"가 된 이유가 그것이다.
 *
 * 규칙은 관객 카피(`shared/copy`)와 같다: 두 로케일, 같은 키, 문장은 여기 말고 어디에도 쓰지
 * 않는다. 컴포넌트는 문장을 만들지 않고 고르기만 한다.
 *
 * The staff phone is held by someone being watched by a queue, so every line says what happened
 * and what to do next — never just that something went wrong.
 */
export const staffKo = {
  /** 게이트 단말기 등록 화면(스펙 §5.7-1). */
  setup: {
    title: '게이트 단말기 등록',
    creating: '이 단말기 보안 칩에 게이트 키를 만들고 있어요.',
    eventLabel: '행사 번호',
    eventHint: '관리자에게 받은 행사 번호가 맞는지 확인하고 누르세요. 승인된 뒤에는 다른 행사로 옮길 수 없어요.',
    eventInvalid: '숫자만 넣을 수 있어요.',
    eventApply: '이 행사에 등록 요청',
    notRequested: '아직 등록을 요청하지 않았어요. 행사 번호를 확인하고 위 단추를 누르세요.',
    submitting: '등록을 요청하고 있어요.',
    submitted: '등록을 요청했어요. 관리자가 승인하면 이 화면이 저절로 넘어가요.',
    waitingUnsent: '아직 요청이 접수되지 않았어요. 아래 값을 관리자에게 직접 전달하세요.',
    elapsed: '{{seconds}}초째 기다리는 중',
    resubmit: '다시 요청',
    registeredTitle: '등록됐어요',
    registeredBody: '이제 이 단말기로 입장을 받을 수 있어요.',
    openGate: '입장 받기 시작',
    gateIdLabel: '게이트 번호',
    orgIdLabel: '주최 번호',
    notOpen: '관리자가 아직 이 게이트의 문을 열지 않았어요.',
    revoked: '이 게이트는 폐기됐어요. 관리자에게 문의하세요.',
    fallbackTitle: '관리자가 직접 등록할 때',
    fallbackHint: '아래 QR을 관리자 화면으로 읽히거나, 값을 그대로 읽어 주세요.',
    accountLabel: '게이트 계정 주소',
    kxLabel: '공개키 X',
    kyLabel: '공개키 Y',
    qrAlt: '게이트 등록 정보 QR',
    errKeyUnavailable: '이 단말기에서는 게이트 키를 만들 수 없어요. 다른 단말기를 쓰세요.',
    errAuthRequired: '로그인한 뒤에 등록을 요청할 수 있어요.',
    signIn: '휴대폰 번호로 로그인',
    errNotYourGate: '이 단말기는 다른 사람이 이미 등록을 요청했어요. 그 사람이 다시 요청하거나, 관리자에게 문의하세요.',
    errTooManyPending: '승인 대기 중인 단말기가 너무 많아요. 관리자가 먼저 승인하거나 취소해야 해요.',
    errUnknownEvent: '그런 행사 번호가 없어요. 번호를 다시 확인해 주세요.',
    errSubmitRejected: '등록 요청을 보내지 못했어요. 아래 값을 관리자에게 직접 전달하세요.',
    errChainUnreachable: '등록 상태를 확인하지 못했어요. 계속 다시 확인하고 있어요.',
    /**
     * PIN 단계(04 T32). 등록이 끝난 패널에서만 보이고, 여기서 정하기 전에는 입장을 받으러
     * 갈 수 없다 — 수동 승인 창을 여는 열쇠가 이 숫자 몇 자리뿐이기 때문이다.
     */
    pinTitle: '수동 승인 PIN',
    pinHint: '티켓을 손으로 들여보낼 때 쓸 숫자 {{digits}}자리를 정하세요. 이 단말기에만 저장되고 아무 데도 보내지 않아요.',
    pinLabel: '새 PIN',
    pinConfirmLabel: '한 번 더',
    pinSave: 'PIN 저장',
    pinSaved: 'PIN을 저장했어요.',
    pinChange: 'PIN 다시 정하기',
    pinTooShort: '{{digits}}자리 이상 숫자로 정해 주세요.',
    pinMismatch: '두 번 넣은 숫자가 서로 달라요.',
    pinRequired: '입장을 받기 전에 PIN을 먼저 정하세요.',
    pinFailed: 'PIN을 저장하지 못했어요. 다시 해 보세요.',
    /** 문이 열려 있다는 답을 이번에 받지 못해, 지난번 답으로 열어 둔 상태(04 T30 재리뷰). */
    gateOpenStale: '연결이 안 돼서 지난번에 확인한 상태로 열었어요. 관리자에게 확인해 주세요.',
  },

  /** 콘솔 머리글. 게이트가 지금 무엇을 믿고 문을 여는지 한 줄로 말한다. */
  shell: {
    staffLabel: '담당',
    /** 기록은 올라갔지만 아직 되돌려질 수 있는 상태(스펙 §7.2 8단계 앞쪽). */
    stageRecording: '기록 중',
    /** 되돌릴 수 없게 굳은 상태. */
    stageSettled: '확정',
    stageOffline: '연결 끊김',
    snapshotLabel: '명단',
    snapshotFresh: '방금 받음',
    snapshotAge: '{{minutes}}분 전',
    /** 명단을 아직 한 번도 받지 못했을 때. 나이가 없으니 숫자로 말하지 않는다. */
    snapshotNone: '아직 못 받음',
    entriesLabel: '입장',
    entriesCount: '{{count}}명',
  },

  /** 다음 관객을 기다리는 화면. */
  ready: {
    tap: '여기에 대주세요',
    hint: '휴대폰 뒷면을 화면 가운데에 대주세요.',
    /** 카드 흉내를 낼 수 없는 기기(브라우저·아이폰). 탭은 오지 않으니 할 일을 말한다. */
    unavailable: '이 브라우저에서는 단말기 모드를 쓸 수 없어요. 수동 승인으로 입장을 처리해 주세요.',
  },

  /**
   * NFC 로 답을 돌려주지 못하는 휴대폰을 위한 QR 대체 경로. 스태프 앱에서 카메라를 두고 하는 말은
   * 이 다섯 줄뿐이고, 줄마다 다음에 할 일을 적는다 — 이 폰을 든 스태프는 줄 선 사람들이 보고
   * 있어서, "읽지 못했어요"만 띄우면 사람이 그 자리에 멈춘다.
   */
  qr: {
    scanButton: 'QR로 확인',
    cameraDenied: '카메라를 쓸 수 없어요. 설정에서 카메라 권한을 켜고 다시 누르세요.',
    notGateCode: '입장 QR이 아니에요. 관객 화면의 QR을 비춰 주세요.',
    unavailable: '이 단말기에서는 QR을 읽을 수 없어요. NFC로 받아 주세요.',
    failed: 'QR을 읽지 못했어요. 다시 누르세요.',
  },

  /** 티켓을 받았고, 아직 보내기 전. */
  received: {
    title: '티켓을 받았어요',
    ticketLabel: '티켓 번호',
    precheckOk: '명단에서 확인했어요',
    precheckUnknown: '명단에 없는 티켓이에요. 지금 확인할게요',
    precheckFail: '명단에서 문제를 찾았어요',
  },

  /**
   * 보냈고, 답을 기다리는 중.
   *
   * 5초가 지나도 `wait` 는 **다시 대라는 말이 아니다**. 그 시점에도 작업은 살아 있고 6초에 온
   * 승인은 여전히 초록이다(스펙 §7.3). 예전 문구 "다시 대세요"는 관객을 한 번 더 대게 만들어
   * 같은 표로 두 번 보내는 일을 불렀다. 지금은 기다리라고만 말한다.
   */
  confirming: {
    title: '확인 중입니다',
    wait: '잠시만 기다려 주세요',
  },

  /** 입장. 초록은 여기에만 쓴다. */
  admit: {
    title: '입장',
    entryLabel: '입장 순번',
    entryValue: '{{count}}번째',
    settled: '확정됐어요',
    recording: '기록하고 있어요',
    deviceChanged: '24시간 안에 휴대폰을 바꿨어요',
    photoAlt: '{{name}} 님 사진',
    avatarAlt: '{{name}} 님 기본 그림',
  },

  /**
   * 연결이 끊긴 채 들여보낸 입장. 초록을 쓰지 않는다 — 아직 기록되지 않은 입장을 확정된 입장과
   * 같은 색으로 보여주면 스태프가 끝난 일로 착각한다.
   */
  offlineAdmit: {
    title: '연결 없이 입장',
    note: '연결이 돌아오면 기록할게요',
  },

  /** 스펙 §13 거절 사유. 코드 하나에 문장 하나, 열세 개 전부. */
  deny: {
    ALREADY_USED: '이미 입장했어요',
    WRONG_EVENT: '다른 행사 티켓이에요',
    REVOKED: '취소된 티켓이에요',
    EXPIRED_CODE: '시간이 지난 표시예요. 다시 대주세요',
    NO_TICKET: '티켓이 없어요',
    GATE_CLOSED: '아직 이 문을 열지 않았어요',
    DEVICE_LOCKED: '휴대폰 잠금을 풀고 다시 대주세요',
    DEVICE_MISMATCH: '티켓을 받은 휴대폰이 아니에요',
    GATE_MISMATCH: '다른 입구로 가주세요',
    EVENT_ENDED: '행사가 끝났어요',
    EVENT_CANCELLED: '취소된 행사예요',
    TX_FAILED: '보내지 못했어요. 다시 대주세요',
    UNKNOWN_REVERT: '이유를 읽지 못했어요. 관리자에게 문의하세요',
  } satisfies Record<DenyCode, string>,

  /** 거절 화면 자체를 부르는 말. 사유 문장 위에 붙는다. */
  denyTitle: '입장 불가',

  /** 탭을 받지 않은 이유(`gate/machine.ts` 의 `TAP_REFUSAL`). 관객이 아니라 게이트 사정이다. */
  refusal: {
    confirming: '앞사람을 확인하고 있어요. 잠시만 기다려 주세요',
    showingVerdict: '화면을 읽고 다음을 눌러 주세요',
  },

  /** 직전 탭 슬롯. 다음 관객을 받는 중에도 방금 무슨 일이 있었는지 남긴다. */
  lastTap: {
    label: '직전',
    admit: '입장',
    offlineAdmit: '연결 없이 입장',
    deny: '입장 불가',
    /** 손으로 들여보냈거나, 결재를 요청했거나(04 T32). 어느 쪽인지는 그때 창이 말했다. */
    override: '수동 승인',
    none: '아직 없어요',
  },

  /**
   * 아직 보내지 못한 입장 기록(`queue/opQueue.ts`). 콘솔 배너는 몇 건이 남았고 왜 멈췄는지만
   * 말하고, 대기·충돌 화면(`queue/QueueScreen.tsx`)이 그 기록을 한 줄씩 펼친다. 충돌 줄이 고칠
   * 방법을 권하지 않는 이유는 그런 방법이 없기 때문이다 — 이미 들어간 사람은 되돌릴 수 없으니,
   * 스태프가 소리 내어 읽을 수 있는 기록으로 쓴다.
   */
  queue: {
    pending: '보낼 입장 {{count}}건',
    parked: '멈춘 입장 {{count}}건',
    sending: '연결이 돌아오면 저절로 보내요',
    lateWindowElapsed: '입장 기록을 보낼 수 있는 시간이 지났어요. 남은 기록을 관리자에게 전달하세요.',
    lateUnavailable: '이 단말기로는 늦은 입장 기록을 보낼 수 없어요. 앱을 새로 받아 주세요.',
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
  },

  /** 수동 승인 창. 이 태스크는 껍데기만 만든다 — 승인 자체는 04 T32. */
  override: {
    title: '수동 승인',
    /** 판정 옆에 붙는 단추. 이것을 눌러야 아래 창이 열린다. */
    open: '수동 승인하기',
    pin: 'PIN',
    reasonLabel: '사유',
    reason1: '사진 대조',
    reason2: '휴대폰 문제',
    reason3: '시간이 지난 표시',
    reason4: '기타',
    approve: '수동 승인',
    request: '결재 요청 보내기',
    cancel: '취소',
    /** 탭이 없을 때 명단에서 사람을 찾는 칸(04 T32 룰링 1). */
    searchLabel: '이름 또는 티켓 번호',
    searchHint: '이름 일부나 티켓 번호 뒷자리를 넣으세요.',
    searchEmpty: '명단에서 찾지 못했어요. 다르게 넣어 보세요.',
    chosenLabel: '들여보낼 사람',
    searchAgain: '다시 찾기',
    /** 보낸 뒤. 체인 사건이 남길 것과 같은 세 가지를 화면에도 그대로 적는다. */
    sending: '보내고 있어요. 잠시만요.',
    requested: '요청됨 — 승인 대기',
    approved: '들여보냈어요.',
    failed: '보내지 못했어요. 다시 해 보세요.',
    approverLabel: '승인한 사람',
    /** 승인한 사람은 언제나 이 단말기를 든 스태프 본인이다. 주소 대신 그렇게 말한다. */
    approverMeApprover: '나 (주최자)',
    approverMeManager: '나 (매니저)',
    approverMe: '나',
    /** 표시 이름을 비워 둔 관객. 관객 화면의 티켓과 같은 말을 쓴다. */
    guest: '게스트',
    roleLabel: '권한',
    roleApprover: '주최자 · 승인 권한 있음',
    roleManager: '매니저 · 승인 권한 있음',
    roleNone: '승인 권한 없음 · 요청만 가능',
    /** 막혔을 때. 전부 다음에 무엇을 하면 되는지까지 말한다. */
    pinWrong: 'PIN이 달라요. {{tries}}번 더 틀리면 잠겨요.',
    pinLocked: 'PIN을 여러 번 틀렸어요. {{seconds}}초 뒤에 다시 해 보세요.',
    pinUnset: '이 단말기에는 아직 PIN이 없어요. 등록 화면에서 먼저 정하세요.',
    denied: '이 계정에는 손으로 들여보낼 권한이 없어요. 관리자에게 문의하세요.',
    noTicket: '누구를 들여보낼지 먼저 고르세요.',
    /** 잠금 화면을 닫았을 때. "다시 해 보세요"는 여기서 틀린 안내다 — 실패한 게 아니다. */
    cancelled: '본인 확인을 끝내야 보낼 수 있어요.',
    unreachable: '보냈는지 확인하지 못했어요. 연결을 확인하고 다시 해 보세요.',
  },

  /** 카드를 닫고 다음 관객을 받는다. */
  done: '다음',
};

export const staffEn: typeof staffKo = {
  setup: {
    title: 'Register this gate device',
    creating: 'Creating the gate key in this device’s secure chip.',
    eventLabel: 'Event number',
    eventHint: 'Check the event number the organizer gave you, then press. Once it is approved this device cannot be moved to another event.',
    eventInvalid: 'Numbers only.',
    eventApply: 'Request registration for this event',
    notRequested: 'Nothing has been requested yet. Check the event number and press the button above.',
    submitting: 'Sending the registration request.',
    submitted: 'Request sent. This screen moves on by itself once the organizer approves it.',
    waitingUnsent: 'The request has not arrived yet. Read the values below to the organizer.',
    elapsed: 'Waiting for {{seconds}}s',
    resubmit: 'Request again',
    registeredTitle: 'Registered',
    registeredBody: 'This device can now take people in.',
    openGate: 'Start taking people in',
    gateIdLabel: 'Gate number',
    orgIdLabel: 'Organizer number',
    notOpen: 'The organizer has not opened this gate yet.',
    revoked: 'This gate has been revoked. Ask the organizer.',
    fallbackTitle: 'If the organizer registers it by hand',
    fallbackHint: 'Let them scan the code, or read the values out as they are.',
    accountLabel: 'Gate account address',
    kxLabel: 'Public key X',
    kyLabel: 'Public key Y',
    qrAlt: 'Gate registration code',
    errKeyUnavailable: 'This device cannot create a gate key. Use a different one.',
    errAuthRequired: 'Sign in first to request registration.',
    signIn: 'Sign in with a phone number',
    errNotYourGate: 'Someone else already requested registration for this device. Ask them to request it again, or ask the organizer.',
    errTooManyPending: 'Too many devices are waiting for approval. The organizer has to approve or clear one first.',
    errUnknownEvent: 'There is no event with that number. Check it again.',
    errSubmitRejected: 'The request could not be sent. Read the values below to the organizer.',
    errChainUnreachable: 'Could not check the registration. Still trying.',
    pinTitle: 'Manual approval PIN',
    pinHint: 'Choose {{digits}} digits for letting somebody in by hand. It stays on this device and is never sent anywhere.',
    pinLabel: 'New PIN',
    pinConfirmLabel: 'Once more',
    pinSave: 'Save PIN',
    pinSaved: 'PIN saved.',
    pinChange: 'Set a new PIN',
    pinTooShort: 'Use at least {{digits}} digits.',
    pinMismatch: 'The two entries do not match.',
    pinRequired: 'Set a PIN before taking entries.',
    pinFailed: 'The PIN was not saved. Try again.',
    gateOpenStale: 'No connection, so this door is open on the last answer we had. Check with your organizer.',
  },

  shell: {
    staffLabel: 'Staff',
    stageRecording: 'Recording',
    stageSettled: 'Settled',
    stageOffline: 'Offline',
    snapshotLabel: 'List',
    snapshotFresh: 'Just now',
    snapshotAge: '{{minutes}} min ago',
    snapshotNone: 'Not yet',
    entriesLabel: 'Entries',
    entriesCount: '{{count}}',
  },

  ready: {
    tap: 'TAP HERE',
    hint: 'Hold the back of the phone against the middle of this screen.',
    unavailable: 'This browser cannot work as a tap terminal. Please admit people with manual approval.',
  },

  qr: {
    scanButton: 'Check with QR',
    cameraDenied: 'The camera is not available. Turn the camera permission on in Settings and press again.',
    notGateCode: 'That is not an entry code. Point the camera at the QR on the attendee’s screen.',
    unavailable: 'This device cannot read QR codes. Take the tap over NFC instead.',
    failed: 'The code could not be read. Press again.',
  },

  received: {
    title: 'Ticket received',
    ticketLabel: 'Ticket number',
    precheckOk: 'Found on the list',
    precheckUnknown: 'Not on the list. Checking now',
    precheckFail: 'The list says there is a problem',
  },

  confirming: {
    title: 'Confirming',
    wait: 'Please wait a moment',
  },

  admit: {
    title: 'ADMIT',
    entryLabel: 'Entry number',
    entryValue: 'No. {{count}}',
    settled: 'Settled',
    recording: 'Recording',
    deviceChanged: 'Phone changed in the last 24 hours',
    photoAlt: 'Photo of {{name}}',
    avatarAlt: 'Placeholder picture for {{name}}',
  },

  offlineAdmit: {
    title: 'Admitted offline',
    note: 'It will be recorded once the connection is back',
  },

  deny: {
    ALREADY_USED: 'Already entered',
    WRONG_EVENT: 'Wrong event',
    REVOKED: 'Ticket revoked',
    EXPIRED_CODE: 'That code has expired. Tap again',
    NO_TICKET: 'No ticket',
    GATE_CLOSED: 'This door is not open yet',
    DEVICE_LOCKED: 'Unlock the phone and tap again',
    DEVICE_MISMATCH: 'Not the phone this ticket was bought on',
    GATE_MISMATCH: 'Please use the other entrance',
    EVENT_ENDED: 'This event has ended',
    EVENT_CANCELLED: 'This event was cancelled',
    TX_FAILED: 'Could not send it. Tap again',
    UNKNOWN_REVERT: 'Could not read the reason. Ask the organizer',
  },

  denyTitle: 'No entry',

  refusal: {
    confirming: 'Still checking the person ahead. Please wait a moment',
    showingVerdict: 'Read the screen, then press Next',
  },

  lastTap: {
    label: 'Previous',
    admit: 'Admitted',
    offlineAdmit: 'Admitted offline',
    deny: 'No entry',
    override: 'By hand',
    none: 'Nothing yet',
  },

  queue: {
    pending: '{{count}} entries to send',
    parked: '{{count}} entries stopped',
    sending: 'They go out by themselves once the connection is back',
    lateWindowElapsed: 'The window for sending entry records has passed. Hand the rest to the organizer.',
    lateUnavailable: 'This device cannot send late entry records. Please install the new app.',
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
  },

  override: {
    title: 'Manual approval',
    open: 'Approve by hand',
    pin: 'PIN',
    reasonLabel: 'Reason',
    reason1: 'Photo check',
    reason2: 'Phone trouble',
    reason3: 'Expired code',
    reason4: 'Other',
    approve: 'Approve manually',
    request: 'Send for approval',
    cancel: 'Cancel',
    searchLabel: 'Name or ticket number',
    searchHint: 'Type part of the name, or the last digits of the ticket number.',
    searchEmpty: 'Nobody in the list matches. Try something else.',
    chosenLabel: 'Letting in',
    searchAgain: 'Search again',
    sending: 'Sending. One moment.',
    requested: 'Requested - waiting for approval',
    approved: 'They are in.',
    failed: 'It did not go through. Try again.',
    approverLabel: 'Approved by',
    approverMeApprover: 'Me (organizer)',
    approverMeManager: 'Me (manager)',
    approverMe: 'Me',
    guest: 'Guest',
    roleLabel: 'Rights',
    roleApprover: 'Organizer - may approve',
    roleManager: 'Manager - may approve',
    roleNone: 'No approval rights - may only ask',
    pinWrong: 'Wrong PIN. {{tries}} more wrong tries and it locks.',
    pinLocked: 'Too many wrong PINs. Try again in {{seconds}}s.',
    pinUnset: 'This device has no PIN yet. Set one on the registration screen.',
    denied: 'This account may not let people in by hand. Ask your organizer.',
    noTicket: 'Pick who to let in first.',
    cancelled: 'Finish the identity check to send it.',
    unreachable: 'We could not tell whether it went out. Check the connection and try again.',
  },

  done: 'Next',
};

export type StaffCopy = typeof staffKo;

/**
 * QR 대체 경로의 가지. `qr/scan.ts` 가 실패 코드마다 문장이 있는지 컴파일 타임에 확인하려고
 * 이 이름을 **타입으로만** 가져간다 — 값 하나라도 가져가면 카피를 읽는 모든 모듈이 카메라
 * 플러그인을 함께 끌고 들어온다.
 */
export type StaffQrCopy = StaffCopy['qr'];

/** 관객 화면과 같은 로케일을 따른다 — 한 단말기는 한 언어로 말한다. */
export function useStaffCopy(): StaffCopy {
  return useLocale() === 'en' ? staffEn : staffKo;
}

/** 설치 화면이 쓰는 가지. 이름은 T15 때 그대로 두되, 문장은 위 한 곳에서만 온다. */
export const staffSetupKo = staffKo.setup;
export const staffSetupEn = staffEn.setup;
export type StaffSetupCopy = StaffCopy['setup'];

export function useStaffSetupCopy(): StaffSetupCopy {
  return useStaffCopy().setup;
}
