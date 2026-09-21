import { hashTypedData } from 'viem';
import type { Hex } from './types.js';

/**
 * 이 브랜치(계약 저장소)의 packages/shared 는 **컨트랙트에 묶인 절반만** 들고 있다.
 * MONTI-backend·MONTI-web·MONTI-staff 의 packages/shared/src/encoding.ts 에는 CBOR·QR·DER 같은
 * 나머지 인코딩도 함께 있으며, 아래 offerDigest 는 그 세 곳과 **글자 그대로 같아야 한다.**
 */

function assertBytes32(value: Hex, label: string): void {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(label);
}

/**
 * 어테스터가 acceptOffer 용으로 서명하는 다이제스트.
 * EIP-712 다. 도메인이 chainId 와 Ticket 주소를 묶으므로, 테스트넷 서명은 메인넷에서,
 * 옛 배포본의 서명은 새 배포본에서 쓸 수 없다. Ticket.offerDigest(...) 와 같은 값이어야 한다.
 */
export function offerDigest(input: {
  chainId: number;
  ticket: Hex;
  tokenId: bigint;
  recipientCommitment: Hex;
  recipientAccount: Hex;
}): Hex {
  assertBytes32(input.recipientCommitment, 'BAD_COMMITMENT');
  if (!/^0x[0-9a-fA-F]{40}$/.test(input.recipientAccount)) throw new Error('BAD_ACCOUNT');
  if (!/^0x[0-9a-fA-F]{40}$/.test(input.ticket)) throw new Error('BAD_TICKET');
  return hashTypedData({
    domain: {
      name: 'MONTI Ticket',
      version: '1',
      chainId: input.chainId,
      verifyingContract: input.ticket,
    },
    types: {
      TransferApproval: [
        { name: 'tokenId', type: 'uint256' },
        { name: 'recipientCommitment', type: 'bytes32' },
        { name: 'recipient', type: 'address' },
      ],
    },
    primaryType: 'TransferApproval',
    message: {
      tokenId: input.tokenId,
      recipientCommitment: input.recipientCommitment,
      recipient: input.recipientAccount,
    },
  });
}
