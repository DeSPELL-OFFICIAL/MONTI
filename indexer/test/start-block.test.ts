import { describe, expect, it } from 'vitest';
// @ts-ignore -- .mjs 빌드 스크립트라 tsc 선언이 없다; vitest 런타임에선 그대로 동작한다.
import { computeStartBlock } from '../scripts/start-block.mjs';

/**
 * start_block 규칙(scripts/start-block.mjs)을 못 박는다.
 *
 * 규칙: 이전 배포 중 현재 배포와 주소를 하나라도 공유하는(= 유지된 계약) 항목만
 * 시작 블록을 그 배포 블록까지 되돌린다. 전면 재배포는 자기 블록에서 시작한다.
 */
describe('computeStartBlock', () => {
  it('full redeploy (no shared address) starts at the current block', () => {
    const { startBlock, kept } = computeStartBlock({
      block: 66724502,
      identity: '0x10Fa9977363c40240381BEEfFc2D997BC9Edcd6b',
      organizers: '0xAF80CbfDD08284E3aae67FFaaf20A27E281C360A',
      ticket: '0x7E1fdfCB3688C5b0539101cEAE6a7Ee5bD9b51Cf',
      previous: [
        {
          identity: '0x3EfdbdbD2d8CaFf096bB68401ed464c2d4A3f034',
          organizers: '0xD778024aa11D8890A5D4aB0cfeb19789Dd988022',
          ticket: '0x86550c0408A9Bb6da1766b0ed4e57b3ec914A671',
          block: 66449700,
        },
        { ticket: '0x4B8353C9F3503Cdbd011E8f35da0a955D95b1367', block: 64921775 },
      ],
    });
    expect(startBlock).toBe(66724502);
    expect(kept).toEqual([]);
  });

  it('partial redeploy keeping Identity looks back to that kept entry', () => {
    // Identity 만 유지(주소 동일, 대소문자만 다름). Organizers·Ticket 은 새 주소.
    const keptIdentity = '0x10Fa9977363c40240381BEEfFc2D997BC9Edcd6b';
    const { startBlock, kept } = computeStartBlock({
      block: 66724502,
      identity: keptIdentity,
      organizers: '0xAF80CbfDD08284E3aae67FFaaf20A27E281C360A',
      ticket: '0x7E1fdfCB3688C5b0539101cEAE6a7Ee5bD9b51Cf',
      previous: [
        // 유지된 Identity(대소문자만 다름) → 이 항목의 블록까지 되돌린다.
        {
          identity: keptIdentity.toLowerCase(),
          organizers: '0xD778024aa11D8890A5D4aB0cfeb19789Dd988022',
          ticket: '0x86550c0408A9Bb6da1766b0ed4e57b3ec914A671',
          block: 66449700,
        },
        // 공유 주소 없음 → 무시된다(이 블록으로는 안 내려간다).
        { ticket: '0x4B8353C9F3503Cdbd011E8f35da0a955D95b1367', block: 64921775 },
      ],
    });
    expect(startBlock).toBe(66449700);
    expect(kept).toHaveLength(1);
    expect(kept[0].block).toBe(66449700);
  });

  it('no previous deployments starts at the current block', () => {
    const { startBlock, kept } = computeStartBlock({
      block: 66724502,
      identity: '0x10Fa9977363c40240381BEEfFc2D997BC9Edcd6b',
      organizers: '0xAF80CbfDD08284E3aae67FFaaf20A27E281C360A',
      ticket: '0x7E1fdfCB3688C5b0539101cEAE6a7Ee5bD9b51Cf',
    });
    expect(startBlock).toBe(66724502);
    expect(kept).toEqual([]);
  });
});
