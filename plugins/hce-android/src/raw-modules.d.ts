/**
 * Vite/vitest가 `?raw`로 들여온 파일을 문자열로 준다. `src/type4.test.ts`가 Kotlin 원본을
 * 그대로 읽기 위해 쓴다 — `@types/node`를 들이면 브라우저용 `src/`에 `Buffer` 같은 Node
 * 전역이 딸려 들어오므로 fs 대신 이 경로를 택했다.
 */
declare module '*?raw' {
  const contents: string;
  export default contents;
}

/**
 * `import.meta.glob(..., { query: '?raw', eager: true })` — vite 가 패턴에 걸린 파일을 전부
 * 문자열로 준다. `src/apduService.test.ts` 가 `android/src/main` **전체**를 훑어야 해서 쓴다:
 * 파일 이름을 하나씩 적으면 나중에 추가된 파일이 검사에서 빠진다.
 */
interface ImportMeta {
  glob(
    pattern: string,
    options: { query: '?raw'; import: 'default'; eager: true },
  ): Record<string, string>;
}
