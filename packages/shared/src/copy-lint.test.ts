import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanFolder, scanText } from './copy-lint.js';

describe('scanText', () => {
  it('flags Korean banned words anywhere in the line', () => {
    const hits = scanText('a.tsx', '<p>지갑을 연결해 주세요</p>');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ file: 'a.tsx', line: 1, word: '지갑' });
  });

  it('flags English banned words on word boundaries only', () => {
    expect(scanText('a.tsx', 'Pay the gas fee')).toHaveLength(1);
    expect(scanText('a.tsx', 'const gasLimit = withGasMargin(estimate)')).toHaveLength(0);
    expect(scanText('a.tsx', 'const tokenId = ticket.tokenId')).toHaveLength(0);
    expect(scanText('a.tsx', 'const chainId = 10143')).toHaveLength(0);
  });

  it('is case insensitive', () => {
    expect(scanText('a.tsx', 'Your WALLET is ready')).toHaveLength(1);
    expect(scanText('a.tsx', 'Minted on Monad')).toHaveLength(1);
  });

  it('reports the 1-based line and column', () => {
    const hits = scanText('a.tsx', 'line one\n  <p>NFT</p>');
    expect(hits[0]).toMatchObject({ line: 2, column: 6, word: 'NFT' });
  });

  it('skips lines marked copy-lint-ignore', () => {
    expect(scanText('a.tsx', '<p>블록체인 없음</p> // copy-lint-ignore')).toHaveLength(0);
  });

  it('finds every banned word on one line', () => {
    const hits = scanText('a.tsx', '지갑에서 토큰을 민팅합니다');
    expect(hits.map((h) => h.word).sort()).toEqual(['민팅', '지갑', '토큰']);
  });
});

describe('scanFolder', () => {
  it('walks nested folders and only the given extensions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'monti-copy-'));
    await mkdir(join(root, 'nested'), { recursive: true });
    await writeFile(join(root, 'clean.tsx'), '<p>입장하기</p>', 'utf8');
    await writeFile(join(root, 'nested', 'dirty.tsx'), '<p>가스비는 무료입니다</p>', 'utf8');
    await writeFile(join(root, 'ignored.md'), '지갑', 'utf8');

    const hits = await scanFolder(root);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.word).toBe('가스');
    expect(hits[0]!.file.endsWith('dirty.tsx')).toBe(true);
  });

  it('scans only user-visible copy: string/template literals and JSX text', async () => {
    const root = await mkdtemp(join(tmpdir(), 'monti-copy-vis-'));
    await writeFile(
      join(root, 'view.tsx'),
      [
        "import { WalletIcon } from './wallet-icons';", // import specifier -> skipped
        'const tokenId = ticket.tokenId;', // identifier -> not scanned
        'const banner = `Pay the gas fee`;', // template literal -> hit (gas)
        'export function View() {',
        '  return (',
        '    <section>',
        '      <p>지갑을 연결하세요</p>', // JSX text -> hit (지갑)
        '      <span>Connect your wallet</span>', // JSX text -> hit (wallet)
        '    </section>',
        '  );',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );

    const hits = await scanFolder(root);
    expect(hits.map((h) => h.word).sort()).toEqual(['gas', 'wallet', '지갑']);
    // none of the identifier / import-specifier occurrences leak through
    expect(hits.some((h) => h.word === 'wallet' && h.line === 1)).toBe(false);
  });

  it('skips import specifiers, dynamic import() and vi.mock() calls', async () => {
    const root = await mkdtemp(join(tmpdir(), 'monti-copy-skip-'));
    await writeFile(
      join(root, 'wiring.tsx'),
      [
        "import { gasHelper } from './gas-service';",
        "vi.mock('./token-store');",
        "const mod = import('./chain-loader');",
        '',
      ].join('\n'),
      'utf8',
    );

    const hits = await scanFolder(root);
    expect(hits).toHaveLength(0);
  });

  /**
   * `staff` 와 `organizer` 는 한때 나란히 건너뛰는 폴더였다. 게이트 화면을 관객이 스태프 어깨
   * 너머로 같이 읽고, 주최자 화면의 정산·수수료 안내도 평범한 말로 옮길 수 있었으므로(스펙 §3.2,
   * 창업자 규칙: 주최자도 web3 용어를 보지 않는다) 두 면제가 모두 걷혔다 — 두 폴더가 다시 조용히
   * 건너뛰어지면 그 화면들의 금지어가 CI를 통과하므로, 둘 다 훑는다는 사실 자체에 테스트를 건다.
   */
  it('walks both staff and organizer folders', async () => {
    const root = await mkdtemp(join(tmpdir(), 'monti-copy-dirs-'));
    await mkdir(join(root, 'staff'), { recursive: true });
    await mkdir(join(root, 'organizer'), { recursive: true });
    await writeFile(join(root, 'staff', 'deny.tsx'), '<p>토큰을 확인하세요</p>', 'utf8');
    await writeFile(join(root, 'organizer', 'payout.tsx'), '<p>토큰을 확인하세요</p>', 'utf8');

    const hits = await scanFolder(root);
    expect(hits).toHaveLength(2);
    expect(hits.some((hit) => hit.file.includes('staff'))).toBe(true);
    expect(hits.some((hit) => hit.file.includes('organizer'))).toBe(true);
  });

  it('ignores *.test.* files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'monti-copy-test-'));
    await writeFile(join(root, 'a.test.tsx'), '<p>가스</p>', 'utf8');
    const hits = await scanFolder(root);
    expect(hits).toHaveLength(0);
  });

  it('honours copy-lint-ignore inside files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'monti-copy-ign-'));
    await writeFile(join(root, 'b.tsx'), '<p>지갑 연결</p> // copy-lint-ignore', 'utf8');
    const hits = await scanFolder(root);
    expect(hits).toHaveLength(0);
  });
});
