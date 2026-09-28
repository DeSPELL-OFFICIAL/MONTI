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
 *
 * 기대값은 손으로 적은 상수가 아니라 **배포 파일에서 읽는다**(../src/vendored/deployment.json,
 * config.yaml 과 같은 원본). 그래서 다음 재배포 때 이 테스트가 저절로 따라오고, 주소·블록을
 * 여기서 손으로 고칠 일이 없다.
 *
 * `start_block` 은 특히 되돌릴 수 없다 — 호스티드 인덱서는 이어받지 말고 **처음부터
 * 다시** 돌려야 새 컨트랙트의 로그를 본다.
 */
describe('config.yaml pins the current deployment', () => {
  it('starts at the earliest block and watches the current contracts', async () => {
    const config = await readFile(join(process.cwd(), 'config.yaml'), 'utf8');

    // 현재 배포의 세 계약 주소는 config 에 반드시 있어야 한다.
    expect(config).toContain(`"${deployment.identity}"`);
    expect(config).toContain(`"${deployment.organizers}"`);
    expect(config).toContain(`"${deployment.ticket}"`);

    // 은퇴한 Ticket 주소가 어디든 남아 있으면 인덱서는 그 계약을 스캔하다 조용히 0건을
    // 낸다. previous[] 의 어떤 Ticket 주소도 config 에 없어야 한다.
    for (const past of deployment.previous) {
      expect(config).not.toContain(past.ticket);
    }

    // start_block 은 손으로 적은 상수가 아니라 규칙의 산물이다: 현재 블록과 previous[].block
    // 중 **가장 이른** 값(scripts/gen-config.mjs). 계약을 유지하는 재배포는 옛 배포 블록부터
    // 그 계약들의 과거 이벤트를 다시 봐야 하므로 이전 블록이 이긴다.
    const earliest = Math.min(deployment.block, ...deployment.previous.map((p) => p.block));
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
