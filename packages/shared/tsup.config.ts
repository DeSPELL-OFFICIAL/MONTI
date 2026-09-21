import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/index.ts', 'src/copy-lint.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    clean: true,
    sourcemap: true,
    // copy-lint CLI가 런타임에 TypeScript 컴파일러 API로 소스를 파싱한다.
    // 번들에 통째로 넣지 않고 node_modules에서 로드하도록 external 처리한다.
    external: ['typescript'],
    outExtension: ({ format }) => ({ js: format === 'cjs' ? '.cjs' : '.js' }),
  },
]);
