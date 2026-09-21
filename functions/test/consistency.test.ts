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
 * 문서 페이로드를 변수로 빼 두고 쓴다. 그래서 스캔은 (a) `db.ts` 가 내보내는 문자열 상수를
 * 해석하고, (b) 템플릿 경로(`` `${EVENT_CHATS}/${id}/members` ``)를 분해하고,
 * (c) `.set/.update/.create` 인자가 식별자면 그 선언을 찾아 본문을 펼친다.
 */

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const ALLOWED: readonly string[] = dbModule.ALLOWED_COLLECTIONS;

/** `db.ts` 가 내보내는 문자열 상수 전부. 이름→값 표가 모듈에서 오므로 표가 따로 늙지 않는다. */
const COLLECTION_CONSTANTS = new Map<string, string>(
  Object.entries(dbModule).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
);

interface SourceFile {
  /** `src` 기준 상대 경로. 실패 메시지에 나간다. */
  rel: string;
  /** 주석을 공백으로 지운 본문. 오프셋과 줄 번호는 원본 그대로 보존된다. */
  code: string;
  /** 원본 그대로. 주석까지 보는 검사(금지된 컬렉션 이름)에서 쓴다. */
  raw: string;
}

let FILES: SourceFile[] = [];
/** 모든 실패 메시지에 붙는다 — 어떤 파일들을 봤는지 말하지 않는 스캔은 믿을 수 없다. */
let INVENTORY = '';

async function sourceFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(full)));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out.sort();
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

function lineOf(code: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < code.length; i += 1) if (code[i] === '\n') line += 1;
  return line;
}

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
 * `.collection(...)` / `.doc(...)` 인자를 Firestore 경로로 푼다.
 *  - `'persons'` → `persons`
 *  - `PERSONS` → `db.ts` 상수값
 *  - `` `${EVENT_CHATS}/${id}/members` `` → `eventChats/{*}/members` (동적 구간은 `*`)
 * 못 풀면 `null`.
 */
function resolvePath(arg: string): string | null {
  const text = arg.trim();
  const quoted = /^(['"])([\s\S]*)\1$/.exec(text);
  if (quoted) return quoted[2] ?? null;
  if (text.startsWith('`') && text.endsWith('`') && text.length >= 2) {
    return text
      .slice(1, -1)
      .replace(/\$\{([^}]*)\}/g, (_match, expr: string) => COLLECTION_CONSTANTS.get(expr.trim()) ?? '*');
  }
  if (/^[A-Za-z_$][\w$]*$/.test(text)) return COLLECTION_CONSTANTS.get(text) ?? null;
  return null;
}

interface CallSite {
  file: SourceFile;
  line: number;
  method: string;
  args: string[];
}

/** `name` 이라는 메서드 호출을 전부 찾아 균형 잡힌 인자와 함께 돌려준다. */
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
        out.push({
          file,
          line: lineOf(file.code, match.index),
          method: match[1] ?? '',
          args: splitArgs(args),
        });
      }
      match = pattern.exec(file.code);
    }
  }
  return out;
}

