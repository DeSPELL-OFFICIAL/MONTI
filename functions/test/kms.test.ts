import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Hex } from '@monti/shared';
import { decryptField, encryptField, piiAad, piiKeyName, type KmsCryptoClient } from '../src/lib/kms.js';
import { KeyManagementServiceClient } from './helpers/fakeKms.js';

// 모듈을 가로채지 않고 같은 가짜를 인자로 직접 넣는다 — 여긴 봉투 로직만 보면 된다.
const fakeKms: KmsCryptoClient = new KeyManagementServiceClient();

// piiKeyName()은 encryptField/decryptField가 매 호출 참조하므로 프로젝트 ID가 필요하다.
let savedProject: string | undefined;
beforeAll(() => {
  savedProject = process.env.GCP_PROJECT_ID;
  process.env.GCP_PROJECT_ID = 'monti-dev';
});
afterAll(() => {
  if (savedProject === undefined) delete process.env.GCP_PROJECT_ID;
  else process.env.GCP_PROJECT_ID = savedProject;
});

describe('envelope encryption', () => {
  it('round-trips a Korean name', async () => {
    const envelope = await encryptField('홍길동', '', fakeKms);
    expect(await decryptField(envelope, '', fakeKms)).toBe('홍길동');
  });

  it('round-trips a 300 KB photo payload', async () => {
    const photo = 'A'.repeat(300 * 1024);
    const envelope = await encryptField(photo, '', fakeKms);
    expect(await decryptField(envelope, '', fakeKms)).toBe(photo);
  });

  it('never leaks the plaintext into the envelope', async () => {
    const envelope = await encryptField('010-1234-5678', '', fakeKms);
    expect(Buffer.from(envelope, 'base64').toString('latin1')).not.toContain('010-1234-5678');
  });

  it('uses a fresh DEK and IV every call', async () => {
    const a = await encryptField('same', '', fakeKms);
    const b = await encryptField('same', '', fakeKms);
    expect(a).not.toBe(b);
  });

  it('rejects a tampered ciphertext', async () => {
    const envelope = await encryptField('홍길동', '', fakeKms);
    const bytes = Buffer.from(envelope, 'base64');
    bytes[bytes.length - 1]! ^= 0xff;
    await expect(decryptField(bytes.toString('base64'), '', fakeKms)).rejects.toThrow();
  });

  it('rejects an unknown envelope version', async () => {
    const bytes = Buffer.from(await encryptField('x', '', fakeKms), 'base64');
    bytes[0] = 0x02;
    await expect(decryptField(bytes.toString('base64'), '', fakeKms)).rejects.toThrow('BAD_ENVELOPE_VERSION');
  });
});

describe('AAD binding', () => {
  const personId: Hex = '0xabc';

  it('round-trips a field bound to personId:field', async () => {
    const aad = piiAad(personId, 'phoneE164');
    const envelope = await encryptField('+821011112222', aad, fakeKms);
    expect(await decryptField(envelope, aad, fakeKms)).toBe('+821011112222');
  });

  it('refuses to decrypt under a different personId', async () => {
    const envelope = await encryptField('+821011112222', piiAad(personId, 'phoneE164'), fakeKms);
    await expect(
      decryptField(envelope, piiAad('0xdef', 'phoneE164'), fakeKms),
    ).rejects.toThrow();
  });

  it('refuses to decrypt the same person under a different field', async () => {
    const envelope = await encryptField('+821011112222', piiAad(personId, 'phoneE164'), fakeKms);
    await expect(decryptField(envelope, piiAad(personId, 'enc.name'), fakeKms)).rejects.toThrow();
  });

  it('refuses to decrypt a bound envelope with no AAD at all', async () => {
    const envelope = await encryptField('+821011112222', piiAad(personId, 'phoneE164'), fakeKms);
    await expect(decryptField(envelope, '', fakeKms)).rejects.toThrow();
  });

  it('keeps the envelope size unchanged by the AAD — the AAD is never stored', async () => {
    const bare = await encryptField('same-length', '', fakeKms);
    const bound = await encryptField('same-length', piiAad(personId, 'phoneE164'), fakeKms);
    expect(Buffer.from(bound, 'base64').length).toBe(Buffer.from(bare, 'base64').length);
  });

  it('builds the AAD as personId:field', () => {
    expect(piiAad('0x01', 'phoneE164')).toBe('0x01:phoneE164');
  });
});

describe('key name construction', () => {
  it('builds the pii key resource name from GCP_PROJECT_ID / asia-northeast3 / monti / pii', () => {
    expect(piiKeyName()).toBe(
      'projects/monti-dev/locations/us-east1/keyRings/monti/cryptoKeys/pii',
    );
  });
});
