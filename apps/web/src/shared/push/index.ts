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
} as const;

export type PushUnavailableReason = (typeof PUSH_UNAVAILABLE)[keyof typeof PUSH_UNAVAILABLE];

export type PushRegistration =
  | { status: 'registered'; stop: () => void }
  | { status: 'unavailable'; reason: PushUnavailableReason };

export type PushHandler = (data: Record<string, string>) => void;

function unavailable(reason: PushUnavailableReason): PushRegistration {
  return { status: 'unavailable', reason };
}

async function registerNative(account: Hex, onPush: PushHandler): Promise<PushRegistration> {
  const permission = await PushNotifications.requestPermissions();
  if (permission.receive !== 'granted') return unavailable(PUSH_UNAVAILABLE.permissionDenied);
  const registration = await PushNotifications.addListener('registration', (token) => {
    void savePushToken(account, token.value);
  });
  const received = await PushNotifications.addListener('pushNotificationReceived', (notification) => {
    onPush((notification.data ?? {}) as Record<string, string>);
  });
  await PushNotifications.register();
  return {
    status: 'registered',
    stop: () => {
      void registration.remove();
      void received.remove();
    },
  };
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
  await savePushToken(account, token);
  return {
    status: 'registered',
    stop: onMessage(messaging, (payload) => onPush((payload.data ?? {}) as Record<string, string>)),
  };
}

/**
 * Subscribes this device to push for `account` and forwards the data payload of every message
 * that arrives while the app is in the foreground. Never throws: an attendee who refuses push,
 * or a platform that cannot do it, comes back as `{ status: 'unavailable' }`.
 */
export async function registerPush(account: Hex, onPush: PushHandler): Promise<PushRegistration> {
  return Capacitor.isNativePlatform() ? registerNative(account, onPush) : registerWeb(account, onPush);
}