/** 파일 안에서 `const X = ...` 의 초기화식 원문을 찾는다(최상위 `;` 까지). */
function declarationOf(file: SourceFile, ident: string): string | null {
  const pattern = new RegExp(`\\b(?:const|let|var)\\s+${ident}\\b\\s*(?::[^=\\n]*)?=`, 'g');
  const match = pattern.exec(file.code);
  if (match === null) return null;
  let i = match.index + match[0].length;
  const start = i;
  let depth = 0;
  while (i < file.code.length) {
    const c = file.code[i];
    if (c === "'" || c === '"' || c === '`') {
      i = skipString(file.code, i);
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') depth -= 1;
    else if (c === ';' && depth === 0) break;
    i += 1;
  }
  return file.code.slice(start, i);
}

/** 객체 원문에서 키 이름을 전부 뽑는다 — `a: 1`, 축약형 `a`, 중첩 객체까지. */
function keysIn(objectText: string): Set<string> {
  const keys = new Set<string>();
  for (const m of objectText.matchAll(/(?:^|[{,[\s])([A-Za-z_$][\w$]*)\s*:/g)) {
    if (m[1] !== undefined) keys.add(m[1]);
  }
  for (const m of objectText.matchAll(/(?:^|[{,])\s*([A-Za-z_$][\w$]*)\s*(?=[,}])/g)) {
    if (m[1] !== undefined) keys.add(m[1]);
  }
  return keys;
}

/**
 * 한 쓰기 호출이 Firestore 문서에 실을 수 있는 키 전부.
 * 인자가 객체 리터럴이면 그 자리에서, 식별자면 선언을 펼쳐서, 스프레드면 한 단계 더 펼쳐서 모은다.
 */
function payloadKeys(site: CallSite): Set<string> {
  const keys = new Set<string>();
  const seen = new Set<string>();
  const expand = (text: string, depth: number): void => {
    if (depth > 2) return;
    for (const key of keysIn(text)) keys.add(key);
    const idents = new Set<string>();
    if (/^[A-Za-z_$][\w$]*$/.test(text.trim())) idents.add(text.trim());
    for (const m of text.matchAll(/\.\.\.\s*([A-Za-z_$][\w$]*)/g)) if (m[1]) idents.add(m[1]);
    for (const ident of idents) {
      if (seen.has(ident)) continue;
      seen.add(ident);
      const decl = declarationOf(site.file, ident);
      if (decl !== null) expand(decl, depth + 1);
    }
  };
  // `.set(payload)` 도 `tx.set(ref, payload, { merge: true })` 도 있으므로 모든 인자를 본다.
  for (const arg of site.args) expand(arg, 0);
  keys.delete('merge');
  return keys;
}

/** `request.data` 를 읽는 한 문장(선언 줄 시작 ~ 최상위 `;`)과 그 별칭 이름. */
interface RequestDataRead {
  file: SourceFile;
  line: number;
  statement: string;
  alias: string | null;
}

function requestDataReads(files: SourceFile[]): RequestDataRead[] {
  const out: RequestDataRead[] = [];
  for (const file of files) {
    const pattern = /request\.data/g;
    let match = pattern.exec(file.code);
    while (match !== null) {
      // 선언 줄 처음부터 세야 `(request.data ?? {}) as { ... }` 의 괄호가 짝이 맞는다.
      // 줄 중간에서 시작해 깊이가 음수가 되는 경우에도 첫 `;` 에서 멈춰 문장을 넘어가지 않는다.
      const lineStart = file.code.lastIndexOf('\n', match.index) + 1;
      let i = lineStart;
      let depth = 0;
      while (i < file.code.length) {
        const c = file.code[i];
        if (c === "'" || c === '"' || c === '`') {
          i = skipString(file.code, i);
          continue;
        }
        if (c === '(' || c === '[' || c === '{') depth += 1;
        else if (c === ')' || c === ']' || c === '}') depth -= 1;
        else if (c === ';' && depth <= 0) break;
        i += 1;
      }
      const statement = file.code.slice(lineStart, i);
      const alias = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=/.exec(statement);
      out.push({
        file,
        line: lineOf(file.code, match.index),
        statement,
        alias: alias?.[1] ?? null,
      });
      match = pattern.exec(file.code);
    }
  }
  return out;
}

/** 한 문장이 읽어 가는 이름 전부 — 구조분해 바인딩 · `as { ... }` 타입 키 · 속성 접근. */
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
  return names;
}

beforeAll(async () => {
  const paths = await sourceFiles(SRC);
  FILES = await Promise.all(
    paths.map(async (path) => {
      const raw = await readFile(path, 'utf8');
      return { rel: relative(SRC, path), raw, code: stripComments(raw) };
    }),
  );
  INVENTORY = `scanned ${FILES.length} files under ${SRC}: ${FILES.map((f) => f.rel).join(', ')}`;
});

/** 디렉터리가 옮겨져 스캔이 0개 파일로 조용히 통과하는 일을 막는다. */
function requireNonEmpty(): void {
  expect(
    FILES.length,
    `정적 스캔이 소스를 하나도 찾지 못했다 — ${SRC} 가 옮겨졌거나 비었다. 통과가 아니라 실패다.`,
  ).toBeGreaterThan(0);
}

describe('spec §10.4 rule 1 — no chain state in Firestore', () => {
  it('only touches collections on the allowlist', () => {
    requireNonEmpty();
    const sites = callSites(FILES, ['collection', 'doc']);
    expect(
      sites.length,
      `Firestore 접근을 하나도 찾지 못했다 — 스캔이 코드 모양을 놓치고 있다. ${INVENTORY}`,
    ).toBeGreaterThan(0);

    for (const site of sites) {
      const where = `${site.file.rel}:${site.line}`;
      const path = resolvePath(site.args[0] ?? '');
      if (site.method === 'collection') {
        expect(
          path,
          `${where} 가 .collection() 에 해석할 수 없는 인자를 넘긴다 — 컬렉션 이름은 db.ts 상수나 리터럴이어야 허용 목록으로 강제할 수 있다. ${INVENTORY}`,
        ).not.toBeNull();
      }
      if (path === null) continue;
      const segments = path.split('/');
      // `.doc('id')` 처럼 한 조각이면 문서 id 다. 컬렉션 이름은 경로의 짝수 번째 조각뿐이다.
      if (site.method === 'doc' && segments.length < 2) continue;
      for (let i = 0; i < segments.length; i += 2) {
        expect(
          ALLOWED,
          `${where} 가 허용 목록에 없는 컬렉션 "${segments[i]}" 를 건드린다(경로 ${path}). ${INVENTORY}`,
        ).toContain(segments[i]);
      }
    }
  });

  it('never names a ticket, role or check-in collection anywhere', () => {
    requireNonEmpty();
    const forbidden = [
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
    for (const file of FILES) {
      for (const name of forbidden) {
        expect(
          file.raw,
          `${file.rel} mentions collection "${name}" — 티켓·역할·입장 상태는 체인이 원본이다(스펙 §10.4 규칙 1). ${INVENTORY}`,
        ).not.toMatch(new RegExp(`\\.(collection|doc)\\(\\s*['"\`]${name}[/'"\`]`));
      }
    }
    // 상수·템플릿으로 우회한 경우까지 같은 금지 목록으로 잡는다.
    const sites = callSites(FILES, ['collection', 'doc']);
    expect(
      sites.length,
      `Firestore 접근을 하나도 찾지 못했다 — 스캔이 코드 모양을 놓치고 있다. ${INVENTORY}`,
    ).toBeGreaterThan(0);
    for (const site of sites) {
      const path = resolvePath(site.args[0] ?? '');
      if (path === null) continue;
      const segments = path.split('/');
      if (site.method === 'doc' && segments.length < 2) continue;
      for (let i = 0; i < segments.length; i += 2) {
        expect(
          forbidden,
          `${site.file.rel}:${site.line} resolves to forbidden collection "${segments[i]}" (경로 ${path}). ${INVENTORY}`,
        ).not.toContain(segments[i]);
      }
    }
  });
});

describe('spec §10.4 rule 3 — active only after chain confirmation', () => {
  it("every file that sets status 'active' also proves it read the chain", () => {
    requireNonEmpty();
    const setters = FILES.filter((file) => /status:\s*['"]active['"]/.test(file.code));
    expect(
      setters.length,
      `status 'active' 를 쓰는 파일이 하나도 없다 — 스캔이 코드 모양을 놓치고 있다. ${INVENTORY}`,
    ).toBeGreaterThan(0);

    for (const file of setters) {
      const provesChain =
        file.code.includes('awaitFinalized') ||
        file.code.includes("blockTag: 'finalized'") ||
        file.code.includes('decodeMontiLogs') ||
        file.code.includes("functionName: 'accountOf'");
      expect(
        provesChain,
        `${file.rel} sets status 'active' without a chain read — finalized 확인 없이 완료로 적으면 안 된다(스펙 §10.4 규칙 3). ${INVENTORY}`,
      ).toBe(true);
    }
  });

  it('never sets a paid-looking ticket or permission field on a Firestore document', () => {
    requireNonEmpty();
    const writes = callSites(FILES, ['set', 'update', 'create']);
    expect(
      writes.length,
      `Firestore 쓰기를 하나도 찾지 못했다 — 스캔이 코드 모양을 놓치고 있다. ${INVENTORY}`,
    ).toBeGreaterThan(0);

    const forbidden = ['checkedIn', 'permissionBits', 'canApprove'];
    for (const site of writes) {
      const keys = payloadKeys(site);
      for (const field of forbidden) {
        if (!keys.has(field)) continue;
        // invites 컬렉션에만 허용된다(수락 전 임시 데이터, 체인에 쓰이면 삭제 대상).
        expect(
          site.file.rel,
          `${site.file.rel}:${site.line} stores "${field}" outside invites — 입장·권한의 원본은 체인이다. ${INVENTORY}`,
        ).toMatch(/invites\.ts$/);
      }
    }
  });
});

describe('gas discipline', () => {
  it('every chain write goes through sendAttesterTx, which always sets gas', () => {
    requireNonEmpty();
    for (const file of FILES) {
      if (file.rel.endsWith('chain.ts')) continue;
      expect(
        file.code,
        `${file.rel} calls writeContract directly — Monad 는 gas_limit 기준 과금이라 모든 쓰기가 sendAttesterTx 를 지나야 한다. ${INVENTORY}`,
      ).not.toContain('writeContract(');
    }
    const chain = FILES.find((file) => file.rel.endsWith(join('lib', 'chain.ts')));
    expect(chain, `lib/chain.ts 를 찾지 못했다. ${INVENTORY}`).toBeDefined();
    expect(
      chain?.code,
      `lib/chain.ts 의 writeContract 가 gas 한도를 명시하지 않는다. ${INVENTORY}`,
    ).toContain('gas: gasLimitFor(estimate)');
  });
});

describe('spec §10.3 — a phone number never lands in Firestore as plaintext', () => {
  it('no Firestore write payload carries a plaintext phone field', () => {
    requireNonEmpty();
    const writes = callSites(FILES, ['set', 'update', 'create']);
    expect(
      writes.length,
      `Firestore 쓰기를 하나도 찾지 못했다 — 스캔이 코드 모양을 놓치고 있다. ${INVENTORY}`,
    ).toBeGreaterThan(0);

    // 번호는 HMAC(`phoneHmac`/`hmacPhone`/`phoneIndex`) 과 KMS 봉투(`phoneEnc`) 로만 저장한다.
    const plaintext = ['phone', 'phoneE164', 'phoneNumber'];
    for (const site of writes) {
      const keys = payloadKeys(site);
      for (const field of plaintext) {
        expect(
          keys.has(field),
          `${site.file.rel}:${site.line} 가 Firestore 페이로드에 평문 번호 필드 "${field}" 를 싣는다 — phoneHmac/phoneEnc/phoneIndex 만 허용된다(스펙 §10.3). ${INVENTORY}`,
        ).toBe(false);
      }
    }
  });
});

describe('caller identity — the account comes from the session, never from the request body', () => {
  it('never reads an account, address or owner field out of request.data', () => {
    requireNonEmpty();
    const reads = requestDataReads(FILES);
    expect(
      reads.length,
      `request.data 를 읽는 곳을 하나도 찾지 못했다 — 스캔이 코드 모양을 놓치고 있다. ${INVENTORY}`,
    ).toBeGreaterThan(0);

    const forbidden = ['account', 'address', 'owner'];
    for (const read of reads) {
      const names = namesReadBy(read.statement);
      for (const field of forbidden) {
        expect(
          names.has(field),
          `${read.file.rel}:${read.line} 가 request.data 에서 "${field}" 를 읽는다 — 호출자 계정은 resolveCallerAccount(request) 로만 정해진다. ${INVENTORY}`,
        ).toBe(false);
      }
      if (read.alias === null) continue;
      for (const field of forbidden) {
        expect(
          read.file.code,
          `${read.file.rel}:${read.line} 가 request.data 별칭 "${read.alias}" 에서 "${field}" 를 읽는다 — 호출자 계정은 resolveCallerAccount(request) 로만 정해진다. ${INVENTORY}`,
        ).not.toMatch(new RegExp(`\\b${read.alias}\\.${field}\\b`));
      }
    }
  });

  it('every callable that authorizes by address resolves the caller with resolveCallerAccount(request)', () => {
    requireNonEmpty();
    const callables = FILES.filter((file) => file.code.includes('onCall('));
    expect(
      callables.length,
      `onCall 함수를 하나도 찾지 못했다 — 스캔이 코드 모양을 놓치고 있다. ${INVENTORY}`,
    ).toBeGreaterThan(0);

    // 주소로 인가를 하는 순간 그 주소의 출처가 전부다. 출처는 세션 하나뿐이어야 한다.
    const authorizes = /requireStaffForGate\(|requireOrganizer\(|functionName:\s*'(?:hasPermission|managerOf|ownerOf)'/;
    const guarded = callables.filter((file) => authorizes.test(file.code));
    expect(
      guarded.length,
      `주소로 인가하는 onCall 함수를 하나도 찾지 못했다 — 스캔이 코드 모양을 놓치고 있다. ${INVENTORY}`,
    ).toBeGreaterThan(0);

    for (const file of guarded) {
      expect(
        file.code,
        `${file.rel} 는 주소로 인가하면서 resolveCallerAccount(request) 를 쓰지 않는다 — 호출자 주소가 요청 본문에서 올 수 있다. ${INVENTORY}`,
      ).toMatch(/resolveCallerAccount\(\s*request\s*\)/);
    }
  });
});
