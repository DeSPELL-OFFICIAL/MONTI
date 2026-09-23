/**
 * DEK 를 'W' 한 바이트로 감싸는 가짜 KMS. 봉투 암호화 자체는 진짜 코드가 돈다.
 *
 * `vi.mock` 팩토리는 호이스팅되어 모듈 스코프를 못 잡으므로 이 모듈을 통째로 돌려준다 —
 * 그래서 내보내는 이름은 `@google-cloud/kms` 가 실제로 쓰이는 이름 하나로 맞춘다.
 */
export class KeyManagementServiceClient {
  async encrypt({ plaintext }: { plaintext: Buffer }): Promise<[{ ciphertext: Buffer }]> {
    return [{ ciphertext: Buffer.concat([Buffer.from('W'), Buffer.from(plaintext)]) }];
  }

  async decrypt({ ciphertext }: { ciphertext: Buffer }): Promise<[{ plaintext: Buffer }]> {
    const buf = Buffer.from(ciphertext);
    if (buf[0] !== 'W'.charCodeAt(0)) throw new Error('FAKE_KMS_BAD_WRAP');
    return [{ plaintext: buf.subarray(1) }];
  }
}
