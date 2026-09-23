// The browser's device key. A phone has a secure element (native.ts); a browser has WebCrypto,
// so the key is a non-extractable P-256 key pair held by the browser and referenced through an
// IndexedDB handle. `extractable: false` means the private key never becomes bytes — not to
// this code, not to a script on the page — but it is still software, synced by nothing and
// bound to nothing. That is the trade the B decision made so that a browser signup can call
// `registerIdentity` and become `active` instead of sitting at `pending` forever.
//
// What this key is NOT: proof that a particular device is at the door. Entry stays native-only
// (see `armDeviceKeyWeb` below), so nothing here is ever offered to a gate.
import { splitRs, type Hex } from '@monti/shared';
import { toLowS } from './lowS';
import { spkiToXy } from './spki';
import { DeviceKeyUnavailable, type DeviceKeyPublic } from './types';

const DB_NAME = 'monti-device-key';
const DB_VERSION = 1;
/** One store. The record key is the alias, so an attendee key and a gate key never collide. */
const STORE = 'keys';

const ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGN_PARAMS = { name: 'ECDSA', hash: 'SHA-256' } as const;

/**
 * Everything a private window takes away arrives here as some other exception — a SecurityError
 * from `indexedDB.open`, an `undefined` `crypto.subtle` on an insecure origin, a quota refusal.
 * The screens branch on exactly one thing (`DeviceKeyUnavailable`), so every failure below is
 * folded into it rather than leaking a browser-specific name into a call site.
 */
function unavailable(): never {
  throw new DeviceKeyUnavailable();
}

function subtle(): SubtleCrypto {
  const api = globalThis.crypto?.subtle;
  return api ?? unavailable();
}

function factory(): IDBFactory {
  const api = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  return api ?? unavailable();
}

function settle<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

async function openDb(): Promise<IDBDatabase> {
  const request = factory().open(DB_NAME, DB_VERSION);
  request.onupgradeneeded = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
  };
  return settle(request);
}

async function readKey(alias: string): Promise<CryptoKeyPair | undefined> {
  const db = await openDb();
  try {
    const store = db.transaction(STORE, 'readonly').objectStore(STORE);
    return await settle(store.get(alias) as IDBRequest<CryptoKeyPair | undefined>);
  } finally {
    db.close();
  }
}

async function writeKey(alias: string, pair: CryptoKeyPair): Promise<void> {
  const db = await openDb();
  try {
    const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
    await settle(store.put(pair, alias));
  } finally {
    db.close();
  }
}

/** A CryptoKeyPair survives structured clone; anything else in the store is not one of ours. */
function isKeyPair(value: unknown): value is CryptoKeyPair {
  if (typeof value !== 'object' || value === null) return false;
  const { privateKey, publicKey } = value as Partial<CryptoKeyPair>;
  return typeof privateKey === 'object' && privateKey !== null && typeof publicKey === 'object' && publicKey !== null;
}

/**
 * Two screens mounting at once must not mint two keys and register the second over the first,
 * so the whole read-or-create is serialised per alias for the life of the page.
 */
const inFlight = new Map<string, Promise<CryptoKeyPair>>();

async function loadOrCreate(alias: string): Promise<CryptoKeyPair> {
  const stored = await readKey(alias);
  if (isKeyPair(stored)) return stored;
  // `extractable: false` is the whole point: the private key cannot be read back out, so a
  // script that gets onto the page can ask for a signature but cannot take the key with it.
  // Usages are `['sign']` — the private half signs, and nothing here ever verifies with it.
  const pair = (await subtle().generateKey(ALGORITHM, false, ['sign'])) as CryptoKeyPair;
  await writeKey(alias, pair);
  return pair;
}

function keyPair(alias: string): Promise<CryptoKeyPair> {
  const pending = inFlight.get(alias);
  if (pending) return pending;
  const started = loadOrCreate(alias).catch((cause) => {
    // A failure must not be remembered: a person who allows site data on the second try gets a
    // key, and a cached rejection would tell them forever that the browser cannot make one.
    inFlight.delete(alias);
    throw cause;
  });
  inFlight.set(alias, started);
  return started;
}

/**
 * The browser's device key, created once and returned unchanged afterwards. The public half is
 * exported as SubjectPublicKeyInfo and parsed by the same `spkiToXy` the secure element's key
 * goes through, so what `registerIdentity` puts on chain has one shape and one parser.
 *
 * `backing` is deliberately absent — the type's contract is "never assume hardware from
 * silence", and software is exactly what this is.
 */
export async function ensureDeviceKeyWeb(options: { alias: string }): Promise<DeviceKeyPublic> {
  try {
    const { publicKey } = await keyPair(options.alias);
    return spkiToXy(new Uint8Array(await subtle().exportKey('spki', publicKey)));
  } catch (cause) {
    if (cause instanceof DeviceKeyUnavailable) throw cause;
    throw new DeviceKeyUnavailable();
  }
}

/**
 * Entry is native-only, and this throw is what enforces it.
 *
 * A software key has no biometric window to open, so there is nothing for this to do — but
 * returning "armed" would be worse than useless. `nfcCapability()` answers `webnfc` on Android
 * Chrome, so an arm that succeeded would send a browser into a real tap, and the signature it
 * produced would be rejected on chain (see `signWithDeviceKeyWeb`). The gate screen already
 * reads this rejection as "show the person what to do instead", which is the honest answer.
 */
export async function armDeviceKeyWeb(): Promise<never> {
  throw new DeviceKeyUnavailable();
}

/**
 * Signs with the browser's device key and returns what the secure element returns: `{ r, s }`,
 * each 32 bytes, `s` normalised into the low half.
 *
 * One difference, and it is load-bearing: WebCrypto's ECDSA hashes the message it is given, so
 * this signature verifies over `SHA-256(digest)` while `Ticket.checkIn` recomputes `digest` and
 * verifies over that. The chain would therefore refuse it — which is why nothing offers it a
 * gate digest: `armDeviceKeyWeb` throws before the entry flow ever reaches a signer. Making
 * browser entry work is not a change here but at the call site: `deviceSigDigest` is SHA-256 of
 * `deviceSigMessage` (buildResponse.ts), so a signer handed the *preimage* would produce a
 * chain-valid signature. That is a product decision, not a detail — entry stays native-only.
 */
export async function signWithDeviceKeyWeb(digest: Hex, options: { alias: string }): Promise<{ r: Hex; s: Hex }> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(digest)) throw new Error('BAD_DIGEST');
  try {
    const { privateKey } = await keyPair(options.alias);
    const message = Uint8Array.from((digest.slice(2).match(/../g) ?? []).map((byte) => Number.parseInt(byte, 16)));
    const raw = new Uint8Array(await subtle().sign(SIGN_PARAMS, privateKey, message));
    // WebCrypto answers with raw r || s, always 64 bytes — no DER unwrapping, unlike native.
    const { r, s } = splitRs(rawToHex(raw));
    return { r, s: toLowS(s) };
  } catch (cause) {
    if (cause instanceof DeviceKeyUnavailable) throw cause;
    throw new DeviceKeyUnavailable();
  }
}

function rawToHex(bytes: Uint8Array): Hex {
  let out = '0x';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out as Hex;
}
