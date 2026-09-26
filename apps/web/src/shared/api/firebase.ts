import { getApps, initializeApp, type FirebaseApp, type FirebaseOptions } from 'firebase/app';
import { connectAuthEmulator, getAuth, type Auth } from 'firebase/auth';
import { connectFirestoreEmulator, getFirestore, type Firestore } from 'firebase/firestore';
import { connectFunctionsEmulator, getFunctions, type Functions } from 'firebase/functions';
import { optionalEnv, requiredEnv } from '../config';

/**
 * Every Firebase SDK instance the web app uses is created here, exactly once. Nothing else
 * calls `initializeApp`, `getFunctions` or `connectXEmulator`: a second app or a second
 * emulator connection on the same instance is a runtime throw, not a warning.
 */

/**
 * The region sub-plan 02 deploys callables to. The SDK default (us-central1) would 404, and
 * the region has moved once already, so it is environment-driven with the current value as
 * the default rather than a constant compiled into every call site.
 */
export const DEFAULT_FUNCTIONS_REGION = 'us-east1';

export function getFunctionsRegion(): string {
  return optionalEnv('VITE_FUNCTIONS_REGION') ?? DEFAULT_FUNCTIONS_REGION;
}

/** Ports come from firebase.json. `localhost` resolves to ::1 on some hosts, so pin IPv4. */
const EMULATOR_HOST = '127.0.0.1';
const EMULATOR_PORT = { auth: 9099, firestore: 8089, functions: 5001 } as const;

function useEmulators(): boolean {
  return optionalEnv('VITE_USE_EMULATORS') === '1';
}

function firebaseOptions(): FirebaseOptions {
  const projectId = requiredEnv('VITE_FIREBASE_PROJECT_ID');
  return {
    apiKey: requiredEnv('VITE_FIREBASE_API_KEY'),
    authDomain: `${projectId}.firebaseapp.com`,
    projectId,
    // Projects created after late 2024 get a firebasestorage.app bucket, so it is read
    // rather than derived from the project id.
    storageBucket: requiredEnv('VITE_FIREBASE_STORAGE_BUCKET'),
    messagingSenderId: requiredEnv('VITE_FIREBASE_SENDER_ID'),
    appId: requiredEnv('VITE_FIREBASE_APP_ID'),
  };
}

let app: FirebaseApp | null = null;
let auth: Auth | null = null;
let db: Firestore | null = null;
let functions: Functions | null = null;

export function getFirebaseApp(): FirebaseApp {
  if (app) return app;
  app = getApps()[0] ?? initializeApp(firebaseOptions());
  return app;
}

export function getFirebaseAuth(): Auth {
  if (auth) return auth;
  auth = getAuth(getFirebaseApp());
  if (useEmulators()) {
    connectAuthEmulator(auth, `http://${EMULATOR_HOST}:${EMULATOR_PORT.auth}`, { disableWarnings: true });
  }
  return auth;
}

export function getDb(): Firestore {
  if (db) return db;
  db = getFirestore(getFirebaseApp());
  if (useEmulators()) connectFirestoreEmulator(db, EMULATOR_HOST, EMULATOR_PORT.firestore);
  return db;
}

export function getFirebaseFunctions(): Functions {
  if (functions) return functions;
  functions = getFunctions(getFirebaseApp(), getFunctionsRegion());
  if (useEmulators()) connectFunctionsEmulator(functions, EMULATOR_HOST, EMULATOR_PORT.functions);
  return functions;
}
