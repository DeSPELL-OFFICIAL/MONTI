import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { KeyManagementServiceClient } from '@google-cloud/kms';
import type { Hex } from '@monti/shared';

export interface KmsCryptoClient {
  encrypt(req: { name: string; plaintext: Buffer }): Promise<[{ ciphertext: Uint8Array | string | null }]>;
  decrypt(req: { name: string; ciphertext: Buffer }): Promise<[{ plaintext: Uint8Array | string | null }]>;
}

const ENVELOPE_VERSION = 0x01;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const DEK_BYTES = 32;

let cached: KeyManagementServiceClient | undefined;

function defaultClient(): KmsCryptoClient {
  if (!cached) cached = new KeyManagementServiceClient();
  return cached as unknown as KmsCryptoClient;
}

function projectId(): string {
  const id = process.env.GCP_PROJECT_ID ?? process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT;
  if (!id) throw new Error('NO_GCP_PROJECT');
  return id;
}

export function piiKeyName(): string {
  const location = process.env.KMS_LOCATION ?? 'us-east1';
  const keyRing = process.env.KMS_KEY_RING ?? 'monti';
  return `projects/${projectId()}/locations/${location}/keyRings/${keyRing}/cryptoKeys/pii`;
}

export function attesterKeyName(version = '1'): string {
  const location = process.env.KMS_LOCATION ?? 'us-east1';
  const keyRing = process.env.KMS_KEY_RING ?? 'monti';
  return `projects/${projectId()}/locations/${location}/keyRings/${keyRing}/cryptoKeys/attester/cryptoKeyVersions/${version}`;
}

/**
 * 개인정보 봉투를 묶는 AAD. `personId:field` 하나로 고정한다(Task 12 결정).
 * 봉투를 다른 사람 문서나 다른 필드로 옮겨 붙이면 GCM 태그 검증이 깨진다.
 * AAD 자체는 봉투에 저장하지 않는다 — 읽는 쪽이 같은 값을 다시 만들어 와야 한다.
 */
export function piiAad(personId: Hex, field: string): string {
  return `${personId}:${field}`;
}

function toBuffer(value: Uint8Array | string | null): Buffer {
  if (value === null) throw new Error('KMS_EMPTY_RESPONSE');
  return typeof value === 'string' ? Buffer.from(value, 'base64') : Buffer.from(value);
}

/**
 * 평문 → base64 봉투. DEK는 매번 새로 만들고 KMS는 DEK만 감싼다.
 * `aad`(보통 `piiAad(personId, field)`)는 봉투에 저장되지 않고 태그에만 묶인다.
 */
export async function encryptField(
  plaintext: string,
  aad = '',
  client: KmsCryptoClient = defaultClient(),
): Promise<string> {
  const dek = randomBytes(DEK_BYTES);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', dek, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  const [wrapResponse] = await client.encrypt({ name: piiKeyName(), plaintext: dek });
  const wrapped = toBuffer(wrapResponse.ciphertext);
  if (wrapped.length > 0xffff) throw new Error('WRAPPED_DEK_TOO_LARGE');

  const header = Buffer.alloc(3);
  header[0] = ENVELOPE_VERSION;
  header.writeUInt16BE(wrapped.length, 1);
  return Buffer.concat([header, wrapped, iv, tag, body]).toString('base64');
}

/** 봉투를 만들 때 쓴 것과 **같은** `aad` 를 줘야 한다. 다르면 태그 검증에서 터진다. */
export async function decryptField(
  envelope: string,
  aad = '',
  client: KmsCryptoClient = defaultClient(),
): Promise<string> {
  const bytes = Buffer.from(envelope, 'base64');
  if (bytes.length < 3 + IV_BYTES + TAG_BYTES) throw new Error('BAD_ENVELOPE');
  if (bytes[0] !== ENVELOPE_VERSION) throw new Error('BAD_ENVELOPE_VERSION');

  const wrappedLength = bytes.readUInt16BE(1);
  let offset = 3;
  const wrapped = bytes.subarray(offset, offset + wrappedLength);
  offset += wrappedLength;
  const iv = bytes.subarray(offset, offset + IV_BYTES);
  offset += IV_BYTES;
  const tag = bytes.subarray(offset, offset + TAG_BYTES);
  offset += TAG_BYTES;
  const body = bytes.subarray(offset);

  const [unwrapResponse] = await client.decrypt({ name: piiKeyName(), ciphertext: Buffer.from(wrapped) });
  const dek = toBuffer(unwrapResponse.plaintext);

  const decipher = createDecipheriv('aes-256-gcm', dek, iv);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}
