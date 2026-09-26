import { HCE_ERROR, type Base64 } from './definitions';

/**
 * Standard base64 and nothing else: the `+/` alphabet, a length that is a multiple of four,
 * and the padding still on. A base64url `-`/`_`, a dropped `=`, and MIME's 76-column line
 * breaks all fail here. Anchored at both ends with no `m` flag, so `$` is strict end of
 * input and a trailing newline is a rejection rather than a silently trimmed character.
 */
const STANDARD_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** The code doubles as the message, so an unhandled throw still names it. */
function invalidArgument(): Error {
  return Object.assign(new Error(HCE_ERROR.invalidArgument), { code: HCE_ERROR.invalidArgument });
}

/**
 * The bridge spelling of a byte string, defined once in `definitions.ts`. Built on
 * `btoa`/`atob`, which are standard-alphabet, padded and unwrapped by definition, so the
 * same code runs in the WebView and in Node 22 and neither needs `Buffer`.
 */
export function toBase64(bytes: Uint8Array): Base64 {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i] as number);
  return btoa(binary);
}

/** Rejects every other spelling rather than repair it — a repaired payload hides the bug. */
export function fromBase64(text: Base64): Uint8Array {
  if (typeof text !== 'string' || !STANDARD_BASE64.test(text)) throw invalidArgument();
  let binary: string;
  try {
    binary = atob(text);
  } catch {
    throw invalidArgument();
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}
