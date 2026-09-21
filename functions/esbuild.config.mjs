/**
 * Cloud Functions 배포용 번들러.
 *
 * Cloud Functions 빌더는 업로드된 소스에서 `npm install` 을 돌린다. pnpm 워크스페이스
 * 링크(`workspace:*`)는 그 환경에서 해석되지 않으므로 `@monti/shared` 를 의존성으로
 * 남겨 두면 모든 배포가 실패한다. 그래서 `@monti/shared`(및 그 안에 인라인된 ABI/배포
 * JSON)만 번들에 밀어 넣고, npm 레지스트리에서 받을 수 있는 나머지 의존성은 전부
 * external 로 남긴 뒤 그 목록만 담은 매니페스트를 생성한다.
 *
 * 매니페스트는 손으로 고치지 않는다 — 항상 `functions/package.json` 에서 파생된다.
 */
import { build } from 'esbuild';
import { lstat, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** 번들에 들어가는 유일한 워크스페이스 패키지. 나머지 워크스페이스 링크는 존재하지 않는다. */
export const BUNDLED_WORKSPACE_DEP = '@monti/shared';

/** 생성물 이름. `.deploy/` 안에 이 세 개만 만든다. */
export const ARTEFACTS = ['index.js', 'index.js.map', 'package.json'];

export const DEFAULT_OUT_DIR = join(here, '.deploy');

/**
 * external 패턴. 패키지 이름만으로는 `firebase-admin/app` 같은 서브패스 import 가
 * 잡히지 않으므로 `<name>/*` 를 함께 넣는다.
 */
function externalPatterns(dependencies) {
  return Object.keys(dependencies)
    .filter((name) => name !== BUNDLED_WORKSPACE_DEP)
    .flatMap((name) => [name, `${name}/*`]);
}

/** 배포 매니페스트. 버전 범위는 원본에서 글자 그대로 옮긴다. */
export function deployManifest(sourcePackageJson) {
  const dependencies = {};
  for (const [name, range] of Object.entries(sourcePackageJson.dependencies ?? {})) {
    if (name === BUNDLED_WORKSPACE_DEP) continue;
    dependencies[name] = range;
  }
  return {
    name: sourcePackageJson.name,
    main: 'index.js',
    type: 'module',
    engines: { node: '22' },
    dependencies,
  };
}

/**
 * Firebase CLI 는 배포 전에 `<source>/node_modules/.bin/firebase-functions` 를 직접 실행해
 * 트리거 목록을 뽑는다(에뮬레이터도 같은 경로를 쓴다). 생성 디렉터리에는 node_modules 가
 * 없으므로, 워크스페이스가 이미 설치해 둔 `functions/node_modules` 로 링크를 걸어 준다.
 * 업로드에는 들어가지 않는다 — `firebase.json` 의 `ignore` 가 `node_modules` 를 걸러낸다.
 */
async function linkWorkspaceModules(outDir) {
  const workspaceModules = join(here, 'node_modules');
  if (!(await exists(workspaceModules))) return false;

  const linkPath = join(outDir, 'node_modules');
  if (linkPath === workspaceModules) return true;
  if (await exists(linkPath)) await rm(linkPath, { force: true, recursive: true });
  await symlink(relative(outDir, workspaceModules), linkPath, 'dir');
  return true;
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * `.deploy/` 를 처음부터 다시 만든다. 같은 입력이면 몇 번을 돌려도 같은 결과가 나온다.
 *
 * @param {{ outDir?: string }} [options]
 * @returns {Promise<{ outDir: string, bundlePath: string, manifestPath: string, manifest: object,
 *   bytes: number, linked: boolean }>}
 */
export async function bundleDeploy(options = {}) {
  const outDir = resolve(options.outDir ?? DEFAULT_OUT_DIR);
  const sourcePackageJson = JSON.parse(await readFile(join(here, 'package.json'), 'utf8'));

  await mkdir(outDir, { recursive: true });
  // 생성물만 지운다. `.gitkeep` 이나 에뮬레이터가 만든 것은 건드리지 않는다.
  await Promise.all(ARTEFACTS.map((name) => rm(join(outDir, name), { force: true })));

  const bundlePath = join(outDir, 'index.js');
  await build({
    entryPoints: [join(here, 'src', 'index.ts')],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    sourcemap: true,
    sourcesContent: false,
    legalComments: 'none',
    logLevel: 'warning',
    external: externalPatterns(sourcePackageJson.dependencies ?? {}),
  });

  const manifest = deployManifest(sourcePackageJson);
  const manifestPath = join(outDir, 'package.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const linked = await linkWorkspaceModules(outDir);

  const bytes = (await readFile(bundlePath)).byteLength;
  return { outDir, bundlePath, manifestPath, manifest, bytes, linked };
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const { bundlePath, manifest, bytes } = await bundleDeploy();
  const names = Object.keys(manifest.dependencies).join(', ');
  console.log(`bundled ${bundlePath} (${(bytes / 1024).toFixed(1)} KB)`);
  console.log(`manifest dependencies: ${names}`);
}
