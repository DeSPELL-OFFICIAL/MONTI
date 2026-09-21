/**
 * Vite/vitest가 `?raw`로 들여온 파일을 문자열로 준다. `src/type4.test.ts`가 Kotlin 원본을
 * 그대로 읽기 위해 쓴다 — `@types/node`를 들이면 브라우저용 `src/`에 `Buffer` 같은 Node
 * 전역이 딸려 들어오므로 fs 대신 이 경로를 택했다.
 */
declare module '*?raw' {
  const contents: string;
  export default contents;
}
