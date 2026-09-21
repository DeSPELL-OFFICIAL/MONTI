import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Hex } from '@monti/shared';

let native = false;
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => native } }));

const requestPermissions = vi.fn();
const register = vi.fn();
const addListener = vi.fn();
const removeRegistration = vi.fn();
const removeReceived = vi.fn();
const nativeListeners = new Map<string, (event: unknown) => void>();
vi.mock('@capacitor/push-notifications', () => ({
  PushNotifications: { requestPermissions, register, addListener },
}));

const getMessaging = vi.fn();
const getToken = vi.fn();
const onMessage = vi.fn();
const isSupported = vi.fn();
vi.mock('firebase/messaging', () => ({ getMessaging, getToken, onMessage, isSupported }));

const savePushToken = vi.fn();
vi.mock('../api/firestore', () => ({ savePushToken }));
vi.mock('../api/firebase', () => ({ getFirebaseApp: () => ({}) }));

const { PUSH_UNAVAILABLE, registerPush } = await import('./index');

const ACCOUNT = `0x${'ab'.repeat(20)}` as Hex;
const stopMessages = vi.fn();

beforeEach(() => {
  native = false;
  nativeListeners.clear();
  vi.stubEnv('VITE_FIREBASE_VAPID_KEY', 'vapid-key');
  savePushToken.mockResolvedValue(undefined);
  isSupported.mockResolvedValue(true);
  getMessaging.mockReturnValue({});
  getToken.mockResolvedValue('web-token');
  onMessage.mockReturnValue(stopMessages);
  requestPermissions.mockResolvedValue({ receive: 'granted' });
  register.mockResolvedValue(undefined);
  addListener.mockImplementation(async (event: string, handler: (payload: unknown) => void) => {
    nativeListeners.set(event, handler);
    return { remove: event === 'registration' ? removeRegistration : removeReceived };
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('registerPush on the web', () => {
  it('is a no-op with a typed reason while the VAPID key is still missing', async () => {
    vi.stubEnv('VITE_FIREBASE_VAPID_KEY', '');
    await expect(registerPush(ACCOUNT, () => undefined)).resolves.toEqual({
      status: 'unavailable',
      reason: PUSH_UNAVAILABLE.noVapidKey,
    });
    expect(getMessaging).not.toHaveBeenCalled();
    expect(savePushToken).not.toHaveBeenCalled();
  });

  it('reports the browser as unsupported rather than throwing out of getMessaging', async () => {
    isSupported.mockResolvedValue(false);
    await expect(registerPush(ACCOUNT, () => undefined)).resolves.toEqual({
      status: 'unavailable',
      reason: PUSH_UNAVAILABLE.unsupported,
    });
  });

  it('saves the FCM token and forwards message data until stop()', async () => {
    const seen: Array<Record<string, string>> = [];
    const registration = await registerPush(ACCOUNT, (data) => seen.push(data));
    expect(getToken).toHaveBeenCalledWith({}, { vapidKey: 'vapid-key' });
    expect(savePushToken).toHaveBeenCalledWith(ACCOUNT, 'web-token');
    expect(registration.status).toBe('registered');
    const forward = onMessage.mock.calls[0]?.[1] as (payload: unknown) => void;
    forward({ data: { kind: 'gate' } });
    forward({});
    expect(seen).toEqual([{ kind: 'gate' }, {}]);
    if (registration.status === 'registered') registration.stop();
    expect(stopMessages).toHaveBeenCalled();
  });

  it('reports a denied permission instead of rejecting', async () => {
    getToken.mockRejectedValue(new Error('permission blocked'));
    await expect(registerPush(ACCOUNT, () => undefined)).resolves.toEqual({
      status: 'unavailable',
      reason: PUSH_UNAVAILABLE.permissionDenied,
    });
  });
});

describe('registerPush on native', () => {
  it('stops at a denied permission without registering', async () => {
    native = true;
    requestPermissions.mockResolvedValue({ receive: 'denied' });
    await expect(registerPush(ACCOUNT, () => undefined)).resolves.toEqual({
      status: 'unavailable',
      reason: PUSH_UNAVAILABLE.permissionDenied,
    });
    expect(register).not.toHaveBeenCalled();
  });

  it('saves the token the plugin reports and removes both listeners on stop()', async () => {
    native = true;
    const seen: Array<Record<string, string>> = [];
    const registration = await registerPush(ACCOUNT, (data) => seen.push(data));
    expect(register).toHaveBeenCalled();
    nativeListeners.get('registration')?.({ value: 'native-token' });
    nativeListeners.get('pushNotificationReceived')?.({ data: { kind: 'chat' } });
    expect(savePushToken).toHaveBeenCalledWith(ACCOUNT, 'native-token');
    expect(seen).toEqual([{ kind: 'chat' }]);
    if (registration.status === 'registered') registration.stop();
    expect(removeRegistration).toHaveBeenCalled();
    expect(removeReceived).toHaveBeenCalled();
  });
});
