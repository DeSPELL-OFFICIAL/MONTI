import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 생성기가 v2 배포 파일(`{chainId, block, identity, forwarder, organizers, ticket, settlementVault, usdc,
 * attester}`, 금고가 코어와 같은 블록)을 다루는 모양을 못 박는다.
 *  - 금고는 필수다(v2 는 한 번에 배포) — 키가 없으면 크게 실패한다.
 *  - 컨트랙트별 start_block 은 없다. 네트워크 start_block = `block` 하나.
 *  - v2 에서 삭제된 이벤트(NicknameSet, EventMetaUpdated, OverrideRequested)는 구독하지 않는다.
 *
 * 배포 파일은 DEPLOYMENT_FILE 로 먹인다(생성기가 지원). ABI·이벤트 시그니처는 커밋된
 * packages/shared(코어)와 src/vendored/settlement-vault-abi.json(금고)에서 실제로 읽는다.
 */
const genConfig = join(process.cwd(), 'scripts', 'gen-config.mjs');

const V2 = {
  chainId: 10143,
  block: 70000000,
  identity: '0x1000000000000000000000000000000000000001',
  forwarder: '0x1000000000000000000000000000000000000002',
  organizers: '0x1000000000000000000000000000000000000003',
  ticket: '0x1000000000000000000000000000000000000004',
  settlementVault: '0x1000000000000000000000000000000000000005',
  usdc: '0x534b2f3A21130d7a60830c2Df862319e593943A3',
  attester: '0x6af898aA4d99375839d7069431A7019a6D84C4Ed',
};

function gen(deployment: Record<string, unknown>): { status: number; stdout: string; config: string } {
  const dir = mkdtempSync(join(tmpdir(), 'gen-config-test-'));
  const depPath = join(dir, 'dep.json');
  writeFileSync(depPath, JSON.stringify(deployment));
  const run = spawnSync(process.execPath, [genConfig], {
    env: { ...process.env, GEN_OUT_DIR: dir, DEPLOYMENT_FILE: depPath, RPC_URL: '' },
    encoding: 'utf8',
  });
  const config = run.status === 0 ? readFileSync(join(dir, 'config.yaml'), 'utf8') : '';
  return { status: run.status ?? 1, stdout: `${run.stdout}${run.stderr}`, config };
}

const VAULT_EVENTS = [
  'PolicySet', 'Deposited', 'Released', 'NoShowSettled', 'Refunded',
  'Paid', 'PayoutDeferred', 'Withdrawn', 'TokenAllowed', 'DepositorSet',
];

describe('gen-config v2', () => {
  it('watches the five-key v2 deployment with the vault in the same start block', () => {
    const { status, config } = gen(V2);
    expect(status).toBe(0);
    expect(config).toContain('name: SettlementVault');
    expect(config).toContain(`"${V2.settlementVault}"`);
    for (const ev of VAULT_EVENTS) expect(config).toContain(`- event: ${ev}(`);
    expect(config).not.toContain('- event: PausedSet(');
    expect(config).toContain('    start_block: 70000000');
    // 컨트랙트별 start_block 은 더 이상 없다(금고가 코어와 같은 배포).
    expect(config).not.toMatch(/^ {8}start_block:/m);
  });

  it('drops the events v2 removed from the contracts', () => {
    const { config } = gen(V2);
    for (const gone of ['NicknameSet', 'EventMetaUpdated', 'OverrideRequested']) {
      expect(config).not.toContain(`- event: ${gone}(`);
    }
    // 같은 tx 에 GateRegistered → GateOpened 가 함께 온다(등록 즉시 개장) — 둘 다 구독.
    expect(config).toContain('- event: GateRegistered(');
    expect(config).toContain('- event: GateOpened(');
  });

  it('fails loudly when the vault key is missing (v2 deploys it with the core)', () => {
    const { settlementVault: _omit, ...core } = V2;
    const { status, stdout } = gen(core);
    expect(status).not.toBe(0);
    expect(stdout).toContain('"settlementVault" 키가 없다');
  });
});
