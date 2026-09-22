import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { info, warn } from 'firebase-functions/logger';
import { onRequest } from 'firebase-functions/v2/https';
import type { Hex, PersonStatus } from '@monti/shared';
import { ATTESTER_PK, DIDIT_WEBHOOK_SECRET } from '../config.js';
import { awaitFinalized, publicClient } from '../lib/chain.js';
import { DIDIT_EVENTS, KYC_SESSIONS, PERSONS, assertStatusTransition, db } from '../lib/db.js';
import {
  DIDIT_SESSION_WEBHOOK_TYPES,
  declineReasonFromDecision,
  diditIdVerification,
  faceSearchClear,
  faceSearchStatus,
  redactDiditPayload,
  redactRawBody,
  verifyDiditWebhook,
} from '../lib/didit.js';
import { encryptField, piiAad } from '../lib/kms.js';
import { PortraitError, normalizePortrait } from '../lib/portrait.js';
import { sendSetKycLevel } from '../lib/kycLevel.js';

const PERSON_ID_RE = /^0x[0-9a-fA-F]{64}$/;
/** Firestore 문서 id 로 쓸 수 있는 모양만 받는다. `/` 가 섞이면 경로가 쪼개진다. */
const EVENT_ID_RE = /^[A-Za-z0-9_.:-]{1,256}$/;
const SESSION_WEBHOOK_TYPES = new Set<string>(DIDIT_SESSION_WEBHOOK_TYPES);
/** `diditEvents` 도장의 수명. Firestore TTL 정책이 `expireAt` 을 보고 지운다. */
const EVENT_TTL_SECONDS = 7 * 24 * 60 * 60;
/** Firestore 의 ALREADY_EXISTS. `create()` 가 이 코드로 던지면 먼저 온 배달이 이미 있다는 뜻이다. */
const ALREADY_EXISTS = 6;

interface DiditBody {
  event_id?: unknown;
  session_id?: unknown;
  status?: unknown;
  webhook_type?: unknown;
  vendor_data?: unknown;
  decision?: unknown;
}

interface Snap {
  exists: boolean;
  get: (field: string) => unknown;
}

interface Reply {
  code: number;
  body: string;
}

/**
 * 상태 하나가 사람 문서에 무엇을 하는지. Didit 의 아홉 가지 상태를 **전부** 여기서 받는다 —
 * 표에 없는 값도 `unknown` 으로 떨어져 200 으로 접수된다(5xx 를 내면 Didit 이 두 번 더 때린다).
 *
 *  - `approve` / `decline`  결정이 실려 온다. 사람 문서와 체인까지 간다.
 *  - `mark`                 진행 딱지만 바꾼다(`kyc.status`). `status` 도 `kycLevel` 도 그대로다.
 *  - `reopen`               `Resubmitted` — 다시 제출했다. 세션을 **다시 열어** 두고 사유를 지운다.
 *  - `noop`                 아직 아무 일도 없다(`In Progress` / `Not Started`). 접수만 한다.
 */
type Route =
  | { kind: 'approve' }
  | { kind: 'decline' }
  | { kind: 'mark'; kycStatus: 'in_review' | 'abandoned' | 'expired' }
  | { kind: 'reopen' }
  | { kind: 'noop' }
  | { kind: 'unknown' };

function routeStatus(status: string): Route {
  switch (status) {
    case 'Approved':
      return { kind: 'approve' };
    case 'Declined':
      return { kind: 'decline' };
    case 'In Review':
      return { kind: 'mark', kycStatus: 'in_review' };
    case 'Abandoned':
      return { kind: 'mark', kycStatus: 'abandoned' };
    case 'Expired':
    case 'KYC Expired':
      return { kind: 'mark', kycStatus: 'expired' };
    case 'Resubmitted':
      return { kind: 'reopen' };
    case 'In Progress':
    case 'Not Started':
      return { kind: 'noop' };
    default:
      return { kind: 'unknown' };
  }
}

