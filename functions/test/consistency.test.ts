import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import * as dbModule from '../src/lib/db.js';

/**
 * 스펙 §10.4(와 §10.3)의 저장 규칙을 소스 정적 스캔으로 강제한다.
 *
 * 이 파일은 실행 시점의 동작이 아니라 **소스에 무엇이 쓰여 있는가**를 본다. 새 함수가
 * 규칙을 어기면 그 함수의 유닛 테스트가 통과해도 여기서 막힌다.
 *
 * 스캔이 리터럴만 본다면 가드가 아니다 — 이 코드베이스는 컬렉션 이름을 `db.ts` 상수로,
 * 문서 페이로드를 변수로 빼 두고 쓴다. 그래서 스캔은 (a) `db.ts`·`lib/auth.ts` 가 내보내는
 * 이름을 모듈에서 끌어와 해석하고, (b) 템플릿 경로를 분해하고, (c) `.set/.update/.create/.add`
 * 인자가 식별자·스프레드면 같은 파일의 선언과 **다른 파일의 함수 본문**까지 펼친다.
 *
 * 마지막 스캔 하나는 소스가 아니라 **소스와 `firestore.indexes.json` 사이**를 본다 — 복합 질의에
 * 대응 색인이 없으면 지금까지는 운영의 `FAILED_PRECONDITION` 만이 신호였다.
 *
 * **스캔은 전부 순수 함수다.** 진짜 소스 트리(초록이어야 한다)와, 아래 `negative fixtures`
 * 의 메모리 상 위반 소스(각각 빨간불이어야 한다)에 같은 함수를 돌린다. 녹색인 스캔은
 * 그 자체로는 아무것도 증명하지 못하기 때문이다.
 */

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const INDEX_PATH = fileURLToPath(new URL('../../firestore.indexes.json', import.meta.url));
const ALLOWED: readonly string[] = dbModule.ALLOWED_COLLECTIONS;

/** `db.ts` 가 내보내는 문자열 상수 전부. 이름→값 표가 모듈에서 오므로 표가 따로 늙지 않는다. */
const COLLECTION_CONSTANTS = new Map<string, string>(
  // 네임스페이스에는 `db`·함수도 섞여 있다. 술어 대신 flatMap 으로 걸러야 값 타입이 좁혀진 채 남는다.
  Object.entries(dbModule).flatMap(([name, value]) => (typeof value === 'string' ? [[name, value] as const] : [])),
);

const CHAIN_FILE = join('lib', 'chain.ts');
const AUTH_FILE = join('lib', 'auth.ts');
const INVITES_FILE = join('functions', 'invites.ts');

// ───────────────────────────────────────────────────────────── 소스 모델

interface SourceFile {
  /** `src` 기준 상대 경로. 실패 메시지에 나간다. */
  rel: string;
  /** 주석을 공백으로 지운 본문. 오프셋과 줄 번호는 원본 그대로 보존된다. */
  code: string;
}

function makeSource(rel: string, text: string): SourceFile {
  return { rel, code: stripComments(text) };
}

async function sourcePaths(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) out.push(...(await sourcePaths(full)));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out.sort();
}

/** `at` 의 따옴표에서 시작해 닫는 따옴표 **다음** 인덱스를 돌려준다. */
function skipString(text: string, at: number): number {
  const quote = text[at];
  let i = at + 1;
  while (i < text.length) {
    if (text[i] === '\\') {
      i += 2;
      continue;
    }
    if (text[i] === quote) return i + 1;
    i += 1;
  }
  return i;
}

/** 문자열은 살리고 주석만 공백으로 지운다. 길이를 유지해 줄 번호 계산이 그대로 맞는다. */
function stripComments(text: string): string {
  const out = text.split('');
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') {
        out[i] = ' ';
        i += 1;
      }
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        if (text[i] !== '\n') out[i] = ' ';
        i += 1;
      }
      if (i < text.length) out[i] = ' ';
      if (i + 1 < text.length) out[i + 1] = ' ';
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      i = skipString(text, i);
      continue;
    }
    i += 1;
  }
  return out.join('');
}

function lineOf(code: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < code.length; i += 1) if (code[i] === '\n') line += 1;
  return line;
}

