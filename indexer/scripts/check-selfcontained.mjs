/**
 * `indexer/` 가 **혼자 서 있는지** 검사한다. `pnpm indexer:check` (루트) 또는
 * `pnpm check` (indexer 안)로 돌린다. 실패하면 0 이 아닌 코드로 끝난다.
 *
 * Envio 호스티드 서비스는 저장소에서 루트 디렉터리 `indexer/` 하나만 가져다
 * 거기서 `pnpm install` 을 돌린다(모노레포라면 "ensure all your imports are contained
 * within your indexer directory"). 그래서 워크스페이스 밖을 가리키는 import 나
 * `workspace:` 의존성이 하나라도 남으면 **배포에서만** 깨진다 — 로컬은 멀쩡하다.
 * 그 사고를 커밋 전에 잡는 것이 이 스크립트다.
 *
 * 검사 셋:
 *  1. `scripts/gen-config.mjs` 를 임시 디렉터리에 다시 돌려, 커밋된 `config.yaml` 과
 *     `src/vendored/*.json` 이 생성물과 **바이트까지** 같은지 본다. 01b 재배포 뒤에
 *     `pnpm indexer:config` 를 잊고 푸시하면 여기서 걸린다.
 *  2. `src/` 의 모든 파일이 `indexer/` 안쪽 또는 npm 패키지만 가리키는지 본다.
 *     `../..` 로 워크스페이스를 거슬러 올라가거나 `@monti/*` 를 쓰면 실패다.
 *  3. `package.json` 에 `workspace:` 의존성이 없는지 본다.
 */
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const indexerRoot = join(here, '..');
const failures = [];

// ────────────────────────── 1. 생성물 드리프트 ──────────────────────────

const GENERATED = ['config.yaml', join('src', 'vendored', 'ticket-abi.json'),
  join('src', 'vendored', 'deployment.json'), join('src', 'vendored', 'event-status.json')];

const tmp = await mkdtemp(join(tmpdir(), 'monti-indexer-check-'));
try {
  // RPC_URL 은 비워서 돌린다. 커밋되는 config.yaml 은 HyperSync 판이라, 셸에
  // RPC_URL 이 떠 있으면 아무 잘못 없이 실패해 버린다.
  const run = spawnSync(process.execPath, [join(here, 'gen-config.mjs')], {
    env: { ...process.env, GEN_OUT_DIR: tmp, RPC_URL: '' },
    encoding: 'utf8',
  });
  if (run.status !== 0) {
    failures.push(`생성기가 실패했다(exit ${run.status}):\n${run.stderr || run.stdout}`);
  } else {
    for (const name of GENERATED) {
      const [fresh, committed] = await Promise.all([
        readFile(join(tmp, name), 'utf8').catch(() => null),
        readFile(join(indexerRoot, name), 'utf8').catch(() => null),
      ]);
      if (fresh === null) {
        failures.push(`생성기가 ${name} 을 내지 않았다.`);
      } else if (committed === null) {
        failures.push(`커밋된 ${name} 이 없다 — \`pnpm indexer:config\` 를 돌리고 커밋하세요.`);
      } else if (fresh !== committed) {
        failures.push(
          `${name} 이 생성물과 다르다 — \`pnpm indexer:config\` 를 돌리고 커밋하세요.`,
        );
      }
    }
    // 커밋된 vendored 에만 있는 파일: 생성기가 더는 내지 않는 잔해다.
    const vendored = join(indexerRoot, 'src', 'vendored');
    const expected = new Set(
      GENERATED.filter((name) => name.startsWith(`src${sep}vendored`)).map((name) =>
        name.slice(`src${sep}vendored${sep}`.length),
      ),
    );
    for (const entry of await readdir(vendored).catch(() => [])) {
      if (!expected.has(entry)) {
        failures.push(`src/vendored/${entry} 은 생성기가 내지 않는 파일이다 — 지우세요.`);
      }
    }
  }
} finally {
  await rm(tmp, { recursive: true, force: true });
}

// ────────────────────────── 2. src 의 import 경계 ──────────────────────────

/** `require('x')`, `import('x')`, `from 'x'`, `import 'x'` 를 모두 잡는다. */
const SPECIFIER = /(?:\brequire\(\s*|\bimport\(\s*|\bfrom\s+|^\s*import\s+)['"]([^'"]+)['"]/gm;

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(path)));
    else out.push(path);
  }
  return out;
}

const srcDir = join(indexerRoot, 'src');
for (const file of await walk(srcDir)) {
  if (!/\.(ts|tsx|js|mjs|cjs)$/.test(file)) continue;
  const text = await readFile(file, 'utf8');
  const shown = relative(indexerRoot, file);
  for (const [, specifier] of text.matchAll(SPECIFIER)) {
    if (specifier.startsWith('@monti/')) {
      failures.push(
        `${shown} 이 ${specifier} 를 가져온다 — 워크스페이스 패키지는 호스티드 배포에 없다. ` +
          'src/vendored/ 의 복제본을 쓰세요.',
      );
      continue;
    }
    if (!specifier.startsWith('.') && !specifier.startsWith('/')) continue; // npm 패키지
    const target = resolve(dirname(file), specifier);
    if (relative(indexerRoot, target).startsWith('..')) {
      failures.push(
        `${shown} 이 ${specifier} 를 가져온다 — indexer/ 밖이라 호스티드 배포에 올라가지 않는다.`,
      );
      continue;
    }
    // 상대 경로는 실제로 있어야 한다(확장자 생략 포함).
    const candidates = [target, `${target}.ts`, `${target}.js`, `${target}.json`,
      join(target, 'index.ts'), join(target, 'index.js')];
    let found = false;
    for (const candidate of candidates) {
      if (await stat(candidate).then((s) => s.isFile()).catch(() => false)) {
        found = true;
        break;
      }
    }
    if (!found) failures.push(`${shown} 이 가리키는 ${specifier} 가 없다.`);
  }
}

// ────────────────────────── 3. workspace: 의존성 ──────────────────────────

const pkg = JSON.parse(await readFile(join(indexerRoot, 'package.json'), 'utf8'));
for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
  for (const [name, range] of Object.entries(pkg[field] ?? {})) {
    if (typeof range === 'string' && range.startsWith('workspace:')) {
      failures.push(
        `package.json 의 ${field}.${name} 이 "${range}" 다 — 호스티드 배포는 indexer/ 만 ` +
          '설치하므로 워크스페이스 링크를 풀 수 없다.',
      );
    }
  }
}

// ──────────────────────────────── 결과 ────────────────────────────────

if (failures.length > 0) {
  console.error('[check-selfcontained] 실패:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(
  `[check-selfcontained] ok — 생성물 ${GENERATED.length}개가 최신이고, src/ 는 indexer/ 밖을 ` +
    '가리키지 않으며, workspace: 의존성이 없다.',
);
