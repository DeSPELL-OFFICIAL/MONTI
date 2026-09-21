import { describe, expect, it } from 'vitest';
import { offerDigest } from './encoding.js';
import type { Hex } from './types.js';

describe('offerDigest', () => {
  // contracts/test/TicketOffer.t.sol 의 test_theFixedVectorSharedWithTheTypescriptHalf 이
  // 같은 세 값에 대해 같은 상수를 단언한다. 한쪽만 바뀌면 그쪽이 빨개진다.
  const DOMAIN = { chainId: 31337, ticket: '0x7111111111111111111111111111111111111111' as Hex };
  const ARGS = {
    ...DOMAIN,
    tokenId: 7n,
    recipientCommitment: ('0x' + '11'.repeat(32)) as Hex,
    recipientAccount: '0x0000000000000000000000000000000000000001' as Hex,
  };

  it('matches the fixed vector the attester signs for acceptOffer', () => {
    expect(offerDigest(ARGS)).toBe('0x7171ab3831d8e0d4a58ce6d8076a10c080c5a97849229aecf84c801dcafbc88d');
  });

  it('changes when the chain changes', () => {
    expect(offerDigest(ARGS)).not.toBe(offerDigest({ ...ARGS, chainId: 10143 }));
  });

  it('changes when the verifying contract changes', () => {
    expect(offerDigest(ARGS)).not.toBe(
      offerDigest({ ...ARGS, ticket: '0x000000000000000000000000000000000000dEaD' as Hex }),
    );
  });

  it('changes when the recipient account changes', () => {
    expect(offerDigest(ARGS)).not.toBe(
      offerDigest({ ...ARGS, recipientAccount: '0x0000000000000000000000000000000000000002' as Hex }),
    );
  });

  it('changes when the token or the commitment changes', () => {
    expect(offerDigest(ARGS)).not.toBe(offerDigest({ ...ARGS, tokenId: 8n }));
    expect(offerDigest(ARGS)).not.toBe(
      offerDigest({ ...ARGS, recipientCommitment: ('0x' + '22'.repeat(32)) as Hex }),
    );
  });

  it('rejects a malformed commitment, account or ticket address', () => {
    expect(() => offerDigest({ ...ARGS, recipientCommitment: '0x11' as Hex })).toThrow('BAD_COMMITMENT');
    expect(() => offerDigest({ ...ARGS, recipientAccount: '0x01' as Hex })).toThrow('BAD_ACCOUNT');
    expect(() => offerDigest({ ...ARGS, ticket: '0x01' as Hex })).toThrow('BAD_TICKET');
  });
});
