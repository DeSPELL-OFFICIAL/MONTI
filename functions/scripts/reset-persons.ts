import { pathToFileURL } from 'node:url';
import type { Hex } from '@monti/shared';
import { PERSONS, USERS, authAdmin, db } from '../src/lib/db.js';
import { erasePerson } from '../src/lib/erasePerson.js';

/**
 * 테스트 계정 초기화. **운영자가 손으로 돌리는 스크립트다** — 콜러블도 스케줄도 아니다.
 *
 * 계약을 새로 배포하면 옛 `Identity` 에 등록된 계정은 전부 죽은 계정이 된다. 그 계정들은
 * 7일을 기다릴 이유가 없으므로(진짜 사용자가 아니다) 여기서 **즉시** 지운다. 지우는 일
 * 자체는 매일 도는 `processDeletions` 와 **같은 함수**(`lib/erasePerson.ts`)가 한다 —
 * 이 파일에 파기 로직의 사본은 없다.
 *
 * **체인은 건드리지 않는다.** 옛 계약은 그냥 버린다(스펙 §10.2).
 */

/**
 * 행사 초안. 사람이 만든 초안은 `eventDrafts/{uid}/drafts/{draftId}` 에 있고 클라이언트가
 * 직접 읽고 쓴다 — 서버는 이 컬렉션에 닿지 않으므로 `db.ts` 의 허용 목록에도 없다.
 * 계정이 사라지면 초안도 주인이 없으므로 여기서 같이 지운다.
 */
const EVENT_DRAFTS = 'eventDrafts';
const DRAFTS = 'drafts';

const PERSON_ID_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const PHONE_PATTERN = /^\+[0-9]{7,15}$/;

export const HELP = `reset-persons — 테스트 계정을 즉시 파기한다 (7일 유예 없이).

  GOOGLE_APPLICATION_CREDENTIALS=<서비스 계정 JSON> \\
  DIDIT_API_KEY=$(firebase functions:secrets:access DIDIT_API_KEY --project mon-ti) \\
  fnm exec --using=22 pnpm --filter monti-functions exec tsx scripts/reset-persons.ts <대상> [--yes]

대상 (하나만 고른다)
  --all                 아직 지워지지 않은 사람 전부 (status 가 'deleted' 가 아닌 문서)
  --person <personId>   0x + 64 hex
  --phone <E.164>       예: +821012345678 — Firebase Auth 로 uid 를 찾아 그 사람을 고른다

  --yes                 실제로 지운다. 없으면 대상만 출력하고 아무것도 건드리지 않는다(드라이런).

지우는 것 — 매일 도는 파기 작업과 **같은** 목록이다(lib/erasePerson.ts)
  Didit 세션(연 적 있는 것 전부) · persons(문서는 남기고 개인정보 필드만 턴다, status='deleted')
  users · passkeys · devices · phoneIndex · Firebase Auth 사용자
  여기에 더해 eventDrafts/{uid}/drafts/* (주인이 사라진 행사 초안)

지우지 않는 것
  deletionRequests 는 건드리지 않는다 — 이 경로는 요청 자체가 없다(운영자가 직접 지운다).
  orgProfiles · eventPrivate · eventArt 는 **사람이 아니라 행사**에 달려 있다(문서 id 가 eventId 다).
  주최자 한 명을 지운다고 그 행사의 이름·장소·티켓 그림이 사라지면 안 되므로 그대로 둔다.
  체인도 건드리지 않는다 — 옛 계약은 그냥 버린다(스펙 §10.2).`;

/** 인자가 틀렸다는 뜻. 밖에서는 사용법 + 한 줄 이유로 보인다. */
export class UsageError extends Error {}

export interface Options {
  mode: 'all' | 'person' | 'phone';
  personId?: Hex;
  phone?: string;
  /** `--yes`. 없으면 드라이런이다. */
  confirmed: boolean;
}

