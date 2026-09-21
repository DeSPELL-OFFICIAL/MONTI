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
 * **스캔은 전부 순수 함수다.** 진짜 소스 트리(초록이어야 한다)와, 아래 `negative fixtures`
 * 의 메모리 상 위반 소스(각각 빨간불이어야 한다)에 같은 함수를 돌린다. 녹색인 스캔은
 * 그 자체로는 아무것도 증명하지 못하기 때문이다.
 */

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const ALLOWED: readonly string[] = dbModule.ALLOWED_COLLECTIONS;

/** `db.ts` 가 내보내는 문자열 상수 전부. 이름→값 표가 모듈에서 오므로 표가 따로 늙지 않는다. */
const COLLECTION_CONSTANTS = new Map<string, string>(
  Object.entries(dbModule).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
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

const FIRESTORE_RECEIVERS = [
  /(?:\.doc|\.collection|\.collectionGroup)\s*\([^()]*\)\s*$/,
  /(?:^|[^\w$.])(?:tx|transaction|batch)\s*$/,
  /[\w$]*[Rr]ef\s*$/,
];

/** 주어진 메서드 호출을 전부 찾아 균형 잡힌 인자와 함께 돌려준다. */
function callSites(files: SourceFile[], names: readonly string[]): CallSite[] {
  const pattern = new RegExp(`\\.(${names.join('|')})\\s*\\(`, 'g');
  const out: CallSite[] = [];
  for (const file of files) {
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
          firestoreLike: FIRESTORE_RECEIVERS.some((pattern) => pattern.test(prefix)),
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
      // 점 접근과 대괄호 접근을 함께 보고, `const w = raw;` 처럼 한 번 더 넘긴 별칭까지 따라간다.
      const alias = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=/.exec(statement);
      if (!alias?.[1]) continue;
      for (const holder of aliasChain(file.code, alias[1])) {
        for (const field of CALLER_FIELDS) {
          if (readsField(file.code, holder, field)) {
            findings.push(
              `${file.rel}:${line} 가 요청 본문 별칭 "${holder}" 에서 "${field}" 를 읽는다 — 호출자 계정은 resolveCallerAccount(request) 로만 정해진다.`,
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

// ───────────────────────────────────────────────────────────── 진짜 소스 트리

let FILES: SourceFile[] = [];
/** 모든 실패 메시지에 붙는다 — 어떤 파일들을 봤는지 말하지 않는 스캔은 믿을 수 없다. */
let INVENTORY = '';

beforeAll(async () => {
  const paths = await sourcePaths(SRC);
  FILES = await Promise.all(
    paths.map(async (path) => makeSource(relative(SRC, path), await readFile(path, 'utf8'))),
  );
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

describe('negative fixtures — the nine ways a violation slipped past', () => {
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
    ]) {
      expect(scan(empty).targets, `${scan.name} 이 빈 트리에서 대상 0을 통과시킨다`).toBe(0);
    }
    // 가스 스캔만은 파일 수가 아니라 chain.ts 의 존재로 큰소리를 낸다.
    expect(scanGas(empty).findings.join('\n')).toMatch(/chain\.ts 를 찾지 못했다/);
  });
});
