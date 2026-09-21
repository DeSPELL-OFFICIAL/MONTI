// The gate terminal's local PIN. It is set once, at setup, and it never leaves the device: no
// server is told it, nothing on chain records it, and this file holds only a salted hash.
//
// It is worth being precise about what it defends, because it is not the chain's authority.
// Whether an override is allowed at all is `Organizers`' answer, read fresh every time
// (`route.ts`), and no PIN can change that. What the PIN defends is the moment **before** that
// read: a staff phone is unlocked, lying on a table behind a counter, and its owner is looking
// at a queue. Anybody who picks it up is already signed in as that staff member. The PIN is the
// one thing between that phone and a door it can open by hand.
//
// So the parameters are the parameters of a four-digit secret, not of a password:
//
//  * **PBKDF2-SHA-256 at 210,000 iterations** (OWASP's 2023 figure for this construction), with
//    a fresh 16-byte salt per PIN. Four digits is 10,000 guesses, which even at this cost is
//    only a few minutes for someone who has copied the row out of IndexedDB — so the hash is the
//    second line of defence, and its real job is that a PIN reused across two terminals does not
//    read as the same value on both.
//  * **Five tries, then sixty seconds**, counted **on disk**. This is the first line. It turns
//    the same 10,000 guesses into roughly 33 hours of standing at the terminal, which outlasts
//    any event, and putting the counter in the same row as the hash means killing the app does
//    not reset it — an in-memory counter would be defeated by swiping the app away.
//
// The lockout refuses the **right** PIN too. A lockout that let the correct one through would be
// no lockout at all: the attacker's last guess is a correct one by definition.
import { PIN_LOCKOUT_MS, PIN_MAX_ATTEMPTS, PIN_MIN_LENGTH, PIN_PBKDF2_ITERATIONS, PIN_SALT_BYTES } from '../constants';
import { staffDb } from '../snapshot/store';

/**
 * The single row, in the `settings` store the snapshot database already declares (`keyPath:
 * 'key'`). It is a row rather than a store of its own because there is exactly one PIN per
 * terminal and `staffDb()` creates every store in one version — a second store would mean a
 * schema version bump, and a version bump at a door is an upgrade that can block on an open
 * connection while somebody is standing in front of the phone.
 *
 * `failures` and `lockedUntil` ride in the same row on purpose: they are as much the secret's
 * state as the hash is, and a lockout somewhere else is a lockout that can be cleared alone.
 */
export interface StoredPin {
  key: 'pin';
  /** 16 bytes, hex. New on every {@link setPin}. */
  salt: string;
  /** PBKDF2-SHA-256, 256 bits, hex. */
  hash: string;
  /** Wrong tries since the last correct one. Reset by a correct PIN and by a new PIN. */
  failures: number;
  /** `Date.now()` this PIN opens again, or `0`. */
  lockedUntil: number;
}

/**
 * What one attempt answers. `WRONG` carries the tries left because a staff member who cannot see
 * the count coming is a staff member who gets locked out mid-queue with no warning, and `LOCKED`
 * carries the wait because "try again later" is not something anyone can act on.
 */
export type PinVerdict =
  | { ok: true }
  | { ok: false; reason: 'UNSET' }
  | { ok: false; reason: 'WRONG'; triesLeft: number }
  | { ok: false; reason: 'LOCKED'; retryInMs: number };

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** `Uint8Array<ArrayBuffer>` rather than a bare one, which is what WebCrypto's `BufferSource` is. */
function unhex(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from((value.match(/../g) ?? []).map((pair) => Number.parseInt(pair, 16)));
}

async function derive(pin: string, saltHex: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: unhex(saltHex), iterations: PIN_PBKDF2_ITERATIONS, hash: 'SHA-256' },
    key,
    256,
  );
  return hex(bits);
}

