import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

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
