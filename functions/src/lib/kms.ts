import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { KeyManagementServiceClient } from '@google-cloud/kms';

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
  const location = process.env.KMS_LOCATION ?? 'asia-northeast3';
  const keyRing = process.env.KMS_KEY_RING ?? 'monti';
  return `projects/${projectId()}/locations/${location}/keyRings/${keyRing}/cryptoKeys/pii`;
}

export function attesterKeyName(version = '1'): string {
  const location = process.env.KMS_LOCATION ?? 'asia-northeast3';
  const keyRing = process.env.KMS_KEY_RING ?? 'monti';
  return `projects/${projectId()}/locations/${location}/keyRings/${keyRing}/cryptoKeys/attester/cryptoKeyVersions/${version}`;
}

function toBuffer(value: Uint8Array | string | null): Buffer {
  if (value === null) throw new Error('KMS_EMPTY_RESPONSE');
  return typeof value === 'string' ? Buffer.from(value, 'base64') : Buffer.from(value);
}

/** 평문 → base64 봉투. DEK는 매번 새로 만들고 KMS는 DEK만 감싼다. */
export async function encryptField(plaintext: string, client: KmsCryptoClient = defaultClient()): Promise<string> {
  const dek = randomBytes(DEK_BYTES);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', dek, iv);
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

export async function decryptField(envelope: string, client: KmsCryptoClient = defaultClient()): Promise<string> {
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
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}
