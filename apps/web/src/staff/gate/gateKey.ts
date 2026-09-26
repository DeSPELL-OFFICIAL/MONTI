import { gateCodeHash } from '@monti/shared';
import type { GateCodeDigestInput, Hex } from '@monti/shared';

import { ensureDeviceKey, signWithDeviceKey } from '../../shared/deviceKey';
import type { DeviceKeyPublic } from '../../shared/deviceKey';
import { GATE_KEY_ALIAS } from '../constants';

/**
 * The gate key's public half. Same shape the device-key module reports, `backing` included:
 * a StrongBox request that landed in the TEE has to stay visible all the way to whoever
 * registers the key, so it is carried rather than dropped here.
 */
export type GatePublicKey = DeviceKeyPublic;

/**
 * 게이트 키는 관객 기기 키와 다르다.
 *  - 생체 인증을 요구하지 않는다. 3초마다 서명해야 하고 스태프가 그때마다 지문을 댈 수는 없다.
 *    `requireAuth: false` 는 Kotlin 쪽 `setUserAuthenticationRequired(false)` 가 된다.
 *  - StrongBox 를 먼저 시도하고 없으면 TEE 로 떨어진다(Global Constraints 의 기기 키 항목).
 *  - 단말기를 도난당해도 게이트 계정은 관리자가 allowlist 에서 빼면 즉시 무력화된다(T14).
 *
 * 별칭 하나뿐이므로 앱을 다시 켜도 같은 키를 찾아 쓴다. `ensureDeviceKey` 가 먼저 별칭을
 * 조회하고, "이 별칭에 키가 없다"는 대답에만 새로 만든다 — 이미 `Organizers.registerGate`
 * 로 체인에 올라간 키를 갈아 끼우는 건 되돌릴 수 없다.
 */
export async function ensureGateKey(): Promise<GatePublicKey> {
  return ensureDeviceKey({ alias: GATE_KEY_ALIAS, requireAuth: false, strongBox: true });
}

/**
 * The 64-byte uncompressed public key, `x ‖ y`, with no SEC1 `0x04` tag — the bytes
 * `Organizers.registerGate` stores and the attendee reads back out of `gateInfo`. A verifier
 * that wants a SEC1 point (WebCrypto's `raw` import, @noble/curves) puts the `0x04` back on.
 */
export function gatePublicKeyUncompressed(key: GatePublicKey): Hex {
  return `0x${key.x.slice(2)}${key.y.slice(2)}`;
}

/**
 * The same 64 bytes as the two `bytes32` arguments of
 * `Organizers.registerGate(uint256 eventId, address gateAccount, bytes32 kx, bytes32 ky)`.
 * `kx` and `ky` are indistinguishable at that call site, and a registration with them swapped
 * verifies nothing and cannot be corrected — so the mapping is written down once, here.
 */
export function gateKeyCoordinates(key: GatePublicKey): { kx: Hex; ky: Hex } {
  return { kx: key.x, ky: key.y };
}

/**
 * Signs the 32-byte digest RAW — the chip must not hash it again — and hands back `r, s` with
 * `s` already normalised into the low half (the device-key module does it; Solady's
 * `P256.verifySignature` rejects the high half).
 */
export async function signWithGateKey(digest: Hex): Promise<{ r: Hex; s: Hex }> {
  return signWithDeviceKey(digest, { alias: GATE_KEY_ALIAS });
}

/**
 * The only way a gate code becomes a signature. The digest is `sha256(gateCodePreimage(...))`
 * straight out of `@monti/shared`, and it has to be: the attendee verifies with WebCrypto
 * `ECDSA`/`SHA-256`, which is handed the preimage and hashes it internally. Two spellings of
 * those bytes and every tap fails, silently and at the door — so there is only ever one.
 */
export async function signGateCode(input: GateCodeDigestInput): Promise<{ r: Hex; s: Hex }> {
  return signWithGateKey(gateCodeHash(input));
}
