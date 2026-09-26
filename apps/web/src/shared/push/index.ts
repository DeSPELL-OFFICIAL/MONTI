import { Capacitor } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';
import { getMessaging, getToken, isSupported, onMessage } from 'firebase/messaging';
import type { Hex } from '@monti/shared';
import { optionalEnv } from '../config';
import { getFirebaseApp } from '../api/firebase';
import { savePushToken } from '../api/firestore';

/**
 * Reasons registration did not happen. Codes, never copy — the caller decides whether a
 * missing VAPID key is worth a sentence (it is not) or a denied permission is (it is).
 */
export const PUSH_UNAVAILABLE = {
  /** The web push key is not in the environment yet; web push is simply off. */
  noVapidKey: 'PUSH_NO_VAPID_KEY',
  /** This browser has no FCM support (no service worker, or a private window). */
  unsupported: 'PUSH_UNSUPPORTED',
  /** The attendee said no, or the browser refused before a token was minted. */
  permissionDenied: 'PUSH_PERMISSION_DENIED',
  /** APNs/FCM never handed the native plugin a token. */
  registrationFailed: 'PUSH_REGISTRATION_FAILED',
  /** A token exists but `devices/{account}.pushToken` refused the write, so nothing can arrive. */
  tokenSaveFailed: 'PUSH_TOKEN_SAVE_FAILED',
} as const;

export type PushUnavailableReason = (typeof PUSH_UNAVAILABLE)[keyof typeof PUSH_UNAVAILABLE];

export type PushRegistration =
  | { status: 'registered'; stop: () => void }
  | { status: 'unavailable'; reason: PushUnavailableReason };

export type PushHandler = (data: Record<string, string>) => void;

/** The plugin answers `register()` before APNs/FCM answers it; past this, it never will. */
const NATIVE_TOKEN_TIMEOUT_MS = 10_000;

function unavailable(reason: PushUnavailableReason): PushRegistration {
  return { status: 'unavailable', reason };
}

/**
 * The write the whole registration exists for: without it the server has no token to send to.
 * A refusal is an answer, not an exception — `devices/{account}` is server-created and the
 * rules match the caller's `account` claim, so this is a write that can legitimately fail.
 */
async function storeToken(account: Hex, token: string): Promise<boolean> {
  return savePushToken(account, token).then(() => true).catch(() => false);
}

async function registerNative(account: Hex, onPush: PushHandler): Promise<PushRegistration> {
  const permission = await PushNotifications.requestPermissions();
  if (permission.receive !== 'granted') return unavailable(PUSH_UNAVAILABLE.permissionDenied);

  let settle: ((token: string | null) => void) | null = null;
  const firstToken = new Promise<string | null>((resolve) => {
    settle = resolve;
  });
  const finish = (token: string | null): void => {
    settle?.(token);
    settle = null;
  };

  // The plugin re-emits `registration` whenever APNs/FCM rotates the token, so the listener
  // outlives the first one; only the first settles the promise this call is waiting on.
  const registration = await PushNotifications.addListener('registration', (token) => {
    if (settle) {
      finish(token.value);
      return;
    }
    void storeToken(account, token.value);
  });
  const failure = await PushNotifications.addListener('registrationError', () => finish(null));
  const received = await PushNotifications.addListener('pushNotificationReceived', (notification) => {
    onPush((notification.data ?? {}) as Record<string, string>);
  });
  const stop = (): void => {
    void registration.remove();
    void failure.remove();
    void received.remove();
  };

  await PushNotifications.register();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const token = await Promise.race([
    firstToken,
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), NATIVE_TOKEN_TIMEOUT_MS);
    }),
  ]);
  if (timer) clearTimeout(timer);

  if (!token) {
    stop();
    return unavailable(PUSH_UNAVAILABLE.registrationFailed);
  }
  if (!(await storeToken(account, token))) {
    stop();
    return unavailable(PUSH_UNAVAILABLE.tokenSaveFailed);
  }
  return { status: 'registered', stop };
}

async function registerWeb(account: Hex, onPush: PushHandler): Promise<PushRegistration> {
  const vapidKey = optionalEnv('VITE_FIREBASE_VAPID_KEY');
  // The key comes from the Firebase console and is not issued yet. Until it is, web push is
  // off rather than broken: getToken without a VAPID key throws on every call.
  if (!vapidKey) return unavailable(PUSH_UNAVAILABLE.noVapidKey);
  if (!(await isSupported())) return unavailable(PUSH_UNAVAILABLE.unsupported);
  const messaging = getMessaging(getFirebaseApp());
  // getToken both asks for the Notification permission and mints the token, and throws on a
  // refusal — a denied attendee is a result here, not an exception the caller has to catch.
  const token = await getToken(messaging, { vapidKey }).catch(() => '');
  if (!token) return unavailable(PUSH_UNAVAILABLE.permissionDenied);
  if (!(await storeToken(account, token))) return unavailable(PUSH_UNAVAILABLE.tokenSaveFailed);
  return {
    status: 'registered',
    stop: onMessage(messaging, (payload) => onPush((payload.data ?? {}) as Record<string, string>)),
  };
}

/**
 * Subscribes this device to push for `account` and forwards the data payload of every message
 * that arrives while the app is in the foreground. Never rejects: a refused permission, a
 * platform that cannot do it, and a refused token write all come back as
 * `{ status: 'unavailable', reason }`.
 */
export async function registerPush(account: Hex, onPush: PushHandler): Promise<PushRegistration> {
  return Capacitor.isNativePlatform() ? registerNative(account, onPush) : registerWeb(account, onPush);
}
