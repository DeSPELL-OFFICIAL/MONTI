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

  it('contains no personal data field', async () => {
    // 주석까지 포함해 통째로 검사한다. 주석에도 phone/email 같은 낱말을 쓰지 않는다.
    const schema = await readFile(schemaPath, 'utf8');
    for (const banned of ['phone', 'email', 'photo', 'firstname', 'lastname', 'documentnumber', 'personname']) {
      expect(schema.toLowerCase(), `schema mentions "${banned}"`).not.toContain(banned);
    }
  });
});