/** 이미 통과한 사람인가. 늦게 도착한 `Expired` 가 통과 기록을 되돌리지 못하게 막는 자물쇠다. */
function alreadyApproved(person: Snap): boolean {
  if ((person.get('kycLevel') as number | undefined) === 1) return true;
  return (person.get('kyc') as { status?: string } | undefined)?.status === 'approved';
}

/**
 * 결정이 실려 오지 않는 상태가 사람 문서에 쓸 것. 없으면 `null` — 아무것도 쓰지 않는다.
 * `kyc.status` 딱지 하나만 건드린다: `sessionId` 를 지우면 파기가 Didit 의 얼굴 자료를 못 찾고,
 * `status`/`kycLevel` 을 건드리면 체인과 DB 가 갈라진다.
 */
function progressPatch(route: Route, person: Snap): Record<string, unknown> | null {
  if (alreadyApproved(person)) return null;
  if (route.kind === 'mark') {
    return { kyc: { status: route.kycStatus }, updatedAt: FieldValue.serverTimestamp() };
  }
  if (route.kind === 'reopen') {
    // 다시 열린 세션은 `ensureKycSession` 이 같은 링크로 재사용하고, 버려지면
    // `reconcilePending` 의 스윕이 `openedAt` 으로 나이를 재 24시간 뒤에 닫는다.
    return {
      kyc: { status: 'open', openedAt: Math.floor(Date.now() / 1000), lastReason: null },
      updatedAt: FieldValue.serverTimestamp(),
    };
  }
  return null;
}

/**
 * Didit 웹훅. 본문은 **절대** 응답으로 되돌려 보내지 않는다 — 실패 응답은 고정 문자열뿐이다.
 * 서명이 틀렸을 때만 레닥션을 건 본문을 로그에 남긴다(Didit 통합 규격, `redactRawBody`).
 *
 *  1. POST 가 아니면 405. 그다음 `req.rawBody` **바이트**에 대해 세 가지 서명 중 하나를 맞춘다
 *     (`X-Signature` 원본 · `X-Signature-V2` 정규화 JSON · `X-Signature-Simple` 네 값).
 *     타임스탬프 창(±300초)이 먼저고, 비교는 전부 상수 시간이다(`lib/didit.ts`).
 *  2. 세션 이벤트(`status.updated` / `data.updated`)가 아니면 200 으로 받고 버린다.
 *     `user.*` · `business.*` · `activity.created` · `transaction.*` 은 우리가 볼 것이 없다.
 *  3. `event_id` 에 first-wins 도장을 찍는다(`diditEvents/{event_id}`). 이미 있으면 재배달이다.
 *     그 아래에 예전 세션 도장(`session_id` + `status`)이 그대로 남아 이중으로 막는다.
 *  4. KMS 를 부르기 전에 세션 중복과 상태 전이를 **먼저 읽어** 걸러낸다. 여기서 막히면
 *     세션에 도장을 찍지 않으므로 Didit 재배달이 그대로 다시 시도된다.
 *  5. 사람 문서(`status:'kyc_ok'` + `kyc.sessionId` + PII 봉투)와 세션 도장을 **한 트랜잭션**에서
 *     쓴다. 둘 다 있거나 둘 다 없다 — "처리됨" 도장만 남고 복구 지점이 없는 창이 사라진다.
 *  6. 체인 호출은 커밋 **뒤에** 한다. 여기서 죽거나 터져도 사람은 `kyc_ok` 로 남고,
 *     `reconcilePending` 이 `status === 'kyc_ok'` 이면서 `chain.kycLevelTx` 가 **없는** 사람을
 *     골라 같은 `sendSetKycLevel` 로 다시 보낸다(단순 대입이라 재전송이 안전하다).
 *     아래 revert 경로가 해시를 일부러 버리는 것도 그래서다 — 해시가 없어야 복구가 집어 간다.
 *     그 경로는 `event_id` 도장도 함께 **반납한다**: 반납하지 않으면 Didit 의 재배달이
 *     "이미 처리됨"으로 삼켜져 복구 경로가 스케줄러 하나로 줄어든다.
 *  7. finalized 된 다음에만 `active` / `kycLevel: 1` / `chain.kycLevelTx` 를 쓴다(스펙 §10.4 규칙 3).
 */