export function parseArgs(argv: readonly string[]): Options {
  let mode: Options['mode'] | undefined;
  let personId: Hex | undefined;
  let phone: string | undefined;
  let confirmed = false;

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    // 대상을 두 개 주면 어느 쪽을 뜻했는지 알 수 없다. 조용히 하나를 고르는 것이 최악이다.
    const claim = (next: Options['mode']): void => {
      if (mode !== undefined) throw new UsageError('대상은 하나만 고른다 (--all · --person · --phone).');
      mode = next;
    };
    const value = (): string => {
      const given = argv[i + 1];
      if (given === undefined || given.startsWith('--')) throw new UsageError(`${flag} 에 값이 없다.`);
      i += 1;
      return given;
    };

    if (flag === '--all') claim('all');
    else if (flag === '--person') {
      claim('person');
      const given = value();
      if (!PERSON_ID_PATTERN.test(given)) throw new UsageError(`personId 모양이 아니다: ${given}`);
      personId = given.toLowerCase() as Hex;
    } else if (flag === '--phone') {
      claim('phone');
      const given = value();
      if (!PHONE_PATTERN.test(given)) throw new UsageError(`E.164 모양이 아니다(+국가번호…): ${given}`);
      phone = given;
    } else if (flag === '--yes') confirmed = true;
    else throw new UsageError(`모르는 인자: ${flag}`);
  }

  if (mode === undefined) throw new UsageError('대상을 고른다 (--all · --person · --phone).');
  return { mode, personId, phone, confirmed };
}

/**
 * 번호를 가린다. 목록은 사람이 "이게 내 테스트 계정이 맞나" 를 눈으로 확인하려고 보는 것이라
 * 앞뒤는 남기고 가운데만 가린다. 평문 전체는 터미널에도 로그에도 남기지 않는다(스펙 §10.3).
 */
export function maskPhone(phone: string | undefined): string {
  if (!phone) return '(번호 없음)';
  if (phone.length <= 9) return `${phone.slice(0, 2)}${'*'.repeat(Math.max(phone.length - 4, 1))}${phone.slice(-2)}`;
  return `${phone.slice(0, 5)}${'*'.repeat(phone.length - 9)}${phone.slice(-4)}`;
}

export interface Target {
  personId: Hex;
  /** `users/{uid}` 가 이미 지워졌으면 없다. 그래도 남은 문서는 지워야 하므로 대상에서 빼지 않는다. */
  uid?: string;
  phone?: string;
  status: string;
  kycStatus?: string;
  createdAt?: string;
}

function iso(value: unknown): string | undefined {
  const stamp = value as { toDate?: () => Date } | undefined;
  return typeof stamp?.toDate === 'function' ? stamp.toDate().toISOString() : undefined;
}

/** personId → uid. `users` 가 사람을 가리키는 유일한 방향이라 역방향은 질의로 찾는다. */
async function uidOf(personId: Hex): Promise<string | undefined> {
  const found = await db.collection(USERS).where('personId', '==', personId).limit(1).get();
  return found.docs[0]?.id;
}

/** Auth 에서 번호를 읽는다. 평문 번호는 Firestore 어디에도 없다(`startSignup.ts`). */
async function phoneOf(uid: string | undefined): Promise<string | undefined> {
  if (uid === undefined) return undefined;
  try {
    return (await authAdmin.getUser(uid)).phoneNumber ?? undefined;
  } catch {
    // 이미 지워진 Auth 사용자다. 번호를 못 읽는 것이 대상에서 빼는 이유는 되지 않는다.
    return undefined;
  }
}

async function describe(person: {
  id: string;
  get: (field: string) => unknown;
}): Promise<Target> {
  const personId = person.id as Hex;
  const uid = await uidOf(personId);
  return {
    personId,
    uid,
    phone: await phoneOf(uid),
    status: (person.get('status') as string | undefined) ?? '(없음)',
    kycStatus: person.get('kyc.status') as string | undefined,
    createdAt: iso(person.get('createdAt')),
  };
}

/**
 * 지울 사람을 고른다. `--all` 은 **아직 지워지지 않은 사람 전부**다 — 이미 `deleted` 인
 * 문서를 다시 집으면 매번 "0건 지웠다" 는 줄만 늘어나 진짜 대상이 묻힌다.
 */
export async function selectTargets(options: Options): Promise<Target[]> {
  if (options.mode === 'all') {
    const all = await db.collection(PERSONS).get();
    const alive = all.docs.filter((person) => person.get('status') !== 'deleted');
    return Promise.all(alive.map((person) => describe(person)));
  }

  if (options.mode === 'person') {
    const person = await db.collection(PERSONS).doc(options.personId as string).get();
    return person.exists ? [await describe(person)] : [];
  }

  // `--phone`: 평문 번호는 Firestore 에 없다. Auth 가 번호 → uid 를 아는 유일한 곳이다.
  let uid: string;
  try {
    uid = (await authAdmin.getUserByPhoneNumber(options.phone as string)).uid;
  } catch {
    return [];
  }
  const personId = (await db.collection(USERS).doc(uid).get()).get('personId') as Hex | undefined;
  if (!personId) return [];
  const person = await db.collection(PERSONS).doc(personId).get();
  return person.exists ? [await describe(person)] : [];
}

