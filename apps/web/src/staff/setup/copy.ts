import { useLocale } from '../../shared/i18n';

/**
 * 스태프 설치 화면의 문구. 관객 카피(`shared/copy`)와 **한 덩어리로 묶지 않는다**:
 * `copy-lint` 는 `staff`·`organizer` 디렉터리를 건너뛰도록 만들어져 있고, 그건 실수가 아니라
 * 규칙이다 — 관객에게 금지된 낱말이 스태프에게는 그냥 일하는 말이다. 그래도 관객 카피와 같은
 * 원칙은 지킨다: 두 로케일, 같은 키, 문장은 여기 말고 어디에도 쓰지 않는다.
 *
 * The staff phone is held by someone who is being watched by a queue, so every line says what
 * happened and what to do next — never just that something went wrong.
 */
export const staffSetupKo = {
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
};

export const staffSetupEn: typeof staffSetupKo = {
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
};

export type StaffSetupCopy = typeof staffSetupKo;

/** Same locale the attendee screens follow, so one device speaks one language. */
export function useStaffSetupCopy(): StaffSetupCopy {
  return useLocale() === 'en' ? staffSetupEn : staffSetupKo;
}
