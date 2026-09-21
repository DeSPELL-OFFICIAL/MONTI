import { defineConfig } from 'vitest/config';

/**
 * 에뮬레이터 통합 테스트 전용 설정. `pnpm test:int` 이
 * `firebase emulators:exec --only firestore,auth` 안에서 이 설정으로 vitest 를 부른다.
 * 유닛 설정(`vitest.config.ts`)은 이 디렉터리를 제외해서 `pnpm test` 가 에뮬레이터 없이 돈다.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/integration/**/*.int.test.ts'],
    // 한 파일이 가입 한 줄 흐름을 순서대로 이어 간다. 병렬로 돌면 같은 문서를 서로 덮어쓴다.
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
