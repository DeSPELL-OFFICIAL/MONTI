import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const schemaPath = join(process.cwd(), 'schema.graphql');

describe('schema.graphql', () => {
  it('declares every master-plan entity', async () => {
    const schema = await readFile(schemaPath, 'utf8');
    for (const entity of [
      'Organizer', 'Admin', 'Manager', 'Gate', 'Event', 'Tier',
      'Ticket', 'CheckIn', 'Override', 'IdentityAccount', 'Offer',
    ]) {
      expect(schema).toMatch(new RegExp(`type ${entity}\\b`));
    }
  });

  it('carries the delta fields', async () => {
    const schema = await readFile(schemaPath, 'utf8');
    expect(schema).toContain('nickname: String');
    expect(schema).toContain('category: Int!');
    expect(schema).toContain('regionCode: String!');
    expect(schema).toContain('status: String!');
    expect(schema).toContain('requireKyc: Boolean!');
    expect(schema).toContain('kycLevel: Int!');
  });

  // 01b 번들이 채우는 열. 2026-09-23 재배포로 `CheckedInLate` 가 실제로 오므로
  // 더 이상 늘 false 인 예약 열이 아니다.
  it('carries the fields the 01b bundle fills', async () => {
    const schema = await readFile(schemaPath, 'utf8');
    expect(schema).toContain('late: Boolean!');
  });

  // `open` 은 Envio codegen 이 EE210 으로 거절하는 예약어다(ReScript 키워드).
  // 컨트랙트 뷰 `isOpenGate` 와 이름을 맞춘다.
  it('uses no Envio reserved keyword as a field name', async () => {
    const schema = await readFile(schemaPath, 'utf8');
    expect(schema).toContain('isOpen: Boolean!');
    expect(schema).not.toMatch(/^\s+open:/m);
  });

  it('contains no personal data field', async () => {
    // 주석까지 포함해 통째로 검사한다. 주석에도 phone/email 같은 낱말을 쓰지 않는다.
    const schema = await readFile(schemaPath, 'utf8');
    for (const banned of ['phone', 'email', 'photo', 'firstname', 'lastname', 'documentnumber', 'personname']) {
      expect(schema.toLowerCase(), `schema mentions "${banned}"`).not.toContain(banned);
    }
  });
});
