import { NICKNAMES, db } from './db.js';

/**
 * 닉네임 모양(v2 설계 §7). 표시형은 대소문자를 살린 `[A-Za-z0-9_]{3,20}` 이고, 문서 id(유일성 키)는
 * 그 소문자다 — 정규형 `^[a-z0-9_]{3,20}$` 은 v1 체인 닉네임과 같다. 한 사람이 `Alex` 로 정하면
 * 다른 사람은 `alex` 도 `ALEX` 도 못 쓴다.
 */
const DISPLAY_RE = /^[A-Za-z0-9_]{3,20}$/;
/** Firestore `in` 연산자 한 번에 넣을 수 있는 값의 상한. */
const IN_CHUNK = 30;

export interface ParsedNickname {
  /** `nicknames/{key}` 문서 id. 소문자 정규형. */
  key: string;
  /** 화면에 그리는 형태(앞뒤 공백 제거·NFC). */
  display: string;
}

/** 입력 → (키, 표시형). 정규화는 trim → NFC → 소문자(키만). 모양이 틀리면 null. */
export function parseNickname(raw: unknown): ParsedNickname | null {
  if (typeof raw !== 'string') return null;
  const display = raw.normalize('NFC').trim();
  if (!DISPLAY_RE.test(display)) return null;
  return { key: display.toLowerCase(), display };
}

/**
 * 계정 → 표시 닉네임. 키는 **소문자 주소**다(문서의 `account` 도 소문자로 적는다). 닉네임이
 * 없는 계정은 결과에 없다. `listAttendees`·`issueSnapshot`·`resolveNicknames` 가 같은 표를 쓴다.
 */
export async function nicknamesByAccount(accounts: readonly string[]): Promise<Map<string, string>> {
  const unique = [...new Set(accounts.map((account) => account.toLowerCase()))];
  const names = new Map<string, string>();
  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += IN_CHUNK) chunks.push(unique.slice(i, i + IN_CHUNK));
  const snaps = await Promise.all(
    chunks.map((chunk) => db.collection(NICKNAMES).where('account', 'in', chunk).get()),
  );
  for (const snap of snaps) {
    for (const doc of snap.docs) {
      const account = doc.get('account') as string | undefined;
      if (!account) continue;
      names.set(account, (doc.get('display') as string | undefined) ?? doc.id);
    }
  }
  return names;
}
