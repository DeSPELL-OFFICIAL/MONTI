/**
 * `generated/` 를 제 발로 서는 pnpm 워크스페이스 루트로 만든다.
 *
 * `envio codegen` 은 생성 디렉터리 안에서 `pnpm install` 을 한 번 돌려 rescript 를
 * 깔아야 컴파일을 시작한다. 그런데 그 디렉터리는 이 저장소의 워크스페이스 **안**에
 * 있어서, 아무 표시가 없으면 pnpm 이 루트까지 거슬러 올라가 루트 워크스페이스에
 * 설치해 버린다("Scope: all 4 workspace projects"). 그러면 `generated/node_modules`
 * 가 비어 codegen 이 `Command "rescript" not found` 로 멈추고, 덤으로 루트
 * `pnpm-lock.yaml` 까지 건드린다.
 *
 * 빈 `pnpm-workspace.yaml` 하나면 pnpm 의 루트 탐색이 거기서 멈춘다. 예전에는 루트
 * `pnpm-workspace.yaml` 에 `indexer/generated` 를 **패키지로 올려서** 같은 문제를
 * 피했는데, 그러면 gitignore 된 디렉터리가 lockfile 의 importer 가 되어 lockfile 이
 * "generated 있음/없음" 두 상태를 오갔다(Task 33 리뷰 Important 1). 이 파일이 그
 * 대체재다 — 커밋되는 lockfile 은 언제나 generated 가 **없는** 상태 하나뿐이다.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const generated = join(dirname(fileURLToPath(import.meta.url)), '..', 'generated');
await mkdir(generated, { recursive: true });
await writeFile(join(generated, 'pnpm-workspace.yaml'), 'packages: []\n', 'utf8');
console.log('[isolate-generated] generated/pnpm-workspace.yaml');