export const diditWebhook = onRequest(
  { secrets: [DIDIT_WEBHOOK_SECRET, ATTESTER_PK], cors: false, invoker: 'public', timeoutSeconds: 120 },
  async (req, res) => {
    // 웹훅은 POST 하나뿐이다. 본문 없는 메서드로 빈 문자열에 서명을 맞춰 보는 길 자체를 막는다.
    if (req.method !== 'POST') {
      res.status(405).send('method not allowed');
      return;
    }

    const raw = req.rawBody?.toString('utf8') ?? '';
    const verification = verifyDiditWebhook({
      raw,
      v2: req.get('X-Signature-V2'),
      rawSignature: req.get('X-Signature'),
      simple: req.get('X-Signature-Simple'),
      timestamp: Number(req.get('X-Timestamp') ?? '0'),
      secret: DIDIT_WEBHOOK_SECRET.value(),
      now: Math.floor(Date.now() / 1000),
    });
    if (!verification.ok) {
      // 규격이 요구하는 "서명 실패 시 원본 로그". 개인정보 키의 값과 base64 덩어리는 깎아 남긴다.
      warn('didit.signature.rejected', { code: verification.code, body: redactRawBody(raw) });
      if (verification.code === 'malformed_body') {
        res.status(400).send('bad json');
        return;
      }
      res.status(401).send(verification.code);
      return;
    }

    const body = verification.body;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      res.status(400).send('bad json');
      return;
    }
    const envelope = body as DiditBody;

    const webhookType = typeof envelope.webhook_type === 'string' ? envelope.webhook_type.trim() : '';
    // Didit 은 계정·업체·활동·결제 이벤트도 **같은 주소**로 보낸다(콘솔의 "Try Webhook" 이 그렇다).
    // 우리가 볼 것이 없는 종류는 200 으로 받고 버린다 — 4xx·5xx 로 답하면 재시도 큐가 계속 두드린다.
    // `webhook_type` 이 아예 없는 본문은 세션 이벤트로 본다(예전 페이로드와 우리 픽스처가 그렇다).
    if (webhookType !== '' && !SESSION_WEBHOOK_TYPES.has(webhookType)) {
      info('didit.webhook.ignored', { webhookType });
      res.status(200).send('ignored');
      return;
    }

    const sessionId = typeof envelope.session_id === 'string' ? envelope.session_id : '';
    const status = typeof envelope.status === 'string' ? envelope.status : 'Unknown';

    if (!verification.authenticated) {
      // `X-Signature-Simple` 은 `timestamp:session_id:status:webhook_type` 네 값만 덮는다.
      // `vendor_data` 도 `decision` 도 서명 **밖**이라 누구의 어떤 결정인지 이 배달로는 알 수 없다.
      // 그래서 **아무것도 쓰지 않는다** — 특히 `kycLevel` 을 올리지 않는다. 도장도 찍지 않으므로
      // 같은 이벤트가 V2/원본 서명을 달고 다시 오면 그때 정상 처리된다.
      warn('didit.webhook.unauthenticated', { scheme: verification.scheme, sessionId, status, webhookType });
      res.status(200).send('unauthenticated decision');
      return;
    }

    const personId = typeof envelope.vendor_data === 'string' ? (envelope.vendor_data as Hex) : undefined;
    if (!sessionId || !personId || !PERSON_ID_RE.test(personId)) {
      res.status(400).send('missing session or vendor_data');
      return;
    }

    // `event_id` 멱등. 세션 도장(`session_id` + `status`)은 같은 결정이 두 번 올 때를 막고,
    // 이 도장은 **같은 이벤트**가 두 번 올 때를 막는다 — Didit 은 5xx/404 에 두 번 재시도한다.
    const rawEventId = typeof envelope.event_id === 'string' ? envelope.event_id.trim() : '';
    const eventId = EVENT_ID_RE.test(rawEventId) ? rawEventId : '';
    const eventRef = eventId ? db.collection(DIDIT_EVENTS).doc(eventId) : null;
    if (eventRef) {
      try {
        await eventRef.create({
          sessionId,
          status,
          webhookType: webhookType || null,
          receivedAt: FieldValue.serverTimestamp(),
          // TTL 정책이 보는 필드. 이 장부는 읽을 일이 없고 무한히 자라서도 안 된다.
          expireAt: Timestamp.fromMillis(Date.now() + EVENT_TTL_SECONDS * 1000),
        });
      } catch (cause) {
        if ((cause as { code?: number }).code !== ALREADY_EXISTS) throw cause;
        res.status(200).send('duplicate');
        return;
      }
    }
    /** 도장을 반납한다. 처리에 실패한 이벤트를 "이미 처리됨"으로 남겨 두지 않는다. */
    const release = async (): Promise<void> => {
      if (eventRef) await eventRef.delete().catch(() => undefined);
    };

    let reply: Reply;
    try {
      reply = await process(envelope, { sessionId, personId, status, webhookType, eventId });
    } catch (cause) {
      await release();
      throw cause;
    }
    if (reply.code >= 500) await release();
    res.status(reply.code).send(reply.body);
  },
);

