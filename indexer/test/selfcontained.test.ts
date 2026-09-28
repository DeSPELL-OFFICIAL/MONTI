import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// config.yaml 과 **같은 배포 파일**에서 나온 복제본이다(scripts/gen-config.mjs 생성물).
import { deployment } from '../src/vendored/deployment.json';

/**
 * 드리프트 가드를 테스트 경로에도 물려 둔다. `pnpm indexer:check` 를 따로 기억하지
 * 않아도 `pnpm test` 한 번이면 커밋된 생성물이 어긋났는지 알게 된다.
 *
 * 무엇을 보는지는 `scripts/check-selfcontained.mjs` 의 머리 주석에 있다.
 */
describe('indexer/ is self-contained', () => {
  it('passes scripts/check-selfcontained.mjs', () => {
    const run = spawnSync(
      process.execPath,
      [join(process.cwd(), 'scripts', 'check-selfcontained.mjs')],
      { encoding: 'utf8', env: { ...process.env, RPC_URL: '' } },
    );
    expect(`${run.stdout}${run.stderr}`.trim()).toContain('ok');
    expect(run.status).toBe(0);
  }, 30_000);
});

/**
 * 생성물이 **어느 배포**를 가리키는지 못 박는다. 드리프트 검사(위)는 커밋된 것과 다시
 * 뽑은 것이 같은지만 보므로, 배포 파일이 통째로 옛것이면 둘 다 옛것이라 통과한다.
 * 01c 재배포(commit c97887a: 새 Ticket·paymaster, Identity/Organizers 는 유지)의 숫자를
 * 여기 적어 두고, 다음 재배포 때 이 한 줄을 같이 고치게 한다.
 *
 * `start_block` 은 특히 되돌릴 수 없다 — 호스티드 인덱서는 이어받지 말고 **처음부터
 * 다시** 돌려야 새 컨트랙트의 로그를 본다.
 */
describe('config.yaml pins the current deployment', () => {
  it('starts at the earliest block and watches the 01c contracts', async () => {
    const config = await readFile(join(process.cwd(), 'config.yaml'), 'utf8');
    expect(config).toContain('start_block: 64921775');
    expect(config).toContain('"0x40D90AF3a3B22542AEeF0ec3E6a66F1EAb6f7AFA"'); // Ticket (01c)
    expect(config).toContain('"0x961a895b47Cf200C14acf38F5689979FF5bd8133"'); // Identity (유지)
    expect(config).toContain('"0xa88C8D110Ca8f0c925A781AB8042bA012d7281F0"'); // Organizers (유지)
    // 은퇴한 01b Ticket 주소가 어디든 남아 있으면 인덱서는 그 계약을 스캔하다 조용히
    // 0건을 낸다. 그 주소가 config 어디에도 없어야 한다.
    expect(config).not.toContain('0x4B8353C9F3503Cdbd011E8f35da0a955D95b1367');

    // start_block 은 손으로 적은 상수가 아니라 규칙의 산물이다: 현재 블록과 previous[].block
    // 중 **가장 이른** 값(scripts/gen-config.mjs). Identity/Organizers 를 유지하는 01c 는
    // 옛 배포 블록부터 그 계약들의 과거 이벤트를 다시 봐야 하므로 previous[0].block 이 이긴다.
    const previousBlocks = deployment.previous.map((p) => p.block);
    const earliest = Math.min(deployment.block, ...previousBlocks);
    expect(earliest).toBe(64921775);
    expect(earliest).toBeLessThan(deployment.block); // 현재 블록이 아니라 이전 블록이 이긴다
    expect(config).toContain(`start_block: ${earliest}`);

    // 배포 파일에 있는 셋 말고는 아무 주소도 감시하지 않는다 — 다음 재배포 때 이 테스트가
    // 저절로 따라온다.
    const watched = [...config.matchAll(/^ {10}- "(0x[0-9a-fA-F]{40})"$/gm)].map((m) => m[1]);
    expect(watched).toEqual([deployment.identity, deployment.organizers, deployment.ticket]);
  });

  // 01b 가 더한 두 이벤트는 더 이상 "ABI 대기"가 아니다 — 실제로 구독해야 한다.
  it('subscribes the 01b events instead of skipping them', async () => {
    const config = await readFile(join(process.cwd(), 'config.yaml'), 'utf8');
    expect(config).toContain(
      '- event: CheckedInLate(uint256 indexed tokenId, uint256 indexed gateId, uint64 issuedAt, uint64 ts)',
    );
    expect(config).toContain(
      '- event: RotationCancelled(bytes32 indexed personId, address indexed account)',
    );
  });
});
