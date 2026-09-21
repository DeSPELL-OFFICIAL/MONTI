#!/usr/bin/env node
import { readdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import ts from 'typescript';
import { BANNED_ATTENDEE_WORDS } from './constants.js';

export interface CopyLintHit {
  file: string;
  line: number;
  column: number;
  word: string;
  text: string;
}

const IGNORE_MARKER = 'copy-lint-ignore';
/**
 * 훑지 않는 폴더. 빌드 산출물 말고 **사람이 쓴 코드 중에서는 `organizer` 하나뿐이다.**
 *
 * 한때 `staff` 도 여기 있었다. 근거는 "관객에게 금지된 낱말이 스태프에게는 그냥 일하는 말"이었고,
 * 그 전제가 틀렸다. 게이트 화면은 스태프 혼자 보는 화면이 아니다 — "이미 입장했어요"를 스태프
 * 어깨 너머로 같이 읽는 사람은 방금 거절당한 그 관객이고, 그 순간 화면에 "토큰"이 떠 있으면
 * 관객 앱에서 한 글자도 쓰지 않으려고 들인 공이 입구에서 무너진다. 게다가 그 화면을 쥔 스태프도
 * 엔지니어가 아니라 그날 처음 나온 아르바이트생이다. 그래서 스펙 §3.2 의 금지어는 두 앱 모두에
 * 적용되고, `lint:copy` 가 `apps/web/src/staff` 도 훑는다.
 *
 * `organizer` 는 남는다: 주최자 화면은 정산·수수료·계약 주소를 다루는 사무 도구이고, 그것을
 * 읽는 사람은 그 낱말로 일한다.
 */
const IGNORED_DIRS = new Set(['node_modules', 'dist', 'build', '.git', 'organizer']);
const DEFAULT_EXTENSIONS = ['.tsx', '.ts'];

// 'NFT'는 ASCII지만 부분 문자열로 매칭한다: 관객 카피에서 항상 잡아야 하는 강한 크립토 용어.
const SUBSTRING_ASCII = new Set(['NFT']);

function escapeRegExp(word: string): string {
  return word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isAsciiWord(word: string): boolean {
  return /^[A-Za-z]+$/.test(word);
}

interface Pattern {
  word: string;
  regex: RegExp;
}

// 한글 낱말과 'NFT'는 부분 문자열로, 그 밖의 영어 낱말은 단어 경계로 매칭한다(모두 대소문자 무시).
const PATTERNS: Pattern[] = BANNED_ATTENDEE_WORDS.map((word) => {
  const substring = !isAsciiWord(word) || SUBSTRING_ASCII.has(word);
  return {
    word,
    regex: substring
      ? new RegExp(escapeRegExp(word), 'gi')
      : new RegExp(`\\b${escapeRegExp(word)}\\b`, 'gi'),
  };
});

interface RawMatch {
  index: number;
  word: string;
}

function matchAll(text: string): RawMatch[] {
  const matches: RawMatch[] = [];
  for (const { word, regex } of PATTERNS) {
    regex.lastIndex = 0;
    let match = regex.exec(text);
    while (match !== null) {
      matches.push({ index: match.index, word });
      match = regex.exec(text);
    }
  }
  return matches;
}

/**
 * 저수준 매처: 주어진 텍스트를 줄 단위로 그대로 훑는다(리터럴 추출 없음).
 * 파일 단위 스캔은 `scanFile`이 문자열/JSX 텍스트만 골라 이 규칙을 적용한다.
 */
export function scanText(file: string, text: string): CopyLintHit[] {
  const hits: CopyLintHit[] = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.includes(IGNORE_MARKER)) continue;
    for (const { index: at, word } of matchAll(line)) {
      hits.push({ file, line: index + 1, column: at + 1, word, text: line.trim() });
    }
  }
  return hits;
}

interface CopyNode {
  start: number;
  text: string;
}

function isModuleSpecifier(node: ts.StringLiteral): boolean {
  const parent = node.parent;
  if (parent === undefined) return false;
  if (ts.isImportDeclaration(parent) && parent.moduleSpecifier === node) return true;
  if (ts.isExportDeclaration(parent) && parent.moduleSpecifier === node) return true;
  return false;
}