/** 공백·줄바꿈을 한 칸으로 눌러 정규식이 포맷에 의존하지 않게 한다. */
function flatten(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

// ───────────────────────────────────────────────────────────── 괄호·문장 파서

/** `open` 의 `(` 에서 시작해 균형 잡힌 인자 목록 원문을 돌려준다. */
function readArgs(code: string, open: number): string | null {
  let depth = 0;
  let i = open;
  while (i < code.length) {
    const c = code[i];
    if (c === "'" || c === '"' || c === '`') {
      i = skipString(code, i);
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') {
      depth -= 1;
      if (depth === 0) return code.slice(open + 1, i);
    }
    i += 1;
  }
  return null;
}

/** 최상위 콤마로만 자른다. 중첩 객체·호출·문자열 안의 콤마는 건드리지 않는다. */
function splitArgs(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "'" || c === '"' || c === '`') {
      i = skipString(text, i);
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') depth -= 1;
    else if (c === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
    i += 1;
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/**
 * `index` 를 품은 **문장**을 돌려준다. 물리적 줄이 아니라 괄호 균형으로 경계를 잡으므로
 * 한 줄에 두 문장이 있든(`const a = 1; const { account } = request.data …`)
 * 선언이 여러 줄로 감기든(`const { account } =\n  (request.data ?? {}) as Body;`) 같게 동작한다.
 * 저장소에 포매터 설정이 없어 줄바꿈이 사람 손에 달렸기 때문에 포맷 의존을 없애야 한다.
 */
function statementAround(code: string, index: number): string {
  // 뒤로: `{` 나 `;` 를 깊이 0 에서 만나면 문장 시작. `(`·`[` 는 바깥 식으로 나가는 것이라 계속 간다.
  let depth = 0;
  let start = 0;
  for (let i = index - 1; i >= 0; i -= 1) {
    const c = code[i];
    if (c === '}' || c === ')' || c === ']') depth += 1;
    else if (c === '{') {
      if (depth === 0) {
        start = i + 1;
        break;
      }
      depth -= 1;
    } else if (c === '(' || c === '[') {
      if (depth > 0) depth -= 1;
    } else if (c === ';' && depth === 0) {
      start = i + 1;
      break;
    }
  }
  // 앞으로: `;` 나 (블록을 빠져나가는) `}` 를 깊이 0 에서 만나면 문장 끝.
  depth = 0;
  let end = code.length;
  for (let i = index; i < code.length; i += 1) {
    const c = code[i];
    if (c === "'" || c === '"' || c === '`') {
      i = skipString(code, i) - 1;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === '}') {
      if (depth === 0) {
        end = i;
        break;
      }
      depth -= 1;
    } else if (c === ')' || c === ']') {
      if (depth > 0) depth -= 1;
    } else if (c === ';' && depth === 0) {
      end = i;
      break;
    }
  }
  return flatten(code.slice(start, end));
}

// ───────────────────────────────────────────────────────────── 경로 해석

/**
 * `.collection(...)` / `.doc(...)` / `.collectionGroup(...)` 인자를 Firestore 경로로 푼다.
 *  - `'persons'` → `persons`
 *  - `PERSONS` → `db.ts` 상수값
 *  - `` `${EVENT_CHATS}/${eventId}/members` `` → `eventChats/{*}/members`(동적 구간은 `*`)
 *  - `ticketPath`(같은 파일의 `const ticketPath = \`tickets/${id}/…\``) → 선언을 펼쳐 한 번 더 시도
 * 못 풀면 `null`.
 */
function resolvePath(files: SourceFile[], file: SourceFile, arg: string, depth = 0): string | null {
  const text = arg.trim();
  const quoted = /^(['"])([\s\S]*)\1$/.exec(text);
  if (quoted) return quoted[2] ?? null;
  if (text.startsWith('`') && text.endsWith('`') && text.length >= 2) {
    return text
      .slice(1, -1)
      .replace(/\$\{([^}]*)\}/g, (_match, expr: string) => COLLECTION_CONSTANTS.get(expr.trim()) ?? '*');
  }
  if (/^[A-Za-z_$][\w$]*$/.test(text)) {
    const constant = COLLECTION_CONSTANTS.get(text);
    if (constant !== undefined) return constant;
    if (depth > 1) return null;
    const declaration = declarationOf(files, file, text);
    return declaration === null ? null : resolvePath(files, file, declaration.trim(), depth + 1);
  }
  return null;
}

// ───────────────────────────────────────────────────────────── 호출 지점

interface CallSite {
  file: SourceFile;
  line: number;
  method: string;
  args: string[];
  /**
   * 수신자가 Firestore 문서·컬렉션 참조(또는 트랜잭션)로 보이는가.
   * `.set`/`.update`/`.add` 라는 이름은 `Map`·`Set`·`crypto` 도 쓴다. 키 검사는 어느 쪽이든
   * 보수적으로 돌리지만, "헬퍼를 못 펼쳤다"는 **큰소리 실패**는 진짜 Firestore 쓰기에만 건다.
   */
  firestoreLike: boolean;
}

/** 인라인 체인 수신자 — `….doc(x)` / `….collection(x)` 로 끝나는 식. */
const FIRESTORE_CHAIN = /(?:\.doc|\.collection|\.collectionGroup)\s*\([^()]*\)\s*$/;
/** `*Ref`·`.ref` 로 끝나는 이름. */
const FIRESTORE_REF = /[\w$]*[Rr]ef\s*$/;
/** 트랜잭션·배치 수신자의 관례적 이름. 파일마다 `runTransaction(` 콜백 파라미터가 여기 더해진다. */
const TRANSACTION_NAMES = ['tx', 'transaction', 'batch'];
/** 점을 거치지 않은 맨 이름 수신자 — `await target.set(…)` 의 `target`. */
const BARE_RECEIVER = /(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*$/;

/**
 * `db.runTransaction(async (t) => …)` 의 콜백 파라미터 이름을 관례 이름에 더한다.
 * `t` 는 `tx` 만큼 흔한데 이름 모양만 보면 진짜 트랜잭션 쓰기의 경보가 꺼진다.
 */
function transactionNames(file: SourceFile): Set<string> {
  const names = new Set(TRANSACTION_NAMES);
  const pattern = /\brunTransaction\s*\(/g;
  let match = pattern.exec(file.code);
  while (match !== null) {
    const open = file.code.indexOf('(', match.index);
    const args = readArgs(file.code, open);
    if (args !== null) {
      const parts = splitArgs(args);
      const handler = parts[parts.length - 1] ?? '';
      const arrow = handler.indexOf('=>');
      const head = arrow === -1 ? handler : handler.slice(0, arrow);
      const parens = /\(([^)]*)\)/.exec(head);
      const simple = /^([A-Za-z_$][\w$]*)(?:\s*:|$)/.exec(flatten(parens?.[1] ?? ''));
      if (simple?.[1] !== undefined) names.add(simple[1]);
    }
    match = pattern.exec(file.code);
  }
  return names;
}

/**
 * 수신자가 Firestore 쓰기 대상인지 **이름 모양이 아니라 해석**으로 판정한다.
 * `const target = db.collection(P).doc(id); target.set(…)` 은 평범한 리팩터링인데
 * 이름만 보면 경보가 꺼진다 — 맨 이름이면 선언을 한 번 펼쳐 같은 잣대를 다시 댄다.
 * (`.doc(ident)` 해석에 이미 쓰는 기법이다.)
 */
function isFirestoreReceiver(
  files: SourceFile[],
  file: SourceFile,
  prefix: string,
  txNames: Set<string>,
): boolean {
  if (FIRESTORE_CHAIN.test(prefix) || FIRESTORE_REF.test(prefix)) return true;
  const name = BARE_RECEIVER.exec(prefix)?.[1];
  if (name === undefined) return false;
  if (txNames.has(name)) return true;
  const declaration = declarationOf(files, file, name);
  return declaration !== null && FIRESTORE_CHAIN.test(declaration);
}

/** 주어진 메서드 호출을 전부 찾아 균형 잡힌 인자와 함께 돌려준다. */
function callSites(files: SourceFile[], names: readonly string[]): CallSite[] {
  const pattern = new RegExp(`\\.(${names.join('|')})\\s*\\(`, 'g');
  const out: CallSite[] = [];
  for (const file of files) {
    const txNames = transactionNames(file);
    pattern.lastIndex = 0;
    let match = pattern.exec(file.code);
    while (match !== null) {
      const open = file.code.indexOf('(', match.index);
      const args = readArgs(file.code, open);
      if (args !== null) {
        const prefix = file.code.slice(Math.max(0, match.index - 80), match.index);
        out.push({
          file,
          line: lineOf(file.code, match.index),
          method: match[1] ?? '',
          args: splitArgs(args),
          firestoreLike: isFirestoreReceiver(files, file, prefix, txNames),
        });
      }
      match = pattern.exec(file.code);
    }
  }
  return out;
}

/** 선언의 `=` 뒤부터 최상위 `;` 까지, 즉 초기화식 원문. */
function initializerAfter(source: SourceFile, pattern: RegExp): string | null {
  pattern.lastIndex = 0;
  const match = pattern.exec(source.code);
  if (match === null) return null;
  let i = match.index + match[0].length;
  const start = i;
  let depth = 0;
  while (i < source.code.length) {
    const c = source.code[i];
    if (c === "'" || c === '"' || c === '`') {
      i = skipString(source.code, i);
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') depth -= 1;
    else if (c === ';' && depth === 0) break;
    i += 1;
  }
  return source.code.slice(start, i);
}

/**
 * 식별자의 선언 본문을 찾는다.
 *  1. 같은 파일의 `const|let|var X = …;` 초기화식
 *  2. **어느 파일이든** `export const X = …;` — 페이로드 빌더를 화살표 상수로 빼도 따라간다.
 *  3. **어느 파일이든** `function X(…) { … }` 본문
 */
function declarationOf(files: SourceFile[], file: SourceFile, ident: string): string | null {
  const local = initializerAfter(
    file,
    new RegExp(`\\b(?:const|let|var)\\s+${ident}\\b\\s*(?::[^=\\n]*)?=`, 'g'),
  );
  if (local !== null) return local;

  const exported = new RegExp(`\\bexport\\s+(?:const|let|var)\\s+${ident}\\b\\s*(?::[^=\\n]*)?=`, 'g');
  for (const candidate of files) {
    if (candidate === file) continue;
    const hit = initializerAfter(candidate, exported);
    if (hit !== null) return hit;
  }

  const fn = new RegExp(`\\bfunction\\s+${ident}\\s*\\(`, 'g');
  for (const candidate of [file, ...files]) {
    fn.lastIndex = 0;
    const hit = fn.exec(candidate.code);
    if (hit === null) continue;
    const body = candidate.code.indexOf('{', hit.index + hit[0].length);
    if (body === -1) continue;
    return readArgs(candidate.code, body);
  }
  return null;
}

/**
 * 객체 원문에서 키 이름을 전부 뽑는다 — `a: 1`, 축약형 `a`, 따옴표 키 `'a': 1`,
 * 계산 키 `['a']: 1` / `[a]: 1`, 중첩 객체까지.
 */
function keysIn(objectText: string): Set<string> {
  const keys = new Set<string>();
  for (const m of objectText.matchAll(/(?:^|[{,[\s])\[?\s*(['"])?([A-Za-z_$][\w$]*)\1?\s*\]?\s*:/g)) {
    if (m[2] !== undefined) keys.add(m[2]);
  }
  for (const m of objectText.matchAll(/(?:^|[{,])\s*(['"])?([A-Za-z_$][\w$]*)\1?\s*(?=[,}])/g)) {
    if (m[2] !== undefined) keys.add(m[2]);
  }
  return keys;
}

interface Payload {
  keys: Set<string>;
  /** 펼치지 못한 헬퍼 호출의 이름. 스캔은 이걸 조용히 넘기지 않고 실패로 보고한다. */
  unresolved: string[];
}

/**
 * 한 쓰기 호출이 Firestore 문서에 실을 수 있는 키 전부.
 * 인자가 객체 리터럴이면 그 자리에서, 식별자면 선언을 펼쳐서, 스프레드면 그 대상을 펼쳐서,
 * **인자 전체가 헬퍼 호출식이면**(`.set(buildPersonDoc(phone))`) 그 헬퍼의 선언(같은 파일 상수·
 * 다른 파일 `export const` 화살표·어느 파일이든 `function`)을 펼쳐서 모은다.
 * 헬퍼를 못 찾으면 조용히 통과시키지 않고 `unresolved` 에 담아 스캔을 빨간불로 만든다.
 */
function payloadKeys(files: SourceFile[], site: CallSite): Payload {
  const keys = new Set<string>();
  const unresolved: string[] = [];
  const seen = new Set<string>();
  const expand = (text: string, depth: number): void => {
    if (depth > 3) return;
    for (const key of keysIn(text)) keys.add(key);
    const idents = new Set<string>();
    const bare = text.trim();
    if (/^[A-Za-z_$][\w$]*$/.test(bare)) idents.add(bare);
    for (const m of text.matchAll(/\.\.\.\s*([A-Za-z_$][\w$]*)/g)) if (m[1]) idents.add(m[1]);
    for (const ident of idents) {
      if (seen.has(ident)) continue;
      seen.add(ident);
      const declaration = declarationOf(files, site.file, ident);
      if (declaration !== null) expand(declaration, depth + 1);
    }
    // 인자 전체가 **맨 이름의 호출식**이면 그 함수가 곧 페이로드다. `a.b()` 같은 메서드 호출은
    // 정적으로 따라갈 대상이 없어(그리고 Map.set·cipher.update 가 같은 정규식을 공유해) 건너뛴다.
    const call = /^([A-Za-z_$][\w$]*)\s*\(/.exec(bare);
    if (call?.[1] !== undefined && bare.endsWith(')') && !seen.has(`call:${call[1]}`)) {
      seen.add(`call:${call[1]}`);
      const declaration = declarationOf(files, site.file, call[1]);
      if (declaration === null) unresolved.push(call[1]);
      else expand(declaration, depth + 1);
    }
  };
  // `.set(payload)` 도 `tx.set(ref, payload, { merge: true })` 도 있으므로 모든 인자를 본다.
  for (const arg of site.args) expand(arg, 0);
  keys.delete('merge');
  return { keys, unresolved };
}

// ───────────────────────────────────────────────────────────── callable 모델

interface Callable {
  file: SourceFile;
  line: number;
  /** 핸들러 첫 파라미터 이름. 구조분해 등 스캔할 수 없는 모양이면 `null`. */
  param: string | null;
  paramText: string;
  body: string;
}

function callables(files: SourceFile[]): Callable[] {
  const out: Callable[] = [];
  for (const file of files) {
    const pattern = /\bonCall\s*\(/g;
    let match = pattern.exec(file.code);
    while (match !== null) {
      const open = file.code.indexOf('(', match.index);
      const args = readArgs(file.code, open);
      if (args !== null) {
        const parts = splitArgs(args);
        const handler = parts[parts.length - 1] ?? '';
        const arrow = handler.indexOf('=>');
        const head = arrow === -1 ? handler : handler.slice(0, arrow);
        const body = arrow === -1 ? handler : handler.slice(arrow + 2);
        const parens = /\(([^)]*)\)/.exec(head);
        const paramText = flatten(parens?.[1] ?? head.replace(/^\s*async\s+/, ''));
        const simple = /^([A-Za-z_$][\w$]*)(?:\s*:|$)/.exec(paramText);
        out.push({
          file,
          line: lineOf(file.code, match.index),
          param: simple?.[1] ?? null,
          paramText,
          body,
        });
      }
      match = pattern.exec(file.code);
    }
  }
  return out;
}

/** `lib/auth.ts` 가 내보내는 인가 함수들 — `resolveCallerAccount` 만 빼고 전부. */
function authHelpers(files: SourceFile[]): Set<string> {
  const auth = files.find((file) => file.rel === AUTH_FILE);
  const names = new Set<string>();
  if (!auth) return names;
  for (const m of auth.code.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) {
    if (m[1] !== undefined && m[1] !== 'resolveCallerAccount') names.add(m[1]);
  }
  return names;
}

/**
 * 파일 지역 인가 헬퍼 — `requireOrganizer(eventId: bigint, caller: Hex)` 처럼
 * 가드 이름 규약을 쓰면서 **주소를 인자로 받는** 함수. 새 헬퍼를 만들어도 이름만 규약을 따르면 잡힌다.
 */
function localAddressGuards(file: SourceFile): Set<string> {
  const names = new Set<string>();
  const pattern = /\bfunction\s+((?:require|assert|ensure|check|authorize|guard)[A-Z][\w$]*)\s*\(([^)]*)\)/g;
  for (const m of file.code.matchAll(pattern)) {
    if (m[1] !== undefined && m[2] !== undefined && /:\s*(?:Hex|Address)\b/.test(m[2])) names.add(m[1]);
  }
  return names;
}

// ───────────────────────────────────────────────────────────── 스캔

/** 한 건의 위반. 문자열이라 실패 출력에 그대로 읽힌다. */
type Finding = string;

interface ScanResult {
  findings: Finding[];
  /** 이 스캔이 실제로 들여다본 대상 수. 0이면 스캔이 코드 모양을 놓친 것이므로 실패시킨다. */
  targets: number;
}

const PATH_METHODS = ['collectionGroup', 'collection', 'doc'] as const;

/** 경로에서 컬렉션 자리(짝수 번째 조각)만 뽑는다. 홀수 자리는 문서 id 다. */
function collectionSegments(method: string, path: string): string[] {
  const segments = path.split('/');
  if (method === 'collectionGroup') return segments.length === 1 ? segments : [];
  if (method === 'doc' && segments.length < 2) return [];
  return segments.filter((_segment, index) => index % 2 === 0);
}

/** 스펙 §10.4 규칙 1 — 허용 목록 밖 컬렉션을 건드리지 않는다. */
function scanAllowlist(files: SourceFile[]): ScanResult {
  const sites = callSites(files, PATH_METHODS);
  const findings: Finding[] = [];
  for (const site of sites) {
    const where = `${site.file.rel}:${site.line}`;
    const raw = site.args[0] ?? '';
    const path = resolvePath(files, site.file, raw);
    if (path === null) {
      // `.doc(uid)` 같은 동적 **문서 id** 는 정상이다. 하지만 컬렉션 이름은 언제나 해석돼야 하고,
      // 경로 모양의 템플릿(`/` 를 품은)도 해석되지 않으면 허용 목록을 우회하는 통로가 된다.
      if (site.method !== 'doc' || raw.includes('/')) {
        findings.push(
          `${where} 가 .${site.method}() 에 해석할 수 없는 인자 \`${flatten(raw)}\` 를 넘긴다 — 컬렉션 이름은 db.ts 상수·리터럴·해석 가능한 템플릿이어야 허용 목록으로 강제할 수 있다.`,
        );
      }
      continue;
    }
    for (const segment of collectionSegments(site.method, path)) {
      if (segment === '*') {
        findings.push(`${where} 가 컬렉션 이름을 동적으로 만든다(경로 ${path}).`);
      } else if (!ALLOWED.includes(segment)) {
        findings.push(`${where} 가 허용 목록에 없는 컬렉션 "${segment}" 를 건드린다(경로 ${path}).`);
      }
    }
  }
  return { findings, targets: sites.length };
}

const FORBIDDEN_COLLECTIONS = [
  'tickets',
  'checkIns',
  'checkins',
  'roles',
  'gates',
  'events',
  'admins',
  'managers',
  'organizers',
];

/** 스펙 §10.4 규칙 1 — 티켓·역할·입장 컬렉션 이름은 아예 부르지 않는다. */
function scanForbiddenNames(files: SourceFile[]): ScanResult {
  const sites = callSites(files, PATH_METHODS);
  const findings: Finding[] = [];
  for (const file of files) {
    for (const name of FORBIDDEN_COLLECTIONS) {
      // 주석을 지운 본문만 본다 — 한국어 주석에 예시 경로가 들어가도 거짓 실패하지 않는다.
      if (new RegExp(`\\.(collection|collectionGroup|doc)\\(\\s*['"\`]${name}[/'"\`]`).test(file.code)) {
        findings.push(`${file.rel} mentions collection "${name}" — 티켓·역할·입장 상태는 체인이 원본이다.`);
      }
    }
  }
  // 상수·변수·템플릿으로 우회한 경우까지 같은 금지 목록으로 잡는다.
  for (const site of sites) {
    const path = resolvePath(files, site.file, site.args[0] ?? '');
    if (path === null) continue;
    for (const segment of collectionSegments(site.method, path)) {
      if (FORBIDDEN_COLLECTIONS.includes(segment)) {
        findings.push(
          `${site.file.rel}:${site.line} resolves to forbidden collection "${segment}"(경로 ${path}).`,
        );
      }
    }
  }
  return { findings, targets: sites.length };
}

const FORBIDDEN_4337 = [
  'paymaster',
  'bundler',
  'EntryPoint',
  'sendSponsoredOp',
  'UserOperation',
  'predeployAccount',
  'accountDeployPending',
];

/**
 * 설계 §3 — 4337(페이마스터·번들러·스마트계정 사전배포) 경로는 폐기됐다. 되살아나면 여기서 막는다.
 * 주석을 지운 본문(문자열 포함)만 본다 — 코드·식별자에 이 심볼이 남으면 실패. 대소문자는 가리지 않는다.
 */
function scanForbidden4337(files: SourceFile[]): ScanResult {
  const findings: Finding[] = [];
  for (const file of files) {
    for (const symbol of FORBIDDEN_4337) {
      if (new RegExp(symbol, 'i').test(file.code)) {
        findings.push(
          `${file.rel} 에 폐기된 4337 심볼 "${symbol}" 가 남아 있다 — 설계 §3: 페이마스터·번들러·사전배포는 폐기됐다.`,
        );
      }
    }
  }
  return { findings, targets: files.length };
}

const CHAIN_PROOFS = ['awaitFinalized', "blockTag: 'finalized'", 'decodeMontiLogs', "functionName: 'accountOf'"];

/**
 * 스펙 §10.4 규칙 3 — finalized 를 확인하지 않고 `active` 로 적지 않는다.
 *
 * **의도적으로 파일 단위다.** 그래서 이미 체인 토큰이 있는 파일에 체인을 읽지 않는 새 분기가
 * 생기거나, `status: STATUS_ACTIVE` 상수·`{ status }` 축약으로 쓰면 이 스캔은 놓친다.
 * 분기 단위로 잡으려면 데이터 흐름 분석이 필요하고 그건 정적 문자열 스캔의 비용 곡선 밖이다.
 * 이 불변식의 1차 방어선은 여기가 아니라 런타임의 `assertStatusTransition()`(`lib/db.ts`) 과
 * 각 함수의 유닛 테스트이고, 이 스캔은 백스톱이다. 초록을 증명으로 읽지 말 것.
 */
function scanActiveStatus(files: SourceFile[]): ScanResult {
  const findings: Finding[] = [];
  let targets = 0;
  for (const file of files) {
    if (!/status:\s*['"`]active['"`]/.test(file.code)) continue;
    targets += 1;
    const provesChain = CHAIN_PROOFS.some((token) => file.code.includes(token));
    if (!provesChain) {
      findings.push(
        `${file.rel} sets status 'active' without a chain read — finalized 확인 없이 완료로 적으면 안 된다.`,
      );
    }
  }
  return { findings, targets };
}

const WRITE_METHODS = ['set', 'update', 'create', 'add'] as const;

/**
 * 펼치지 못한 페이로드 빌더는 통과가 아니다 — 그 한 줄 뒤에 무엇이 저장되는지 모르기 때문이다.
 * 단, Firestore 참조가 아닌 수신자(`Map.set`·`Set.add`·`cipher.update`)에는 걸지 않는다.
 */
function unresolvedFindings(site: CallSite, payload: Payload): Finding[] {
  if (!site.firestoreLike) return [];
  return payload.unresolved.map(
    (callee) =>
      `${site.file.rel}:${site.line} 의 페이로드가 헬퍼 호출 ${callee}(…) 로 만들어지는데 그 선언을 찾지 못했다 — 무엇이 저장되는지 확인할 수 없으므로 통과시키지 않는다.`,
  );
}
const TICKET_FIELDS = ['checkedIn', 'permissionBits', 'canApprove'];

/** 스펙 §10.4 규칙 3 — 입장·권한 필드는 Firestore 문서에 쓰지 않는다(초대장만 예외). */
function scanTicketFields(files: SourceFile[]): ScanResult {
  const writes = callSites(files, WRITE_METHODS);
  const findings: Finding[] = [];
  for (const site of writes) {
    const payload = payloadKeys(files, site);
    findings.push(...unresolvedFindings(site, payload));
    for (const field of TICKET_FIELDS) {
      // invites 컬렉션에만 허용된다(수락 전 임시 데이터, 체인에 쓰이면 삭제 대상).
      if (payload.keys.has(field) && site.file.rel !== INVITES_FILE) {
        findings.push(
          `${site.file.rel}:${site.line} stores "${field}" outside ${INVITES_FILE} — 입장·권한의 원본은 체인이다.`,
        );
      }
    }
  }
  return { findings, targets: writes.length };
}

/** viem 이 가스 한도를 우리 대신 정해 버리는 쓰기 API 전부. `sendAttesterTx` 만이 한도를 명시한다. */
const CHAIN_WRITE_CALLS = ['writeContract', 'sendTransaction', 'sendRawTransaction', 'deployContract'];

/** Monad 는 gas_limit 기준 과금이라 모든 체인 쓰기가 `sendAttesterTx` 를 지나야 한다. */
function scanGas(files: SourceFile[]): ScanResult {
  const findings: Finding[] = [];
  for (const file of files) {
    // 면제는 **정확히** lib/chain.ts 하나다. `fastchain.ts` 같은 이름이 끼어들 수 없다.
    if (file.rel === CHAIN_FILE) continue;
    const names = CHAIN_WRITE_CALLS.join('|');
    const direct = new RegExp(`\\b(?:${names})\\s*\\(|\\[\\s*['"](?:${names})['"]\\s*\\]`);
    const hit = direct.exec(file.code);
    if (hit !== null) {
      findings.push(
        `${file.rel} calls ${flatten(hit[0]).replace(/\s*\($/, '')} directly — 모든 쓰기는 가스 한도를 명시하는 sendAttesterTx 를 지나야 한다.`,
      );
    }
  }
  const chain = files.find((file) => file.rel === CHAIN_FILE);
  if (!chain) findings.push(`${CHAIN_FILE} 를 찾지 못했다 — 가스 규율을 확인할 수 없다.`);
  else if (!chain.code.includes('gas: gasLimitFor(estimate)')) {
    findings.push(`${CHAIN_FILE} 의 writeContract 가 gas 한도를 명시하지 않는다.`);
  }
  return { findings, targets: files.length };
}

// 번호는 HMAC(`phoneHmac`/`hmacPhone`/`phoneIndex`) 과 KMS 봉투(`phoneEnc`) 로만 저장한다.
const PLAINTEXT_PHONE_FIELDS = ['phone', 'phoneE164', 'phoneNumber'];

/** 스펙 §10.3 — 평문 번호는 Firestore 에 닿지 않는다. */
function scanPhone(files: SourceFile[]): ScanResult {
  const writes = callSites(files, WRITE_METHODS);
  const findings: Finding[] = [];
  for (const site of writes) {
    const payload = payloadKeys(files, site);
    findings.push(...unresolvedFindings(site, payload));
    for (const field of PLAINTEXT_PHONE_FIELDS) {
      if (payload.keys.has(field)) {
        findings.push(
          `${site.file.rel}:${site.line} 가 Firestore 페이로드에 평문 번호 필드 "${field}" 를 싣는다 — phoneHmac/phoneEnc/phoneIndex 만 허용된다.`,
        );
      }
    }
  }
  return { findings, targets: writes.length };
}

/**
 * 호출자 주소를 뜻하는 이름들. `gateAccount`·`recipient`·`value` 처럼 **대상** 주소를 받는
 * 인자는 금지가 아니다(그 주소로 인가하지 않고, 인가는 언제나 세션에서 나온 호출자 주소로 한다).
 */
const CALLER_FIELDS = ['account', 'address', 'owner', 'addr', 'wallet'];

/** 룰링 1(b) 음성 절 — 호출자 계정을 요청 본문에서 읽지 않는다. */
function scanRequestData(files: SourceFile[]): ScanResult {
  const findings: Finding[] = [];
  let targets = 0;

  // 핸들러 파라미터가 구조분해면(`onCall(({ data }) => …)`) 이 스캔이 볼 수 없다. 조용히 넘어가지 않는다.
  for (const callable of callables(files)) {
    if (callable.param === null) {
      findings.push(
        `${callable.file.rel}:${callable.line} 의 onCall 핸들러 파라미터 \`${callable.paramText}\` 가 구조분해라 요청 본문 읽기를 추적할 수 없다 — \`(request)\` 처럼 이름 있는 파라미터를 쓴다.`,
      );
    }
  }

  // 수신자를 **onCall 핸들러 파라미터**로 좁힌다. `request.data` 든 `req.data` 든 이름을 가리지 않되,
  // Firestore 스냅샷 `snap.data()` 나 HTTP 본문 `body.data` 를 요청 본문으로 오진하지 않는다.
  for (const file of files) {
    const receivers = requestReceivers(files, file);
    for (const m of file.code.matchAll(/\b([A-Za-z_$][\w$]*)\.data\b(?!\s*\()/g)) {
      if (m.index === undefined || m[1] === undefined || !receivers.has(m[1])) continue;
      targets += 1;
      const statement = statementAround(file.code, m.index);
      const line = lineOf(file.code, m.index);
      const names = namesReadBy(statement);
      for (const field of CALLER_FIELDS) {
        if (names.has(field)) {
          findings.push(
            `${file.rel}:${line} 가 ${m[1]}.data 에서 "${field}" 를 읽는다 — 호출자 계정은 resolveCallerAccount(request) 로만 정해진다.`,
          );
        }
      }
      // `const raw = request.data …` 뒤의 `raw.account` 처럼 별칭을 거쳐 읽는 경로.
      // 점·대괄호 접근과 **뒤따르는 구조분해**를 함께 보고, `const w = raw;` 로 한 번 더 넘긴 별칭까지 따라간다.
      const alias = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=/.exec(statement);
      if (!alias?.[1]) continue;
      for (const holder of aliasChain(file.code, alias[1])) {
        for (const field of CALLER_FIELDS) {
          if (readsField(file.code, holder, field)) {
            findings.push(
              `${file.rel}:${line} 가 요청 본문 별칭 "${holder}" 에서 "${field}" 를 읽는다 — 호출자 계정은 resolveCallerAccount(request) 로만 정해진다.`,
            );
          }
          if (destructuresField(file.code, holder, field)) {
            findings.push(
              `${file.rel}:${line} 가 요청 본문 별칭 "${holder}" 를 구조분해해 "${field}" 를 꺼낸다 — 호출자 계정은 resolveCallerAccount(request) 로만 정해진다.`,
            );
          }
        }
      }
    }
  }
  return { findings, targets };
}

/** 이 파일에서 "요청 본문"으로 볼 수신자 이름 — 이 파일 onCall 핸들러들의 파라미터 + 관례적 `request`. */
function requestReceivers(files: SourceFile[], file: SourceFile): Set<string> {
  const names = new Set<string>(['request']);
  for (const callable of callables(files)) {
    if (callable.file === file && callable.param !== null) names.add(callable.param);
  }
  return names;
}

/** `const w = body;` 처럼 한 번 더 넘긴 별칭까지 모은다. */
function aliasChain(code: string, root: string): Set<string> {
  const aliases = new Set([root]);
  for (let pass = 0; pass < 3; pass += 1) {
    for (const alias of [...aliases]) {
      const pattern = new RegExp(
        `\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*(?::[^=]*)?=\\s*${alias}\\b`,
        'g',
      );
      for (const m of code.matchAll(pattern)) if (m[1] !== undefined) aliases.add(m[1]);
    }
  }
  return aliases;
}

/** `body.account` 든 `body['account']` 든 같은 읽기다. */
function readsField(code: string, holder: string, field: string): boolean {
  return new RegExp(`\\b${holder}\\s*(?:\\.${field}\\b|\\[\\s*(['"])${field}\\1\\s*\\])`).test(code);
}

/**
 * `const { account } = body;` — 별칭을 **뒤에서 구조분해**하면 점·대괄호 접근이 없어
 * `readsField` 를 두 줄짜리 평범한 모양으로 빠져나간다. 이름을 바꿔 받는
 * `const { account: a } = body` 도, 기본값을 준 `const { account = '0x' } = body` 도 같은 읽기다.
 */
function destructuresField(code: string, holder: string, field: string): boolean {
  const pattern = new RegExp(`\\b(?:const|let|var)\\s*\\{([^}]*)\\}\\s*=\\s*${holder}\\b`, 'g');
  for (const m of code.matchAll(pattern)) {
    if (m[1] === undefined) continue;
    // 바인딩 이름이 아니라 **꺼내는 속성 이름**을 본다(`account: a` 면 `account`).
    for (const part of m[1].split(',')) {
      if (/^\s*([A-Za-z_$][\w$]*)/.exec(part)?.[1] === field) return true;
    }
  }
  return false;
}

/** 한 문장이 읽어 가는 이름 전부 — 구조분해 바인딩 · `as { … }` 타입 키 · 점/대괄호 속성 접근. */
function namesReadBy(statement: string): Set<string> {
  const names = new Set<string>();
  const destructured = /\b(?:const|let|var)\s*\{([^}]*)\}\s*=/.exec(statement);
  if (destructured?.[1] !== undefined) {
    for (const part of destructured[1].split(',')) {
      const name = /^\s*([A-Za-z_$][\w$]*)/.exec(part);
      if (name?.[1] !== undefined) names.add(name[1]);
    }
  }
  for (const m of statement.matchAll(/[{;,]\s*([A-Za-z_$][\w$]*)\s*\??\s*:/g)) {
    if (m[1] !== undefined) names.add(m[1]);
  }
  for (const m of statement.matchAll(/\.([A-Za-z_$][\w$]*)/g)) {
    if (m[1] !== undefined) names.add(m[1]);
  }
  for (const m of statement.matchAll(/\[\s*(['"])([A-Za-z_$][\w$]*)\1\s*\]/g)) {
    if (m[2] !== undefined) names.add(m[2]);
  }
  return names;
}

/** `Organizers` 권한 질의 — 주소를 넘겨 "이 사람이 할 수 있나"를 묻는 on-chain 인가 표면. */
const PERMISSION_QUERIES = ['hasPermission', 'managerOf', 'ownerOf'];

/** 룰링 1(b) 양성 절 — 주소로 인가하는 callable 은 호출자를 세션에서 가져와야 한다. */
function scanCallerAuthorization(files: SourceFile[]): ScanResult {
  const helpers = authHelpers(files);
  const findings: Finding[] = [];
  const all = callables(files);
  let targets = 0;
  for (const callable of all) {
    const guards = localAddressGuards(callable.file);
    const authorizing = [
      // lib/auth.ts 가 내보내는 인가 함수(목록이 모듈에서 온다 — 새 헬퍼가 생겨도 따라온다).
      ...[...helpers].filter((name) => new RegExp(`\\b${name}\\s*\\(`).test(callable.body)),
      // 파일 지역 인가 헬퍼(`requireOrganizer` 꼴 + 주소 인자).
      ...[...guards].filter((name) => new RegExp(`\\b${name}\\s*\\(`).test(callable.body)),
      // 체인 권한 질의. 따옴표 종류를 가리지 않는다.
      ...PERMISSION_QUERIES.filter((name) =>
        new RegExp(`functionName:\\s*['"\`]${name}['"\`]`).test(callable.body),
      ),
    ];
    if (authorizing.length === 0) continue;
    targets += 1;
    if (!/resolveCallerAccount\(\s*request\s*\)/.test(callable.body)) {
      findings.push(
        `${callable.file.rel}:${callable.line} 의 callable 은 ${authorizing.join(', ')} 로 주소 인가를 하면서 resolveCallerAccount(request) 를 쓰지 않는다 — 호출자 주소가 요청 본문에서 올 수 있다.`,
      );
    }
  }
  return { findings, targets };
}

// ──────────────────────────── 복합 질의 ↔ firestore.indexes.json

const INDEX_FILE = 'firestore.indexes.json';
/** 한 값에 못 박는 연산자 — 색인에서 언제나 앞자리다. `in`·`array-contains` 도 모양은 등식이다. */
const EQUALITY_OPS = ['==', 'in', 'array-contains'];
/** 범위 연산자 — 색인에서 마지막 자리다. 다른 필드가 하나라도 더 있으면 복합 색인이 필요하다. */
const INEQUALITY_OPS = ['<', '<=', '>', '>=', '!=', 'not-in'];
/** 질의 체인의 머리. `.doc()` 는 질의가 아니라 문서 하나라 여기 없다. */
const QUERY_ROOTS = ['collectionGroup', 'collection'] as const;

interface IndexField {
  fieldPath: string;
  /** 질의가 방향을 말하지 않으면 `null` — 그때는 색인 방향을 따지지 않는다. */
  order: 'ASCENDING' | 'DESCENDING' | null;
}

interface IndexEntry {
  collectionGroup: string;
  fields: IndexField[];
}

/** `firestore.indexes.json` 의 `indexes` 배열만 읽는다. `fieldOverrides` 는 복합 색인이 아니다. */
function parseIndexes(text: string): IndexEntry[] {
  const parsed = JSON.parse(text) as {
    indexes?: Array<{ collectionGroup?: string; fields?: Array<{ fieldPath?: string; order?: string }> }>;
  };
  return (parsed.indexes ?? []).map((index) => ({
    collectionGroup: index.collectionGroup ?? '',
    fields: (index.fields ?? []).map((field) => ({
      fieldPath: field.fieldPath ?? '',
      order:
        field.order === 'DESCENDING' ? 'DESCENDING' : field.order === 'ASCENDING' ? 'ASCENDING' : null,
    })),
  }));
}

interface WhereClause {
  field: string;
  op: string;
}

interface OrderClause {
  field: string;
  direction: 'ASCENDING' | 'DESCENDING' | null;
}

interface QueryChain {
  file: SourceFile;
  line: number;
  /** 색인의 `collectionGroup` 과 맞댈 이름 — 경로의 마지막 조각. */
  collection: string;
  wheres: WhereClause[];
  orders: OrderClause[];
  /** 리터럴·상수로 풀리지 않은 인자 원문. 조용히 넘기지 않고 실패로 보고한다. */
  unresolved: string[];
}

interface ChainStep {
  name: string;
  args: string[];
}

/** `open` 의 `(` 에 대응하는 `)` **다음** 인덱스. `readArgs` 가 잘라 준 길이에서 바로 나온다. */
function argsEnd(open: number, args: string): number {
  return open + args.length + 2;
}

/**
 * `.collection(x)` 뒤로 이어지는 체인을 따라간다. 줄바꿈·들여쓰기와 무관하고,
 * 새 경로(`.doc`/`.collection`)가 시작되면 거기서 끊는다 — 그 호출은 제 체인의 머리로 다시 잡힌다.
 */
function chainAfter(code: string, from: number): ChainStep[] {
  const steps: ChainStep[] = [];
  let i = from;
  for (;;) {
    const next = /^\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/.exec(code.slice(i, i + 200));
    const name = next?.[1];
    if (next === null || name === undefined) break;
    if ((PATH_METHODS as readonly string[]).includes(name)) break;
    const open = i + next[0].length - 1;
    const args = readArgs(code, open);
    if (args === null) break;
    steps.push({ name, args: splitArgs(args) });
    i = argsEnd(open, args);
  }
  return steps;
}

/** `.orderBy(f, 'desc')` 의 둘째 인자 → 색인 파일이 쓰는 표기. 빠지면 오름차순이 기본이다. */
function orderDirection(raw: string): 'ASCENDING' | 'DESCENDING' {
  return /^desc/i.test(raw) ? 'DESCENDING' : 'ASCENDING';
}

/** 소스의 Firestore 질의 — `where`/`orderBy` 가 하나라도 붙은 체인만 모은다. */
function queryChains(files: SourceFile[]): QueryChain[] {
  const out: QueryChain[] = [];
  const pattern = new RegExp(`\\.(${QUERY_ROOTS.join('|')})\\s*\\(`, 'g');
  for (const file of files) {
    pattern.lastIndex = 0;
    let match = pattern.exec(file.code);
    while (match !== null) {
      const open = file.code.indexOf('(', match.index);
      const args = readArgs(file.code, open);
      if (args !== null) {
        const steps = chainAfter(file.code, argsEnd(open, args));
        const wheres = steps.filter((step) => step.name === 'where');
        const orders = steps.filter((step) => step.name === 'orderBy');
        if (wheres.length > 0 || orders.length > 0) {
          const unresolved: string[] = [];
          // 컬렉션도 필드도 연산자도 `db.ts` 상수·리터럴·템플릿으로 온다. 같은 기계로 푼다.
          const literal = (raw: string): string => {
            const value = resolvePath(files, file, raw);
            if (value === null) {
              unresolved.push(flatten(raw));
              return '';
            }
            return value;
          };
          const rawCollection = splitArgs(args)[0] ?? '';
          const segments = literal(rawCollection).split('/');
          const collection = segments[segments.length - 1] ?? '';
          if (collection === '*') unresolved.push(flatten(rawCollection));
          out.push({
            file,
            line: lineOf(file.code, match.index),
            collection,
            wheres: wheres.map((step) => ({
              field: literal(step.args[0] ?? ''),
              op: literal(step.args[1] ?? ''),
            })),
            orders: orders.map((step) => {
              const raw = step.args[1];
              return {
                field: literal(step.args[0] ?? ''),
                direction: raw === undefined ? null : orderDirection(literal(raw)),
              };
            }),
            unresolved,
          });
        }
      }
      match = pattern.exec(file.code);
    }
  }
  return out;
}

interface RequiredIndex {
  collection: string;
  /** 등식 필드 — 색인 앞자리. 자기들끼리의 순서는 질의를 받는 데 영향이 없다. */
  equality: string[];
  /** 범위·정렬 필드 — 색인 뒷자리. 순서가 그대로 맞아야 하고, 질의가 방향을 말했으면 방향도 맞아야 한다. */
  tail: IndexField[];
}

/**
 * 이 질의가 복합 색인을 요구하는가, 요구한다면 어떤 모양인가.
 *  1. `where` 하나 이상 + `orderBy` 하나 이상 + 그 필드가 둘 이상
 *  2. 범위 연산자 하나 이상 + 다른 필드가 하나라도 더 있음(다른 `where` 든 `orderBy` 든)
 * 등식만 쓰고 `orderBy` 가 없으면 Firestore 가 단일 필드 색인을 합쳐 받으므로 필요 없다.
 * 1번의 `distinct >= 2` 가 빼 주는 것은 하나뿐이다 — 정렬 필드가 `where` 필드와 **같은** 경우
 * (`where('status','==',x).orderBy('status')`). 그건 실제로 단일 필드 색인으로 받는다.
 */
function requiredIndex(chain: QueryChain): RequiredIndex | null {
  const inequalities = chain.wheres.filter((clause) => INEQUALITY_OPS.includes(clause.op));
  const orderFields = chain.orders.map((clause) => clause.field);
  const distinct = new Set([...chain.wheres.map((clause) => clause.field), ...orderFields]);
  const needed =
    (chain.wheres.length >= 1 && chain.orders.length >= 1 && distinct.size >= 2) ||
    (inequalities.length >= 1 && distinct.size >= 2);
  if (!needed) return null;

  const tail: IndexField[] = [];
  const push = (fieldPath: string, order: IndexField['order']): void => {
    if (!tail.some((field) => field.fieldPath === fieldPath)) tail.push({ fieldPath, order });
  };
  // 범위 필드가 먼저, 그다음 정렬 필드를 쓰인 순서 그대로.
  for (const clause of inequalities) if (!orderFields.includes(clause.field)) push(clause.field, null);
  for (const clause of chain.orders) push(clause.field, clause.direction);

  const equality = [
    ...new Set(chain.wheres.filter((c) => EQUALITY_OPS.includes(c.op)).map((c) => c.field)),
  ];
  return {
    collection: chain.collection,
    equality: equality.filter((field) => !tail.some((entry) => entry.fieldPath === field)),
    tail,
  };
}

/** 등식 필드가 앞, 범위·정렬 필드가 뒤. 앞자리는 집합으로, 뒷자리는 순서·방향까지 맞춰 본다. */
function indexMatches(index: IndexEntry, required: RequiredIndex): boolean {
  if (index.collectionGroup !== required.collection) return false;
  if (index.fields.length !== required.equality.length + required.tail.length) return false;
  const head = index.fields.slice(0, required.equality.length).map((field) => field.fieldPath);
  if ([...head].sort().join('\u0000') !== [...required.equality].sort().join('\u0000')) return false;
  return required.tail.every((want, at) => {
    const got = index.fields[required.equality.length + at];
    if (got === undefined || got.fieldPath !== want.fieldPath) return false;
    return want.order === null || got.order === want.order;
  });
}

/** 실패 메시지에 그대로 붙여 넣을 수 있는 색인 항목. */
function indexJson(required: RequiredIndex): string {
  return JSON.stringify({
    collectionGroup: required.collection,
    queryScope: 'COLLECTION',
    fields: [
      ...required.equality.map((fieldPath) => ({ fieldPath, order: 'ASCENDING' })),
      ...required.tail.map((field) => ({ fieldPath: field.fieldPath, order: field.order ?? 'ASCENDING' })),
    ],
  });
}

/**
 * 복합 질의마다 `firestore.indexes.json` 에 대응 색인이 있는지 본다. 없으면
 * **넣어야 할 항목을 그대로 찍어** 실패한다 — 지금까지 유일한 신호는 운영에서 터지는
 * `FAILED_PRECONDITION` 이었다(task-C3 리뷰 Minor 3). 쓰이지 않는 색인은 문제 삼지 않는다.
 *
 * **한계**: 한 식에서 이어 붙인 체인만 본다. `let q = …; if (c) q = q.where(…)` 처럼
 * 조각내 만들면 놓친다 — 데이터 흐름 분석이 필요하고 정적 문자열 스캔의 비용 곡선 밖이다.
 */
function scanQueryIndexes(files: SourceFile[], indexes: IndexEntry[] = []): ScanResult {
  const chains = queryChains(files);
  const findings: Finding[] = [];
  for (const chain of chains) {
    const where = `${chain.file.rel}:${chain.line}`;
    if (chain.unresolved.length > 0) {
      findings.push(
        `${where} 의 질의에서 \`${chain.unresolved.join('`, `')}\` 를 해석하지 못했다 — 컬렉션·필드·연산자가 리터럴이나 상수가 아니면 복합 색인과 대조할 수 없다.`,
      );
      continue;
    }
    const unknown = chain.wheres
      .map((clause) => clause.op)
      .filter((op) => !EQUALITY_OPS.includes(op) && !INEQUALITY_OPS.includes(op));
    if (unknown.length > 0) {
      findings.push(
        `${where} 의 질의가 모르는 연산자 "${unknown.join('", "')}" 를 쓴다 — EQUALITY_OPS/INEQUALITY_OPS 에 넣어야 색인 요건을 판정할 수 있다.`,
      );
      continue;
    }
    const required = requiredIndex(chain);
    if (required === null) continue;
    if (indexes.some((index) => indexMatches(index, required))) continue;
    findings.push(
      `${where} 의 복합 질의에 맞는 색인이 ${INDEX_FILE} 에 없다 — indexes 배열에 이 항목을 넣어야 한다: ${indexJson(required)}`,
    );
  }
  return { findings, targets: chains.length };
}

// ───────────────────────────────────────────────────────────── 진짜 소스 트리

let FILES: SourceFile[] = [];
let INDEXES: IndexEntry[] = [];
/** 모든 실패 메시지에 붙는다 — 어떤 파일들을 봤는지 말하지 않는 스캔은 믿을 수 없다. */
let INVENTORY = '';

beforeAll(async () => {
  const paths = await sourcePaths(SRC);
  FILES = await Promise.all(
    paths.map(async (path) => makeSource(relative(SRC, path), await readFile(path, 'utf8'))),
  );
  INDEXES = parseIndexes(await readFile(INDEX_PATH, 'utf8'));
  INVENTORY = `scanned ${FILES.length} files under ${SRC}: ${FILES.map((f) => f.rel).join(', ')}`;
});

/**
 * 진짜 소스 트리에 스캔을 돌린다. 세 가지를 한꺼번에 강제한다.
 *  1. 파일 집합이 비면 실패(디렉터리가 옮겨져도 조용히 통과하지 않는다).
 *  2. 스캔 대상 집합이 비면 실패(코드 모양이 바뀌어 스캔이 헛도는 것도 통과가 아니다).
 *  3. 위반 목록이 비어야 한다.
 */
function expectClean(scan: (files: SourceFile[]) => ScanResult): void {
  expect(
    FILES.length,
    `정적 스캔이 소스를 하나도 찾지 못했다 — ${SRC} 가 옮겨졌거나 비었다. 통과가 아니라 실패다.`,
  ).toBeGreaterThan(0);
  const result = scan(FILES);
  expect(result.targets, `스캔이 들여다본 대상이 0이다 — 코드 모양을 놓치고 있다. ${INVENTORY}`).toBeGreaterThan(0);
  expect(result.findings, INVENTORY).toEqual([]);
}

describe('spec §10.4 rule 1 — no chain state in Firestore', () => {
  it('only touches collections on the allowlist', () => expectClean(scanAllowlist));
  it('never names a ticket, role or check-in collection anywhere', () => expectClean(scanForbiddenNames));
});

describe('design §3 — the retired 4337/paymaster/pre-deploy path leaves no symbol behind', () => {
  it('no source file mentions a paymaster, bundler, EntryPoint, sponsored op or account pre-deploy', () =>
    expectClean(scanForbidden4337));
});

describe('spec §10.4 rule 3 — active only after chain confirmation', () => {
  it("every file that sets status 'active' also proves it read the chain", () => expectClean(scanActiveStatus));
  it('never sets a paid-looking ticket or permission field on a Firestore document', () =>
    expectClean(scanTicketFields));
});

describe('gas discipline', () => {
  it('every chain write goes through sendAttesterTx, which always sets gas', () => expectClean(scanGas));
});

describe('spec §10.3 — a phone number never lands in Firestore as plaintext', () => {
  it('no Firestore write payload carries a plaintext phone field', () => expectClean(scanPhone));
});

describe('caller identity — the account comes from the session, never from the request body', () => {
  it('never reads an account, address or owner field out of the request body', () =>
    expectClean(scanRequestData));
  it('every callable that authorizes by address resolves the caller with resolveCallerAccount(request)', () =>
    expectClean(scanCallerAuthorization));
});

describe('composite indexes — every multi-field query is backed by firestore.indexes.json', () => {
  it('no query needs a composite index that the index file does not declare', () => {
    expect(
      INDEXES.length,
      `${INDEX_FILE} 에서 색인을 하나도 읽지 못했다 — 파일이 옮겨졌거나 비었다. 통과가 아니라 실패다.`,
    ).toBeGreaterThan(0);
    expectClean((files) => scanQueryIndexes(files, INDEXES));
  });
});

// ───────────────────────────────────────────────────────────── 음성 픽스처

/**
 * 리뷰가 실제로 스캔을 통과시킨 **아홉 가지 회피 수법**이다. 진짜 트리가 아니라 메모리 상
 * 소스 문자열에 스캔을 돌려, 각각이 제 스캔에서 빨간불로 잡히는지 확인한다. 이게 없으면
 * "녹색"은 "위반이 없다"가 아니라 "스캔이 아무것도 못 본다"와 구별되지 않는다.
 */
function fixture(...pairs: Array<[string, string]>): SourceFile[] {
  return pairs.map(([rel, text]) => makeSource(rel, text));
}

/** 픽스처가 스캔을 통과하면 그 스캔은 가드가 아니다. */
function expectCaught(result: ScanResult, expected: RegExp): void {
  expect(result.findings.join('\n'), `잡히지 않았다 — 위반이 스캔을 통과했다`).toMatch(expected);
}

describe('negative fixtures — every way a violation has slipped past, locked one by one', () => {
  it('1. a forbidden path hidden in a variable, then handed to .doc()', () => {
    const files = fixture([
      join('functions', 'evade.ts'),
      `import { db } from '../lib/db.js';
       export async function evade(id: string, c: string) {
         const ticketPath = \`tickets/\${id}/checkIns/\${c}\`;
         return db.doc(ticketPath).get();
       }`,
    ]);
    expectCaught(scanAllowlist(files), /tickets/);
    expectCaught(scanForbiddenNames(files), /forbidden collection "tickets"/);
  });

  it('2. a ticket and phone payload written with .add() instead of .set()', () => {
    const files = fixture([
      join('functions', 'evade.ts'),
      `import { PERSONS, db } from '../lib/db.js';
       export async function evade() {
         await db.collection(PERSONS).add({ checkedIn: true, phone: '01012345678' });
       }`,
    ]);
    expectCaught(scanTicketFields(files), /stores "checkedIn"/);
    expectCaught(scanPhone(files), /"phone"/);
  });

  it('3. quoted and computed object keys', () => {
    const files = fixture([
      join('functions', 'evade.ts'),
      `import { PERSONS, db } from '../lib/db.js';
       export async function evade() {
         await db.collection(PERSONS).doc('x').set({ 'checkedIn': true, ['phone']: '01012345678' });
       }`,
    ]);
    expectCaught(scanTicketFields(files), /stores "checkedIn"/);
    expectCaught(scanPhone(files), /"phone"/);
  });

  it('4. the payload spread in from a helper in another file', () => {
    const files = fixture(
      [
        join('lib', 'pii.ts'),
        `export function buildPii(phone: string) {
           return { phone, checkedIn: true };
         }`,
      ],
      [
        join('functions', 'evade.ts'),
        `import { PERSONS, db } from '../lib/db.js';
         import { buildPii } from '../lib/pii.js';
         export async function evade() {
           await db.collection(PERSONS).doc('x').set({ ...buildPii('01012345678') });
         }`,
      ],
    );
    expectCaught(scanTicketFields(files), /stores "checkedIn"/);
    expectCaught(scanPhone(files), /"phone"/);
  });

  it('5. the handler parameter is named req, not request', () => {
    const files = fixture([
      join('functions', 'evade.ts'),
      `import { onCall } from 'firebase-functions/v2/https';
       export const evade = onCall(async (req) => {
         const { account } = req.data as { account?: string };
         return { account };
       });`,
    ]);
    expectCaught(scanRequestData(files), /"account"/);
  });

  it('6. two statements on one line', () => {
    const files = fixture([
      join('functions', 'evade.ts'),
      `import { onCall } from 'firebase-functions/v2/https';
       export const evade = onCall(async (request) => {
         const noop = 1; const { account } = request.data as { account?: string };
         return { noop, account };
       });`,
    ]);
    expectCaught(scanRequestData(files), /"account"/);
  });

  it('7. a declaration wrapped across lines', () => {
    const files = fixture([
      join('functions', 'evade.ts'),
      `import { onCall } from 'firebase-functions/v2/https';
       interface Body { account?: string }
       export const evade = onCall(async (request) => {
         const { account } =
           (request.data ?? {}) as Body;
         return { account };
       });`,
    ]);
    expectCaught(scanRequestData(files), /"account"/);
  });

  it('8. a direct chain write from a file whose name merely ends in chain.ts', () => {
    const files = fixture(
      [CHAIN_FILE, `export function send() { return walletClient().writeContract({ gas: gasLimitFor(estimate) }); }`],
      [
        join('lib', 'fastchain.ts'),
        `import { walletClient } from './chain.js';
         export async function fast() {
           return walletClient().writeContract({ address: '0x', abi: [], functionName: 'x', args: [] });
         }`,
      ],
    );
    expectCaught(scanGas(files), /fastchain\.ts calls writeContract/);
  });

  it('9. a brand-new authorization helper taking the address straight from the request body', () => {
    const files = fixture(
      [
        AUTH_FILE,
        `export async function resolveCallerAccount(request: CallableRequest): Promise<Hex> { return '0x' as Hex; }
         export async function requireStaffForGate(eventId: bigint, caller: Hex, gate: Hex): Promise<void> {}`,
      ],
      [
        join('functions', 'evade.ts'),
        `import { onCall } from 'firebase-functions/v2/https';
         async function requireAdminByAddress(orgId: bigint, addr: Hex): Promise<void> {
           await publicClient().readContract({ abi: organizersAbi, functionName: 'isAdmin', args: [orgId, addr] });
         }
         export const evade = onCall(async (request) => {
           const { addr } = request.data as { addr?: Hex };
           await requireAdminByAddress(1n, addr as Hex);
           return { ok: true };
         });`,
      ],
    );
    expectCaught(scanCallerAuthorization(files), /requireAdminByAddress/);
    expectCaught(scanRequestData(files), /"addr"/);
  });

  it('a destructured onCall parameter is reported, not silently skipped', () => {
    const files = fixture([
      join('functions', 'evade.ts'),
      `import { onCall } from 'firebase-functions/v2/https';
       export const evade = onCall(async ({ data }) => ({ account: (data as { account?: string }).account }));`,
    ]);
    expectCaught(scanRequestData(files), /구조분해라 요청 본문 읽기를 추적할 수 없다/);
  });

  it('10. the payload built by a helper CALL in the same file', () => {
    const files = fixture([
      join('functions', 'evade.ts'),
      `import { PERSONS, db } from '../lib/db.js';
       const buildPersonDoc = (p: string) => ({ phone: p, checkedIn: true, permissionBits: 7 });
       export async function evade() {
         await db.collection(PERSONS).doc('x').set(buildPersonDoc('01012345678'));
       }`,
    ]);
    expectCaught(scanTicketFields(files), /stores "checkedIn"/);
    expectCaught(scanPhone(files), /"phone"/);
  });

  it('11. the payload built by a helper CALL exported from another file', () => {
    const files = fixture(
      [
        join('lib', 'docs.ts'),
        `export const buildPersonDoc = (p: string) => ({ phone: p, canApprove: true });
         export function buildOther(p: string) { return { phoneE164: p }; }`,
      ],
      [
        join('functions', 'evade.ts'),
        `import { PERSONS, db } from '../lib/db.js';
         import { buildOther, buildPersonDoc } from '../lib/docs.js';
         export async function evade() {
           await db.collection(PERSONS).doc('x').set(buildPersonDoc('01012345678'));
           await db.collection(PERSONS).doc('y').set(buildOther('01012345678'));
         }`,
      ],
    );
    expectCaught(scanTicketFields(files), /stores "canApprove"/);
    expectCaught(scanPhone(files), /"phone"/);
    expectCaught(scanPhone(files), /"phoneE164"/);
  });

  it('12. a payload helper the scan cannot find is reported, not waved through', () => {
    const files = fixture([
      join('functions', 'evade.ts'),
      `import { PERSONS, db } from '../lib/db.js';
       import { buildFromNowhere } from 'some-package';
       export async function evade() {
         await db.collection(PERSONS).doc('x').set(buildFromNowhere('01012345678'));
       }`,
    ]);
    expectCaught(scanPhone(files), /헬퍼 호출 buildFromNowhere\(…\) 로 만들어지는데 그 선언을 찾지 못했다/);
    expectCaught(scanTicketFields(files), /buildFromNowhere/);
  });

  it('13. the request body read through bracket access', () => {
    const files = fixture([
      join('functions', 'evade.ts'),
      `import { onCall } from 'firebase-functions/v2/https';
       export const evade = onCall(async (request) => {
         const body = request.data as Body;
         const caller = body['account'] as Hex;
         return { caller };
       });`,
    ]);
    expectCaught(scanRequestData(files), /별칭 "body" 에서 "account"/);
  });

  it('14. the request body read through a second alias hop', () => {
    const files = fixture([
      join('functions', 'evade.ts'),
      `import { onCall } from 'firebase-functions/v2/https';
       export const evade = onCall(async (request) => {
         const body = request.data as Body;
         const w = body;
         return { caller: w.account };
       });`,
    ]);
    expectCaught(scanRequestData(files), /별칭 "w" 에서 "account"/);
  });

  it('15. a Firestore snapshot .data() is not mistaken for the request body', () => {
    const files = fixture([
      join('functions', 'reader.ts'),
      `import { onCall } from 'firebase-functions/v2/https';
       import { PERSONS, db } from '../lib/db.js';
       export const read = onCall(async (request) => {
         const snap = await db.collection(PERSONS).doc('x').get();
         const row = snap.data() as { owner?: string };
         return { owner: row.owner };
       });`,
    ]);
    expect(scanRequestData(files).findings, 'snap.data() 를 요청 본문으로 오진했다').toEqual([]);
  });

  it('16. the request body destructured off an alias, in two ordinary lines', () => {
    const files = fixture([
      join('functions', 'evade.ts'),
      `import { onCall } from 'firebase-functions/v2/https';
       export const evade = onCall(async (request) => {
         const body = request.data as Body;
         const { account: caller } = body;
         return { caller };
       });`,
    ]);
    expectCaught(scanRequestData(files), /별칭 "body" 를 구조분해해 "account"/);
  });

  it('17. a Firestore reference parked in a variable, then written through', () => {
    const files = fixture([
      join('functions', 'evade.ts'),
      `import { PERSONS, db } from '../lib/db.js';
       import { buildDoc } from 'some-package';
       export async function evade(id: string, phone: string) {
         const target = db.collection(PERSONS).doc(id);
         await target.set(buildDoc(phone));
       }`,
    ]);
    expectCaught(scanPhone(files), /헬퍼 호출 buildDoc\(…\) 로 만들어지는데 그 선언을 찾지 못했다/);
    expectCaught(scanTicketFields(files), /buildDoc/);
  });

  it('18. a transaction write whose callback parameter is not named tx', () => {
    const files = fixture([
      join('functions', 'evade.ts'),
      `import { PERSONS, db } from '../lib/db.js';
       import { buildDoc } from 'some-package';
       export async function evade(id: string, phone: string) {
         const ref = db.collection(PERSONS).doc(id);
         await db.runTransaction(async (t) => {
           t.set(ref, buildDoc(phone));
         });
       }`,
    ]);
    expectCaught(scanPhone(files), /헬퍼 호출 buildDoc\(…\)/);
  });

  it('19. a Map receiver is still not a Firestore write', () => {
    // 이 게이트가 있는 이유다(`functions/snapshot.ts` 의 닉네임 표). 여기가 빨개지면 사람이 가드를 끈다.
    const files = fixture([
      join('functions', 'cache.ts'),
      `import { getAddress } from 'viem';
       export function cache(rows: Array<{ owner: string }>) {
         const nicknames = new Map<string, string>();
         for (const row of rows) nicknames.set(getAddress(row.owner), '');
         return nicknames;
       }`,
    ]);
    expect(scanPhone(files).findings, 'Map.set 을 Firestore 쓰기로 오진했다').toEqual([]);
    expect(scanTicketFields(files).findings, 'Map.set 을 Firestore 쓰기로 오진했다').toEqual([]);
  });

  /** 픽스처 20~22 가 쓰는 색인 목록 — 진짜 파일의 일부를 본뜬 것. */
  const INDEX_FIXTURE: IndexEntry[] = [
    {
      collectionGroup: 'persons',
      fields: [
        { fieldPath: 'status', order: 'ASCENDING' },
        { fieldPath: 'updatedAt', order: 'ASCENDING' },
      ],
    },
    {
      collectionGroup: 'pendingGates',
      fields: [
        { fieldPath: 'eventId', order: 'ASCENDING' },
        { fieldPath: 'status', order: 'ASCENDING' },
        { fieldPath: 'createdAt', order: 'DESCENDING' },
      ],
    },
  ];

  it('20. a composite query with no matching index spells the index out', () => {
    const files = fixture([
      join('functions', 'evade.ts'),
      `import { PERSONS, db } from '../lib/db.js';
       export async function evade(cutoff: number) {
         return db
           .collection(PERSONS)
           .where('status', '==', 'pending')
           .where('createdAt', '<', cutoff)
           .limit(50)
           .get();
       }`,
    ]);
    expectCaught(scanQueryIndexes(files, INDEX_FIXTURE), /복합 질의에 맞는 색인이 firestore\.indexes\.json 에 없다/);
    // 실패 메시지가 **붙여 넣을 수 있는 항목**을 통째로 찍는다. 이게 없으면 사람이 다시 추측해야 한다.
    expectCaught(
      scanQueryIndexes(files, INDEX_FIXTURE),
      /\{"collectionGroup":"persons","queryScope":"COLLECTION","fields":\[\{"fieldPath":"status","order":"ASCENDING"\},\{"fieldPath":"createdAt","order":"ASCENDING"\}\]\}/,
    );
  });

  it('21. an index that exists, and an equality-only query that needs none, stay green', () => {
    const files = fixture([
      join('functions', 'ok.ts'),
      `import { PENDING_GATES, PERSONS, TRANSFER_INVITES, db } from '../lib/db.js';
       export async function sweep(cutoff: number, eventId: string, hmac: string) {
         await db.collection(PERSONS).where('status', 'in', ['pending']).where('updatedAt', '<', cutoff).get();
         await db
           .collection(PENDING_GATES)
           .where('eventId', '==', eventId)
           .where('status', '==', 'pending')
           .orderBy('createdAt', 'desc')
           .limit(10)
           .get();
         await db.collection(TRANSFER_INVITES).where('hmacPhone', '==', hmac).where('status', '==', 'sent').get();
       }`,
    ]);
    const result = scanQueryIndexes(files, INDEX_FIXTURE);
    expect(result.findings, '있는 색인을 없다고 했거나, 필요 없는 색인을 요구했다').toEqual([]);
    expect(result.targets, '질의 세 개를 다 보지 못했다').toBe(3);
  });

  it('23. one equality plus an orderBy on another field still needs a composite index', () => {
    // Firestore 는 `where('status','==',x).orderBy('createdAt')` 에도 복합 색인을 요구한다.
    const files = fixture([
      join('functions', 'evade.ts'),
      `import { PERSONS, db } from '../lib/db.js';
       export async function evade() {
         return db.collection(PERSONS).where('status', '==', 'pending').orderBy('createdAt', 'desc').limit(50).get();
       }`,
    ]);
    expectCaught(
      scanQueryIndexes(files, INDEX_FIXTURE),
      /\{"collectionGroup":"persons","queryScope":"COLLECTION","fields":\[\{"fieldPath":"status","order":"ASCENDING"\},\{"fieldPath":"createdAt","order":"DESCENDING"\}\]\}/,
    );

    // 정렬 필드가 `where` 필드와 **같으면** 단일 필드 색인으로 받는다 — 여기까지 요구하면 거짓 양성이다.
    const sameField = fixture([
      join('functions', 'ok.ts'),
      `import { PERSONS, db } from '../lib/db.js';
       export async function recent() {
         return db.collection(PERSONS).where('status', '==', 'pending').orderBy('status').limit(50).get();
       }`,
    ]);
    expect(
      scanQueryIndexes(sameField, INDEX_FIXTURE).findings,
      '같은 필드로 정렬하는 질의에 색인을 요구했다',
    ).toEqual([]);
  });

  it('22. a query whose collection cannot be resolved is reported, not waved through', () => {
    const files = fixture([
      join('functions', 'evade.ts'),
      `import { db } from '../lib/db.js';
       export async function evade(which: string, cutoff: number) {
         return db.collection(which).where('status', '==', 'x').where('createdAt', '<', cutoff).get();
       }`,
    ]);
    expectCaught(scanQueryIndexes(files, INDEX_FIXTURE), /를 해석하지 못했다 — 컬렉션·필드·연산자가/);
  });

  it('24. a resurrected pre-deploy or paymaster symbol is caught', () => {
    const files = fixture([
      join('lib', 'evade.ts'),
      `import { deployment } from './chain.js';
       export async function evade() {
         await predeployAccount({ account: '0x' });
         return deployment().paymaster;
       }`,
    ]);
    expectCaught(scanForbidden4337(files), /predeployAccount/);
    expectCaught(scanForbidden4337(files), /paymaster/);
  });

  it('an emptied source tree fails every scan instead of passing vacuously', () => {
    const empty: SourceFile[] = [];
    for (const scan of [
      scanAllowlist,
      scanForbiddenNames,
      scanActiveStatus,
      scanTicketFields,
      scanPhone,
      scanRequestData,
      scanCallerAuthorization,
      scanQueryIndexes,
    ]) {
      expect(scan(empty).targets, `${scan.name} 이 빈 트리에서 대상 0을 통과시킨다`).toBe(0);
    }
    // 가스 스캔만은 파일 수가 아니라 chain.ts 의 존재로 큰소리를 낸다.
    expect(scanGas(empty).findings.join('\n')).toMatch(/chain\.ts 를 찾지 못했다/);
  });
});
