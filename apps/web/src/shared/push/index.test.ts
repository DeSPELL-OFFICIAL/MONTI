import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Hex } from '@monti/shared';

let native = false;
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => native } }));

const requestPermissions = vi.fn();
const register = vi.fn();
const addListener = vi.fn();
const removeListener = vi.fn();
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

/** The plugin emits `registration` only after `register()`, so a native call is driven, not awaited. */
async function emitNative(event: string, payload: unknown): Promise<void> {
  await vi.waitFor(() => expect(nativeListeners.has(event)).toBe(true));
  nativeListeners.get(event)?.(payload);
}

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
    return { remove: () => removeListener(event) };
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

  it('answers a refused token write with a reason rather than rejecting', async () => {
    // The rules deny the write until Functions has created devices/{account}; a token nobody
    // can reach is not a registration.
    savePushToken.mockRejectedValue(new Error('permission-denied'));
    await expect(registerPush(ACCOUNT, () => undefined)).resolves.toEqual({
      status: 'unavailable',
      reason: PUSH_UNAVAILABLE.tokenSaveFailed,
    });
    expect(onMessage).not.toHaveBeenCalled();
  });
});

describe('registerPush on native', () => {
  beforeEach(() => {
    native = true;
  });

  it('stops at a denied permission without registering', async () => {
    requestPermissions.mockResolvedValue({ receive: 'denied' });
    await expect(registerPush(ACCOUNT, () => undefined)).resolves.toEqual({
      status: 'unavailable',
      reason: PUSH_UNAVAILABLE.permissionDenied,
    });
    expect(register).not.toHaveBeenCalled();
  });

  it('saves the token the plugin reports and removes every listener on stop()', async () => {
    const seen: Array<Record<string, string>> = [];
    const pending = registerPush(ACCOUNT, (data) => seen.push(data));
    await emitNative('registration', { value: 'native-token' });
    const registration = await pending;
    expect(register).toHaveBeenCalled();
    expect(savePushToken).toHaveBeenCalledWith(ACCOUNT, 'native-token');
    expect(registration.status).toBe('registered');
    nativeListeners.get('pushNotificationReceived')?.({ data: { kind: 'chat' } });
    expect(seen).toEqual([{ kind: 'chat' }]);
    if (registration.status === 'registered') registration.stop();
    expect(removeListener.mock.calls.flat().sort()).toEqual([
      'pushNotificationReceived', 'registration', 'registrationError',
    ]);
  });

  it('writes a rotated token without a second registerPush', async () => {
    const pending = registerPush(ACCOUNT, () => undefined);
    await emitNative('registration', { value: 'native-token' });
    await pending;
    nativeListeners.get('registration')?.({ value: 'rotated-token' });
    await vi.waitFor(() => expect(savePushToken).toHaveBeenCalledWith(ACCOUNT, 'rotated-token'));
  });

  it('turns a plugin registration error into a typed reason', async () => {
    const pending = registerPush(ACCOUNT, () => undefined);
    await emitNative('registrationError', { error: 'APNs said no' });
    await expect(pending).resolves.toEqual({
      status: 'unavailable',
      reason: PUSH_UNAVAILABLE.registrationFailed,
    });
    expect(savePushToken).not.toHaveBeenCalled();
  });

  it('answers a refused token write with a reason rather than rejecting', async () => {
    savePushToken.mockRejectedValue(new Error('permission-denied'));
    const pending = registerPush(ACCOUNT, () => undefined);
    await emitNative('registration', { value: 'native-token' });
    await expect(pending).resolves.toEqual({
      status: 'unavailable',
      reason: PUSH_UNAVAILABLE.tokenSaveFailed,
    });
  });
});