// 화면에 뜨는 텍스트 노드만 모은다: 문자열/템플릿 리터럴과 JSX 텍스트.
function collectCopyNodes(sourceFile: ts.SourceFile): CopyNode[] {
  const nodes: CopyNode[] = [];
  const push = (node: ts.Node): void => {
    nodes.push({ start: node.getStart(sourceFile), text: node.getText(sourceFile) });
  };
  const visit = (node: ts.Node): void => {
    // 동적 import()·vi.mock() 호출은 통째로 건너뛴다(모듈 경로 문자열은 카피가 아님).
    if (ts.isCallExpression(node)) {
      const expr = node.expression;
      const isDynamicImport = expr.kind === ts.SyntaxKind.ImportKeyword;
      const isViMock =
        ts.isPropertyAccessExpression(expr) &&
        ts.isIdentifier(expr.expression) &&
        expr.expression.text === 'vi' &&
        expr.name.text === 'mock';
      if (isDynamicImport || isViMock) return;
    }
    if (ts.isStringLiteral(node)) {
      if (!isModuleSpecifier(node)) push(node);
      return;
    }
    if (ts.isNoSubstitutionTemplateLiteral(node)) {
      push(node);
      return;
    }
    if (ts.isTemplateExpression(node)) {
      push(node.head);
      for (const span of node.templateSpans) {
        push(span.literal);
        visit(span.expression); // ${...} 안의 문자열 리터럴도 카피일 수 있어 계속 탐색한다.
      }
      return;
    }
    if (node.kind === ts.SyntaxKind.JsxText) {
      push(node);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return nodes;
}

/** 단일 `.ts`/`.tsx` 소스를 파싱해 화면에 뜨는 텍스트에서만 금지어를 찾는다. */
export function scanFile(file: string, source: string): CopyLintHit[] {
  const scriptKind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind);
  const sourceLines = source.split('\n');
  const hits: CopyLintHit[] = [];
  for (const node of collectCopyNodes(sourceFile)) {
    for (const { index, word } of matchAll(node.text)) {
      const pos = sourceFile.getLineAndCharacterOfPosition(node.start + index);
      const lineText = sourceLines[pos.line] ?? '';
      if (lineText.includes(IGNORE_MARKER)) continue;
      hits.push({ file, line: pos.line + 1, column: pos.character + 1, word, text: lineText.trim() });
    }
  }
  return hits;
}

function isTestFile(name: string): boolean {
  return /\.test\.[cm]?[jt]sx?$/.test(name);
}

/** 폴더를 재귀적으로 훑어 주어진 확장자의 소스 파일만 `scanFile`로 검사한다. */
export async function scanFolder(
  root: string,
  extensions: string[] = DEFAULT_EXTENSIONS,
): Promise<CopyLintHit[]> {
  const hits: CopyLintHit[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      hits.push(...(await scanFolder(full, extensions)));
      continue;
    }
    if (!entry.isFile()) continue;
    if (isTestFile(entry.name)) continue;
    if (!extensions.includes(extname(entry.name))) continue;
    hits.push(...scanFile(full, await readFile(full, 'utf8')));
  }
  return hits;
}

async function main(): Promise<void> {
  const roots = process.argv.slice(2);
  if (roots.length === 0) {
    console.error('usage: monti-copy-lint <folder> [<folder>...]');
    process.exit(2);
  }
  const hits: CopyLintHit[] = [];
  for (const root of roots) hits.push(...(await scanFolder(root)));
  for (const hit of hits) {
    console.error(`${hit.file}:${hit.line}:${hit.column}  banned word "${hit.word}"  ${hit.text}`);
  }
  if (hits.length > 0) {
    console.error(`\n${hits.length} banned word(s) in attendee-facing copy. 스펙 §3.2 위반입니다.`);
    process.exit(1);
  }
  console.log(`copy-lint: clean (${roots.join(', ')})`);
}

const invokedDirectly =
  typeof process !== 'undefined' &&
  process.argv[1] !== undefined &&
  process.argv[1].includes('copy-lint');
if (invokedDirectly) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exit(2);
  });
}
