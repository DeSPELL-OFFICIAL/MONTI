import { cp, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const from = join(here, '..', '..', '..', 'contracts', 'deployments');
const to = join(here, '..', 'src', 'deployments');

if (!existsSync(from)) {
  console.error(`[sync-deployments] ${from} 가 없습니다. sub-plan 01의 script/Deploy.s.sol을 먼저 실행하세요.`);
  process.exit(1);
}

await mkdir(to, { recursive: true });
let copied = 0;
for (const file of await readdir(from)) {
  if (!file.endsWith('.json')) continue;
  await cp(join(from, file), join(to, file));
  console.log(`[sync-deployments] ${file}`);
  copied += 1;
}

if (copied === 0) {
  console.error('[sync-deployments] 복사할 배포 파일이 없습니다.');
  process.exit(1);
}
