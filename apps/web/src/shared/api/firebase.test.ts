import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const existingApps: unknown[] = [];
const initializeApp = vi.fn();
const getAuth = vi.fn();
const getFirestore = vi.fn();
const getFunctions = vi.fn();
const connectAuthEmulator = vi.fn();
const connectFirestoreEmulator = vi.fn();
const connectFunctionsEmulator = vi.fn();

vi.mock('firebase/app', () => ({ getApps: () => existingApps, initializeApp }));
vi.mock('firebase/auth', () => ({ getAuth, connectAuthEmulator }));
vi.mock('firebase/firestore', () => ({ getFirestore, connectFirestoreEmulator }));
vi.mock('firebase/functions', () => ({ getFunctions, connectFunctionsEmulator }));

const ENV = {
  VITE_FIREBASE_API_KEY: 'test-api-key',
  VITE_FIREBASE_PROJECT_ID: 'mon-ti',
  VITE_FIREBASE_STORAGE_BUCKET: 'mon-ti.firebasestorage.app',
  VITE_FIREBASE_SENDER_ID: '595285023599',
  VITE_FIREBASE_APP_ID: '1:595285023599:web:abc',
};

/** Every accessor memoises, so each test needs a fresh module graph. */
async function load(): Promise<typeof import('./firebase')> {
  vi.resetModules();
  return import('./firebase');
}

beforeEach(() => {
  existingApps.length = 0;
  initializeApp.mockImplementation((options: unknown) => ({ options }));
  getAuth.mockImplementation((app: unknown) => ({ app }));
  getFirestore.mockImplementation((app: unknown) => ({ app }));
  getFunctions.mockImplementation((app: unknown, region: string) => ({ app, region }));
  for (const [key, value] of Object.entries(ENV)) vi.stubEnv(key, value);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('getFirebaseApp', () => {
  it('initialises exactly one app and reuses it', async () => {
    const { getFirebaseApp, getDb, getFirebaseAuth } = await load();
    const app = getFirebaseApp();
    expect(getFirebaseApp()).toBe(app);
    getDb();
    getFirebaseAuth();
    expect(initializeApp).toHaveBeenCalledTimes(1);
  });

  it('adopts an app someone else already initialised', async () => {
    const already = { name: '[DEFAULT]' };
    existingApps.push(already);
    const { getFirebaseApp } = await load();
    expect(getFirebaseApp()).toBe(already);
    expect(initializeApp).not.toHaveBeenCalled();
  });

  it('reads the bucket from its own variable instead of deriving an appspot.com host', async () => {
    const { getFirebaseApp } = await load();
    getFirebaseApp();
    expect(initializeApp).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'test-api-key',
        projectId: 'mon-ti',
        authDomain: 'mon-ti.firebaseapp.com',
        storageBucket: 'mon-ti.firebasestorage.app',
        messagingSenderId: '595285023599',
        appId: '1:595285023599:web:abc',
      }),
    );
  });

  it('names the missing variable rather than initialising a half-configured app', async () => {
    vi.stubEnv('VITE_FIREBASE_API_KEY', '');
    const { getFirebaseApp } = await load();
    expect(() => getFirebaseApp()).toThrow('VITE_FIREBASE_API_KEY');
  });
});

describe('getFirebaseFunctions', () => {
  it('binds callables to the v2 backend region (us-east4) when the env names none, once', async () => {
    // A developer's .env.local may still name the v1 region; the default must not depend on it.
    vi.stubEnv('VITE_FUNCTIONS_REGION', '');
    const { getFirebaseFunctions, DEFAULT_FUNCTIONS_REGION } = await load();
    expect(DEFAULT_FUNCTIONS_REGION).toBe('us-east4');
    expect(getFirebaseFunctions()).toMatchObject({ region: 'us-east4' });
    getFirebaseFunctions();
    expect(getFunctions).toHaveBeenCalledTimes(1);
  });

  it('follows the region to wherever VITE_FUNCTIONS_REGION points', async () => {
    vi.stubEnv('VITE_FUNCTIONS_REGION', 'asia-northeast3');
    const { getFirebaseFunctions } = await load();
    expect(getFirebaseFunctions()).toMatchObject({ region: 'asia-northeast3' });
  });
});

describe('emulators', () => {
  it('stay off unless VITE_USE_EMULATORS is 1', async () => {
    const { getDb, getFirebaseAuth, getFirebaseFunctions } = await load();
    getDb();
    getFirebaseAuth();
    getFirebaseFunctions();
    expect(connectFirestoreEmulator).not.toHaveBeenCalled();
    expect(connectAuthEmulator).not.toHaveBeenCalled();
    expect(connectFunctionsEmulator).not.toHaveBeenCalled();
  });

  it('connects each emulator once on the ports firebase.json declares', async () => {
    vi.stubEnv('VITE_USE_EMULATORS', '1');
    const { getDb, getFirebaseAuth, getFirebaseFunctions } = await load();
    getDb();
    getDb();
    getFirebaseAuth();
    getFirebaseFunctions();
    expect(connectFirestoreEmulator).toHaveBeenCalledTimes(1);
    expect(connectFirestoreEmulator).toHaveBeenCalledWith(expect.anything(), '127.0.0.1', 8089);
    expect(connectFunctionsEmulator).toHaveBeenCalledWith(expect.anything(), '127.0.0.1', 5001);
    expect(connectAuthEmulator).toHaveBeenCalledWith(expect.anything(), 'http://127.0.0.1:9099', { disableWarnings: true });
  });
});
