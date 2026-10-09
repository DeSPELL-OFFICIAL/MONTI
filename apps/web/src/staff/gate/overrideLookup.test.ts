import { beforeEach, describe, expect, it, vi } from 'vitest';

// 체인 읽기만 가짜로 둔다. 명단(스냅샷)은 이 길에 끼지 않는다 — 동기 검색이 비어 돌아온 뒤에만
// 불리는, 표 번호 하나를 체인에 묻는 함수다. 합성 행의 생김새(SnapshotTicket)도 함께 못 박힌다.
const eventOf = vi.fn();
const isRevoked = vi.fn();
vi.mock('../../shared/chain/reads', () => ({ readTicket: () => ({ eventOf, isRevoked }) }));

const { resolveTicketOnChain } = await import('./overrideLookup');

beforeEach(() => {
  eventOf.mockReset().mockResolvedValue(7n);
  isRevoked.mockReset().mockResolvedValue(false);
});

describe('resolveTicketOnChain', () => {
  it('builds one synthetic row for a ticket number that is on the chain for this event', async () => {
    const row = await resolveTicketOnChain('42', 7n);
    expect(eventOf).toHaveBeenCalledWith(42n);
    expect(row).toEqual({
      tokenId: '42',
      account: `0x${'00'.repeat(20)}`,
      deviceX: `0x${'00'.repeat(32)}`,
      deviceY: `0x${'00'.repeat(32)}`,
      photoJpegB64: '',
      displayName: '',
      tier: 0,
      tierName: '',
      seat: '',
      checkedIn: false,
    });
  });

  it('is empty when the number belongs to another event', async () => {
    eventOf.mockResolvedValue(9n);
    expect(await resolveTicketOnChain('42', 7n)).toBeUndefined();
  });

  it('is empty for a revoked ticket', async () => {
    isRevoked.mockResolvedValue(true);
    expect(await resolveTicketOnChain('42', 7n)).toBeUndefined();
  });

  it('never asks the chain for a query that is not a bare number', async () => {
    expect(await resolveTicketOnChain('abc', 7n)).toBeUndefined();
    expect(eventOf).not.toHaveBeenCalled();
  });

  it('is empty when the read fails (a number that was never minted reverts)', async () => {
    eventOf.mockRejectedValue(new Error('execution reverted'));
    expect(await resolveTicketOnChain('42', 7n)).toBeUndefined();
  });
});
