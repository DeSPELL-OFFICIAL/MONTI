import { execFile } from 'node:child_process';
import { lstat, readFile, readlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error — 빌드 스크립트는 타입 선언이 없는 .mjs 다(tsconfig 의 include 밖).
import { bundleDeploy } from '../esbuild.config.mjs';
import deployment10143 from '../../packages/shared/src/deployments/10143.json' with { type: 'json' };

const execFileAsync = promisify(execFile);
const functionsDir = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Cloud Functions 빌더는 업로드된 소스에서 `npm install` 을 돌린다. `@monti/shared` 가
 * 매니페스트에 `workspace:*` 로 남아 있으면 모든 배포가 거기서 죽는다. 이 테스트는
 * "번들 안에 shared 가 들어갔고 매니페스트에는 npm 이 받을 수 있는 것만 남았다" 를 지킨다.
 */
describe('deploy bundle', () => {
  let outDir = '';
  let bundlePath = '';
  let bundleSource = '';
  let manifest: {
    name: string;
    main: string;
    type: string;
    engines: { node: string };
    dependencies: Record<string, string>;
    devDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  };
  let sourceManifest: {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };

  beforeAll(async () => {
    const result = await bundleDeploy();
    outDir = result.outDir;
    bundlePath = result.bundlePath;
    bundleSource = await readFile(bundlePath, 'utf8');
    manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
    sourceManifest = JSON.parse(await readFile(join(functionsDir, 'package.json'), 'utf8'));
  }, 60_000);

  it('emits a single bundle file with a source map next to it', async () => {
    expect(bundleSource.length).toBeGreaterThan(0);
    const map = JSON.parse(await readFile(`${bundlePath}.map`, 'utf8'));
    expect(map.version).toBe(3);
  });

  it('resolves @monti/shared at build time, leaving no runtime import of it', () => {
    expect(bundleSource).not.toContain('@monti/shared');
    expect(bundleSource).not.toContain('workspace:');
    expect(bundleSource).not.toMatch(/from\s*["']@monti\/shared["']/);
    expect(bundleSource).not.toMatch(/require\(\s*["']@monti\/shared["']\s*\)/);
  });

  it('inlines the shared ABIs and deployment addresses instead of reading them at runtime', () => {
    // ABI 와 배포 주소는 JSON import 라 번들에 리터럴로 박혀야 한다.
    // 하나라도 런타임 파일 읽기로 남으면 Cloud Functions 에서 JSON 이 없어 죽는다.
    expect(bundleSource).toContain('deviceUpdatedAt'); // Identity ABI 항목
    // 10143 identity — 현재 배포 기록(v2 rc1: 0x1EDFE1BC…4B27)에서 읽는다. 재배포 때 손댈 필요가 없다.
    expect(bundleSource).toContain(deployment10143.identity);
    expect(bundleSource).not.toMatch(/readFileSync\(.*(abi|deployments)/i);
    expect(bundleSource).not.toMatch(/import\(\s*["'`]/); // 동적 import 로 빠져나간 모듈이 없다
  });

  it('generates a manifest Cloud Functions can npm install', () => {
    expect(manifest.name).toBe('monti-functions');
    expect(manifest.main).toBe('index.js');
    expect(manifest.type).toBe('module');
    expect(manifest.engines.node).toBe('22');
    expect(manifest.dependencies['@monti/shared']).toBeUndefined();
    expect(manifest.devDependencies).toBeUndefined();
    expect(manifest.scripts).toBeUndefined();
    expect(JSON.stringify(manifest)).not.toContain('workspace:');
  });

  it('copies every remaining dependency range verbatim from functions/package.json', () => {
    const source = sourceManifest.dependencies;
    const expected = Object.keys(source).filter((name) => name !== '@monti/shared');
    expect(Object.keys(manifest.dependencies).sort()).toEqual(expected.sort());
    for (const [name, range] of Object.entries(manifest.dependencies)) {
      expect(range).toBe(source[name]);
    }
  });

  it('keeps @monti/shared out of the deployed dependency set but resolvable locally', () => {
    expect(sourceManifest.dependencies['@monti/shared']).toBeUndefined();
    expect(sourceManifest.devDependencies['@monti/shared']).toBe('workspace:*');
  });

  it('links the workspace node_modules so the CLI can find the functions binary', async () => {
    // firebase-tools 는 `<source>/node_modules/.bin/firebase-functions` 를 직접 실행해
    // 트리거를 찾는다. 이 링크가 없으면 배포도 에뮬레이터도 소스를 읽지 못하고 죽는다.
    const link = join(outDir, 'node_modules');
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readlink(link)).toBe('../node_modules');
    expect((await lstat(join(link, '.bin', 'firebase-functions'))).isFile()).toBe(true);
  });

  it('imports in plain Node without Firebase credentials and exports every callable', async () => {
    const env = { ...process.env };
    // 자격 증명이 있으면 "없어도 뜬다" 를 증명하지 못한다. 전부 지우고 띄운다.
    for (const key of [
      'GOOGLE_APPLICATION_CREDENTIALS',
      'GCLOUD_PROJECT',
      'GOOGLE_CLOUD_PROJECT',
      'FIREBASE_CONFIG',
      'FIRESTORE_EMULATOR_HOST',
      'FIREBASE_AUTH_EMULATOR_HOST',
      'STORAGE_EMULATOR_HOST',
    ]) {
      delete env[key];
    }

    const { stdout } = await execFileAsync(
      process.execPath,
      ['-e', "import('./.deploy/index.js').then((m) => console.log(JSON.stringify(Object.keys(m))))"],
      { cwd: functionsDir, env },
    );
    const exported: string[] = JSON.parse(stdout.trim().split('\n').at(-1) as string);

    for (const name of [
      'startSignup',
      'startKyc',
      'registerPasskey',
      'loginChallenge',
      'loginVerify',
      'diditWebhook',
      'registerIdentity',
      'issueSnapshot',
      'resolveRecipient',
      'getSignupStatus',
      'listAttendees',
      'getEventPrivate',
      'setEventPrivate',
      'saveEventArt',
      'listPendingGates',
      'submitPendingGate',
      'tenderlyWebhook',
      'reconcilePending',
      'dailyExport',
      'pinEventImage',
      'pinEventMetadata',
      'createOrganizerForMe',
      'pinMessage',
      'listPinned',
      'listInvites',
      'revokeInvite',
      'requestAccountDeletion',
      'processDeletions',
    ]) {
      expect(exported).toContain(name);
    }
  }, 60_000);

  it('is idempotent — a second build produces byte-identical artefacts', async () => {
    const second = await bundleDeploy();
    expect(await readFile(second.bundlePath, 'utf8')).toBe(bundleSource);
    expect(JSON.parse(await readFile(second.manifestPath, 'utf8'))).toEqual(manifest);
  }, 60_000);
});