interface Delivery {
  sessionId: string;
  personId: Hex;
  status: string;
  webhookType: string;
  eventId: string;
}

async function process(envelope: DiditBody, delivery: Delivery): Promise<Reply> {
  const { sessionId, personId, status } = delivery;
  const sessionRef = db.collection(KYC_SESSIONS).doc(sessionId);
  const personRef = db.collection(PERSONS).doc(personId);
  const route = routeStatus(status);
  const faceSearch = faceSearchStatus(envelope.decision);

  // 받은 본문을 통째로 넣지 않는다. 여기 적힌 결정 필드만 추려 담고, 그 위에 레닥션을
  // 한 번 더 건다 — Didit 이 새 개인정보 필드를 추가해도 저장 경로로 샐 수 없다(스펙 §10.3).
  const sessionStamp = {
    personId,
    status,
    decision: status,
    raw: redactDiditPayload({
      session_id: sessionId,
      status,
      webhook_type: delivery.webhookType || null,
      event_id: delivery.eventId || null,
      vendor_data: personId,
      decision: { face_search: { status: faceSearch } },
    }),
    receivedAt: FieldValue.serverTimestamp(),
  };
  const isStamped = (snap: Snap): boolean => snap.exists && snap.get('decision') === status;

  // 우리가 만든 적 없는 `vendor_data` 로는 사람 문서를 만들지 않는다. 웹훅 입력이 곧
  // 새 사람이 되는 길을 열면 아무나 `persons/{아무 32바이트}` 를 찍어낼 수 있다.
  // 세션 id 와 사유만 남긴다 — 이 세 필드 말고는 아무것도 쓰지 않는다.
  const orphanStamp = { sessionId, status: 'orphan', reason: 'unknown_person' };

  // 사전 읽기. KMS 왕복과 트랜잭션에 들어가기 전에 중복·존재·전이를 먼저 걸러낸다.
  if (isStamped(await sessionRef.get())) return { code: 200, body: 'duplicate' };

  const prePerson = await personRef.get();
  if (!prePerson.exists) {
    // Didit 이 영원히 재시도하지 않도록 200 으로 받되, 사람 문서는 손대지 않는다.
    // `status:'orphan'` 이라 reconcile 스캔에 그대로 보인다. `decision` 을 쓰지 않으므로
    // 사람이 나중에 만들어져 같은 세션이 다시 오면 중복으로 삼켜지지 않고 정상 처리된다.
    await sessionRef.set(orphanStamp, { merge: true });
    return { code: 200, body: 'unknown person' };
  }

  // 결정이 실려 오지 않는 상태들. 진행 딱지만 바꾸고 접수 사실을 남긴다 — 절대 5xx 가 아니다.
  if (route.kind !== 'approve' && route.kind !== 'decline') {
    if (route.kind === 'unknown') warn('didit.webhook.unknownStatus', { sessionId, status });
    const patch = progressPatch(route, prePerson);
    await db.runTransaction(async (tx) => {
      if (isStamped(await tx.get(sessionRef))) return;
      if (patch) tx.set(personRef, patch, { merge: true });
      tx.set(sessionRef, sessionStamp, { merge: true });
    });
    if (route.kind === 'mark') return { code: 200, body: route.kycStatus };
    if (route.kind === 'reopen') return { code: 200, body: 'reopened' };
    return { code: 200, body: route.kind === 'unknown' ? 'ignored status' : 'pending' };
  }

  // 승인은 **얼굴 신호가 깨끗할 때만** 승인이다. 중복 경고가 하나라도 있으면 거절로 접는다.
  const approved = route.kind === 'approve' && faceSearchClear(envelope.decision);
  const target: PersonStatus = approved ? 'kyc_ok' : 'rejected';

  // 이미 레벨 1이면 다른 세션이 와도 체인에 다시 쓰지 않는다.
  if (approved && (prePerson.get('kycLevel') as number | undefined) === 1) {
    return { code: 200, body: 'already-level-1' };
  }

  // 전이가 막히면(예: register 가 아직 finalized 되지 않아 `pending`) 여기서 던진다.
  // 세션 도장도 봉투도 아직 쓰지 않았으므로 Didit 재배달이 그대로 다시 시도된다.
  const preStatus = prePerson.get('status') as PersonStatus | undefined;
  if (preStatus) assertStatusTransition(preStatus, target);
  else if (approved) assertStatusTransition('pending', target);

  // 개인정보는 KMS 봉투로만 저장한다. AAD 는 `personId:field` — 봉투를 다른 사람 문서나
  // 다른 필드로 옮겨 붙이면 열리지 않는다. KMS 왕복은 트랜잭션 **밖에서** 끝낸다.
  // 받지 못한 필드는 아예 쓰지 않는다 — 빈 문자열로 기존 봉투를 지우면 조용한 데이터 손실이다.
  const pii: Record<string, unknown> = {};
  if (approved) {
    // V3 는 `id_verifications[]` 로 보낸다. 없으면 예전 단수 `id_verification` 으로 물러난다.
    const identity = diditIdVerification(envelope.decision) ?? {};
    const fullName = `${identity.last_name ?? ''}${identity.first_name ?? ''}`.trim();
    const documentNumber = identity.document_number ?? '';
    // 원본 해상도 사진은 봉투에 **넣지 않는다.** 32 KB 스냅샷 한도 안으로 줄이고 EXIF 를
    // 털어낸 우리 규격 JPEG 만 저장한다(`lib/portrait.ts`). 원본 바이트는 여기서 끝난다.
    const rawPortrait = (identity.portrait_image ?? '').replace(/^data:image\/[a-z]+;base64,/, '');
    let portrait = '';
    try {
      portrait = normalizePortrait(rawPortrait);
    } catch (cause) {
      // 우리 규격으로 못 만든 사진은 **저장하지 않는다** — 원본을 그대로 넣으면 게이트가
      // JPEG 로 읽는 필드에 열리지 않는 바이트가 들어간다. 본인인증 자체는 통과시킨다:
      // 사진은 스태프 대조용 보조 수단이고, 포맷 하나 때문에 티켓을 막을 이유가 없다.
      if (!(cause instanceof PortraitError)) throw cause;
      warn('portrait.rejected', { sessionId, code: cause.code, bytes: rawPortrait.length });
    }
    const [encName, encDoc, encPhoto] = await Promise.all([
      fullName ? encryptField(fullName, piiAad(personId, 'name')) : Promise.resolve(''),
      documentNumber ? encryptField(documentNumber, piiAad(personId, 'docNumber')) : Promise.resolve(''),
      portrait ? encryptField(portrait, piiAad(personId, 'photo')) : Promise.resolve(''),
    ]);
    const enc: Record<string, string> = {};
    if (encName) enc.name = encName;
    if (encDoc) enc.docNumber = encDoc;
    if (Object.keys(enc).length > 0) pii.enc = enc;
    if (encPhoto) pii.photoEnc = encPhoto;
  }

  const personUpdate = approved
    ? {
        // 'kyc_ok' = 승인됐지만 setKycLevel 이 아직 확정되지 않은 중간 상태. reconcilePending 의 키다.
        status: 'kyc_ok',
        // `lastReason` 은 지난 시도의 거절 사유다. 승인에서 **반드시 지워야** 한다 —
        // Firestore 의 merge 는 맵을 깊이 합치므로, 그대로 두면 통과한 사람 문서에
        // 'duplicate_face' 가 남아 웹이 거절 안내를 그린다.
        kyc: { provider: 'didit', sessionId, status: 'approved', faceSearchOk: true, lastReason: null },
        ...pii,
        updatedAt: FieldValue.serverTimestamp(),
      }
    : {
        // 거절·중복 얼굴이면 레벨을 올리지 않고 status 만 'rejected' 로 둔다(kycLevel 은 0 그대로).
        status: 'rejected',
        kyc: {
          provider: 'didit',
          sessionId,
          status: 'rejected',
          // 닫힌 네 값 중 하나. 웹은 이 코드마다 다른 안내를 그린다(`KycDeclineReason`).
          // V3 의 `face_matches[]` · `aml_screenings[]` · `id_verifications[]` 경고까지 본다.
          lastReason: declineReasonFromDecision(status, envelope.decision),
        },
        updatedAt: FieldValue.serverTimestamp(),
      };

  // 사람 문서와 세션 도장은 한 트랜잭션에서 같이 커밋된다. 트랜잭션은 다시 읽고 다시 검사한다
  // — 사전 읽기 뒤에 다른 배달이 끼어들었어도 도장만 남고 복구 지점이 없는 상태는 생기지 않는다.
  const outcome = await db.runTransaction(async (tx) => {
    const session = await tx.get(sessionRef);
    const person = await tx.get(personRef);
    if (isStamped(session)) return 'duplicate';
    // 사전 읽기 뒤에 사람 문서가 사라졌어도 웹훅 입력으로 되살리지 않는다.
    if (!person.exists) {
      tx.set(sessionRef, orphanStamp, { merge: true });
      return 'orphan';
    }
    const current = person.get('status') as PersonStatus | undefined;
    if (current) assertStatusTransition(current, target);
    else if (approved) assertStatusTransition('pending', target);
    tx.set(personRef, personUpdate, { merge: true });
    tx.set(sessionRef, sessionStamp, { merge: true });
    return 'committed';
  });
  if (outcome !== 'committed') {
    return { code: 200, body: outcome === 'orphan' ? 'unknown person' : 'duplicate' };
  }
  if (!approved) return { code: 200, body: 'rejected' };

  // 여기부터 실패해도 사람은 `kyc_ok` 로 남는다 — reconcilePending 이 주워 간다.
  const txHash = await sendSetKycLevel(personId);
  const receipt = await publicClient().waitForTransactionReceipt({ hash: txHash, timeout: 30_000 });
  if (receipt.status !== 'success') {
    // 되돌린 해시를 `chain.kycLevelTx` 로 남기면 reconcilePending 이 "이미 보냈다"로 읽는다.
    // 해시는 버리고 사유만 남긴다. 사람은 `kyc_ok` 그대로라 재전송 대상으로 잡힌다.
    await personRef.set(
      { chain: { kycLevelError: 'reverted' }, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    return { code: 500, body: 'setKycLevel reverted' };
  }
  // 스펙 §10.4 규칙 3: finalized 뒤에만 DB를 완료 처리한다.
  await awaitFinalized(receipt.blockNumber);

  assertStatusTransition('kyc_ok', 'active');
  await personRef.set(
    {
      status: 'active',
      kycLevel: 1,
      kyc: {
        provider: 'didit',
        sessionId,
        status: 'approved',
        verifiedAt: FieldValue.serverTimestamp(),
        faceSearchOk: true,
        lastReason: null,
      },
      chain: { kycLevelTx: txHash, block: Number(receipt.blockNumber), kycLevelError: null },
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  return { code: 200, body: 'ok' };
}
