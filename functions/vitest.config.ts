import { configDefaults, defineConfig } from 'vitest/config';

// `pnpm test`는 에뮬레이터 없이 도는 유닛 테스트(config, kms)만 실행한다.
// 에뮬레이터가 필요한 rules 테스트는 `pnpm test:rules`(RULES=1)로만 돈다.
const rulesOnly = process.env.RULES === '1';

export default defineConfig({
  test: {
    environment: 'node',
    include: rulesOnly ? ['test/rules.test.ts'] : ['test/**/*.test.ts'],
    exclude: rulesOnly ? configDefaults.exclude : [...configDefaults.exclude, 'test/rules.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    fileParallelism: false,
  },
});
