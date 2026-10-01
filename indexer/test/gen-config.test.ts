import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 생성기가 SettlementVault 를 **배포 유/무에 맞춰** 다루는지 못 박는다.
 *  - 배포 파일에 `settlementVault` 키가 없으면(오늘) 금고를 깨끗이 건너뛰고도 유효한 config 를 낸다.
 *  - 키가 들어오면 금고 컨트랙트를 더하고, 자기 배포 블록(`settlementVaultBlock`)을 컨트랙트
 *    start_block 으로 단다(없으면 코어 `block` 으로 안전하게 폴백). 네트워크 start_block 은 코어 그대로.
 *
 * 배포 파일은 DEPLOYMENT_FILE 로 먹인다(생성기가 지원). ABI·이벤트 시그니처는 커밋된
 * packages/shared(코어)와 src/vendored/settlement-vault-abi.json(금고)에서 실제로 읽는다.
 */
const genConfig = join(process.cwd(), 'scripts', 'gen-config.mjs');

const CORE = {
  block: 66724502,
  chainId: 10143,
  identity: '0x10Fa9977363c40240381BEEfFc2D997BC9Edcd6b',
  organizers: '0xAF80CbfDD08284E3aae67FFaaf20A27E281C360A',
  ticket: '0x7E1fdfCB3688C5b0539101cEAE6a7Ee5bD9b51Cf',
  previous: [] as unknown[],
};
const VAULT = '0xA84FDb64C9DDc3B25eF8BDeA58561BDbE53ABD69';

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

describe('gen-config SettlementVault', () => {
  it('produces a valid config that skips the vault when the key is absent', () => {
    const { status, stdout, config } = gen(CORE);
    expect(status).toBe(0);
    expect(config).toContain('name: Identity');
    expect(config).toContain('name: Ticket');
    expect(config).not.toContain('name: SettlementVault');
    expect(config).toContain('start_block: 66724502');
    expect(stdout).toContain('SettlementVault 미배포');
  });

  it('includes the vault with its deploy block as the contract start_block when present', () => {
    const { status, config } = gen({ ...CORE, settlementVault: VAULT, settlementVaultBlock: 67253867 });
    expect(status).toBe(0);
    expect(config).toContain('name: SettlementVault');
    expect(config).toContain(`"${VAULT}"`);
    for (const ev of VAULT_EVENTS) expect(config).toContain(`- event: ${ev}(`);
    // 일시정지 토글은 버린다.
    expect(config).not.toContain('- event: PausedSet(');
    // 네트워크 start_block 은 코어(66724502), 금고 컨트랙트는 자기 배포 블록(67253867).
    expect(config).toContain('    start_block: 66724502');
    expect(config).toContain('        start_block: 67253867');
  });

  it('falls back to the core block when the vault is present but no deploy block is recorded', () => {
    const { status, config } = gen({ ...CORE, settlementVault: VAULT });
    expect(status).toBe(0);
    expect(config).toContain('name: SettlementVault');
    expect(config).toContain('        start_block: 66724502');
  });
});