/**
 * 주인이 사라진 행사 초안을 지운다. `eventDrafts/{uid}` 는 대개 **문서가 아니라 경로**라
 * (클라이언트는 하위 컬렉션에만 쓴다) 부모 삭제는 보통 아무 일도 하지 않는다 — 그래도
 * 누가 부모에 쓴 적이 있으면 그것까지 지워져야 하므로 한 번 부른다. 숫자는 초안만 센다.
 */
async function eraseEventDrafts(uid: string): Promise<number> {
  const root = db.collection(EVENT_DRAFTS).doc(uid);
  const drafts = await root.collection(DRAFTS).get();
  for (const draft of drafts.docs) await draft.ref.delete();
  await root.delete();
  return drafts.docs.length;
}

export interface ResetResult {
  personId: Hex;
  diditSessions: number;
  firestoreDocs: number;
  authDeleted: boolean;
}

/** 한 사람. 매일 도는 파기와 같은 함수를 부르고, 행사 초안만 더 지운다. */
export async function resetPerson(target: Target, diditApiKey: string): Promise<ResetResult> {
  const erased = await erasePerson({ uid: target.uid, personId: target.personId, diditApiKey });
  const drafts = target.uid === undefined ? 0 : await eraseEventDrafts(target.uid);
  return {
    personId: target.personId,
    diditSessions: erased.diditSessions,
    firestoreDocs: erased.firestoreDocs + drafts,
    authDeleted: erased.authDeleted,
  };
}

export function formatTarget(target: Target, index: number): string {
  const kyc = target.kycStatus ?? '(없음)';
  const created = target.createdAt ?? '(없음)';
  return `${String(index + 1).padStart(3)}. ${target.personId}  ${maskPhone(target.phone)}  status=${target.status}  kyc=${kyc}  createdAt=${created}`;
}

export function formatResult(result: ResetResult): string {
  return `     ${result.personId}  didit sessions deleted ${result.diditSessions}, firestore docs deleted ${result.firestoreDocs}, auth deleted ${result.authDeleted ? 'yes' : 'no'}`;
}

type Write = (line: string) => void;

/** 종료 코드를 돌려준다. `process.exit` 는 직접 실행됐을 때만 부른다 — 테스트가 이 함수를 부른다. */
export async function main(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  write: Write = (line) => console.log(line),
): Promise<number> {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    write(HELP);
    return argv.length === 0 ? 2 : 0;
  }

  let options: Options;
  try {
    options = parseArgs(argv);
  } catch (cause) {
    if (!(cause instanceof UsageError)) throw cause;
    write(HELP);
    write('');
    write(`오류: ${cause.message}`);
    return 2;
  }

  // 키가 없으면 Didit 세션을 못 지운다. 그 상태로 Firestore 를 먼저 털면 sessionId 가 사라져
  // 남의 서버에 남은 얼굴 자료를 **영영** 못 지운다 — 드라이런도 여기서 함께 막는다.
  const diditApiKey = env.DIDIT_API_KEY;
  if (!diditApiKey) {
    write('오류: DIDIT_API_KEY 가 환경변수에 없다.');
    write('  DIDIT_API_KEY=$(firebase functions:secrets:access DIDIT_API_KEY --project mon-ti) … 로 넣고 다시 돌린다.');
    return 2;
  }

  const targets = await selectTargets(options);
  write(`대상 ${targets.length}명 (${options.mode})`);
  targets.forEach((target, index) => write(formatTarget(target, index)));

  if (targets.length === 0) {
    write('지울 것이 없다.');
    // 콕 집은 대상이 없다는 것은 인자가 틀렸다는 뜻이다. `--all` 의 0건은 정상이다(이미 다 지웠다).
    return options.mode === 'all' ? 0 : 1;
  }

  if (!options.confirmed) {
    write('');
    write('드라이런이다 — 아무것도 지우지 않았다. 실제로 지우려면 같은 명령에 --yes 를 붙인다.');
    return 0;
  }

  write('');
  let failed = 0;
  for (const target of targets) {
    try {
      write(formatResult(await resetPerson(target, diditApiKey)));
    } catch (cause) {
      failed += 1;
      // 하나가 터져도 나머지는 계속 간다. 터진 것은 다시 돌리면 된다(전부 멱등이다).
      write(`     ${target.personId}  실패: ${(cause as Error).message}`);
    }
  }
  write('');
  write(`끝. ${targets.length - failed}명 지웠다, ${failed}명 실패.`);
  return failed === 0 ? 0 : 1;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  // Firestore 는 연결을 열어 둔다. 여기서 끊지 않으면 다 끝나고도 프롬프트가 돌아오지 않는다.
  process.exit(await main(process.argv.slice(2), process.env));
}
