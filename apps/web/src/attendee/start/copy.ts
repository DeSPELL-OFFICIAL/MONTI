/**
 * Every string the open-mode screens (`/start`, the open `/recover`, the profile note) show. Kept
 * in its own module rather than in `shared/copy` so this feature can land beside the copy sweep
 * running on the shared tables without the two colliding. The app is English-only (`LOCALE` in
 * `shared/i18n.ts`). Dependency-free, so the e2e spec
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
