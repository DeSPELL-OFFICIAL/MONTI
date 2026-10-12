/**
 * Every string the open-mode screens (`/start`, the open `/recover`, the profile note) show. Kept
 * in its own module rather than in `shared/copy` so this feature can land beside the copy sweep
 * running on the shared tables without the two colliding. English is the primary text; Korean
 * mirrors it key for key (the `StartCopy` type enforces that). Dependency-free, so the e2e spec
 * imports the same strings it asserts on (`e2e/utils/openStart.ts`); the hook is `useStartCopy.ts`.
 */
export const en = {
  title: 'Welcome to MONTI',
  cta: 'Get started',
  subtitle: 'No sign-up form. Your pass is created on this device in about 15 seconds.',
  stepCreate: 'Creating your pass…',
  stepSecure: 'Securing it…',
  stepDone: 'Done',
  stepCreateLabel: 'Create',
  stepSecureLabel: 'Secure',
  stepDoneLabel: 'Done',
  busy: 'A lot of people are joining right now · retrying…',
  slow: 'This is taking a little longer than usual. Please keep this page open.',
  retry: 'Try again',
  failed: 'We could not create your pass. Please try again.',
  busyFailed: 'It is busy right now. Please try again in a moment.',
  slowFailed: 'The connection is slow. Please try again.',
  offline: 'You seem to be offline. Check your connection and try again.',
  noStorage: 'This browser cannot keep your pass (a private window, maybe). Please open MONTI in a normal window.',
  serverBug: 'Something went wrong on our side. Please try again in a moment.',
  errorCode: 'Error code: {{code}}',
  recoverTitle: 'Start again on this device',
  recoverBody: 'The pass saved in this browser can no longer be used — its key on this device was cleared or replaced. Start again to get a new pass here.',
  recoverNote: 'Tickets on the old pass cannot be moved to the new one.',
  recoverCta: 'Start again on this device',
  recoverFailed: 'Could not reset this browser. Please try again.',
} as const;

export type StartCopy = { readonly [K in keyof typeof en]: string };

export const ko: StartCopy = {
  title: 'MONTI에 오신 걸 환영해요',
  cta: '시작하기',
  subtitle: '가입 양식이 없어요. 약 15초면 이 기기에 내 패스가 만들어져요.',
  stepCreate: '패스를 만드는 중…',
  stepSecure: '안전하게 보관하는 중…',
  stepDone: '완료',
  stepCreateLabel: '만들기',
  stepSecureLabel: '보관',
  stepDoneLabel: '완료',
  busy: '지금 사람이 많아요 · 다시 시도 중…',
  slow: '평소보다 조금 오래 걸려요. 이 화면을 열어 두세요.',
  retry: '다시 시도하기',
  failed: '패스를 만들지 못했어요. 다시 시도해 주세요.',
  busyFailed: '지금 붐벼요. 잠시 뒤 다시 시도해 주세요.',
  slowFailed: '연결이 느려요. 다시 시도해 주세요.',
  offline: '인터넷 연결이 끊긴 것 같아요. 연결을 확인하고 다시 시도해 주세요.',
  noStorage: '이 브라우저에는 패스를 보관할 수 없어요(시크릿 창일 수 있어요). 일반 창에서 MONTI를 열어 주세요.',
  serverBug: '저희 쪽에 문제가 생겼어요. 잠시 뒤 다시 시도해 주세요.',
  errorCode: '오류 코드: {{code}}',
  recoverTitle: '이 기기에서 다시 시작하기',
  recoverBody: '이 브라우저에 저장된 패스는 더 이상 쓸 수 없어요. 이 기기의 키가 지워졌거나 바뀌었어요. 다시 시작하면 여기서 새 패스를 받아요.',
  recoverNote: '예전 패스에 있던 티켓은 새 패스로 옮길 수 없어요.',
  recoverCta: '이 기기에서 다시 시작하기',
  recoverFailed: '이 브라우저를 초기화하지 못했어요. 다시 시도해 주세요.',
};