/**
 * Constant-time equality over the two hex digests. The timing channel here is thin — both sides
 * are already the output of 210,000 iterations — but the comparison is free to write correctly
 * and a short-circuiting `===` is the kind of thing that gets copied somewhere it matters.
 */
function equals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function readRow(): Promise<StoredPin | undefined> {
  return (await (await staffDb()).get('settings', 'pin')) as StoredPin | undefined;
}

async function writeRow(row: StoredPin): Promise<void> {
  await (await staffDb()).put('settings', row);
}

/** Whether this terminal has a PIN at all. The setup screen will not hand off to a door without one. */
export async function hasPin(): Promise<boolean> {
  return (await readRow()) !== undefined;
}

/**
 * Sets (or replaces) the terminal's PIN, and clears whatever the old one's lockout was doing.
 *
 * The length guard is here and not only in the field, because the field is one caller and this
 * is the rule. Four digits is the floor the lockout above was sized for.
 */
export async function setPin(pin: string): Promise<void> {
  if (pin.length < PIN_MIN_LENGTH) throw new Error('PIN_TOO_SHORT');
  const salt = hex(crypto.getRandomValues(new Uint8Array(PIN_SALT_BYTES)).buffer);
  await writeRow({ key: 'pin', salt, hash: await derive(pin, salt), failures: 0, lockedUntil: 0 });
}

/**
 * One attempt, with the lockout applied and updated.
 *
 * `now` is a parameter for the same reason `snapshotAgeMs` takes one — it is the only way to
 * test a sixty-second window without a sixty-second test — and never for the caller to move.
 */
/**
 * Attempts, one at a time.
 *
 * `checkPin` is a read-modify-write across two `await`s, and the caller is a button a person
 * presses with a queue watching — a double press races two attempts through the same read and
 * one failure is simply lost. Two lost failures in a row is a five-try lockout that takes seven,
 * which is the whole defence leaking. There is no transaction to hold across `deriveBits`, so
 * the attempts are serialised on a promise chain instead: cheap, and the only contention is a
 * person's thumb.
 */
let queue: Promise<unknown> = Promise.resolve();

export async function checkPin(pin: string, now: number = Date.now()): Promise<PinVerdict> {
  const run = queue.then(() => attempt(pin, now));
  // The chain must not break on a rejection, or every later attempt inherits it.
  queue = run.catch(() => undefined);
  return run;
}

async function attempt(pin: string, now: number): Promise<PinVerdict> {
  const row = await readRow();
  if (!row) return { ok: false, reason: 'UNSET' };

  if (row.lockedUntil > now) return { ok: false, reason: 'LOCKED', retryInMs: row.lockedUntil - now };

  // A lockout that has expired takes its failures with it, and it does so **here** rather than
  // only on a correct PIN. Otherwise `failures` stays at the cap for ever and every single wrong
  // try from then on re-locks for a full minute with no countdown — the staff member is never
  // told they have four tries again, because they never do.
  const served = row.lockedUntil === 0 ? row : { ...row, failures: 0, lockedUntil: 0 };

  if (equals(await derive(pin, served.salt), served.hash)) {
    if (served.failures !== 0 || row.lockedUntil !== 0) {
      await writeRow({ ...served, failures: 0, lockedUntil: 0 });
    }
    return { ok: true };
  }

  const failures = served.failures + 1;
  if (failures >= PIN_MAX_ATTEMPTS) {
    await writeRow({ ...served, failures, lockedUntil: now + PIN_LOCKOUT_MS });
    return { ok: false, reason: 'LOCKED', retryInMs: PIN_LOCKOUT_MS };
  }
  await writeRow({ ...served, failures, lockedUntil: 0 });
  return { ok: false, reason: 'WRONG', triesLeft: PIN_MAX_ATTEMPTS - failures };
}

/** {@link checkPin} without the reason, for a caller that only needs the gate to open or not. */
export async function verifyPin(pin: string, now?: number): Promise<boolean> {
  return (await checkPin(pin, now)).ok;
}
