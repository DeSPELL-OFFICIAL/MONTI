import { FieldValue } from 'firebase-admin/firestore';
import { warn } from 'firebase-functions/logger';
import { onRequest } from 'firebase-functions/v2/https';
import type { Hex, PersonStatus } from '@monti/shared';
import { ATTESTER_PK, DIDIT_WEBHOOK_SECRET } from '../config.js';
import { awaitFinalized, publicClient } from '../lib/chain.js';
import { KYC_SESSIONS, PERSONS, assertStatusTransition, db } from '../lib/db.js';
import { declineReason, redactDiditPayload, verifyDiditSignature } from '../lib/didit.js';
import { encryptField, piiAad } from '../lib/kms.js';
import { PortraitError, normalizePortrait } from '../lib/portrait.js';
import { sendSetKycLevel } from '../lib/kycLevel.js';

const PERSON_ID_RE = /^0x[0-9a-fA-F]{64}$/;
const TERMINAL = ['Approved', 'Declined', 'Expired', 'Abandoned'];

interface DiditBody {
  session_id?: string;
  status?: string;
  vendor_data?: string;
  decision?: {
    face_search?: { status?: string };
    id_verification?: {
      first_name?: string;
      last_name?: string;
      document_number?: string;
      portrait_image?: string;
    };
  };
}

/**
 * Didit 웹훅. 본문은 **절대** 응답이나 로그로 되돌려 보내지 않는다 — 실패 응답은 고정 문자열뿐이다.
 *
 *  1. POST 가 아니면 405. 그다음 `req.rawBody` 바이트에 대한 HMAC-SHA256 을 상수 시간으로 맞춰 본다.
 *  2. KMS 를 부르기 전에 세션 중복과 상태 전이를 **먼저 읽어** 걸러낸다. 여기서 막히면
 *     세션에 도장을 찍지 않으므로 Didit 재배달이 그대로 다시 시도된다.
 *  3. 사람 문서(`status:'kyc_ok'` + `kyc.sessionId` + PII 봉투)와 세션 도장을 **한 트랜잭션**에서
 *     쓴다. 둘 다 있거나 둘 다 없다 — "처리됨" 도장만 남고 복구 지점이 없는 창이 사라진다.
 *  4. 체인 호출은 커밋 **뒤에** 한다. 여기서 죽거나 터져도 사람은 `kyc_ok` 로 남고,
 *     `reconcilePending` 이 `status === 'kyc_ok'` 이면서 `chain.kycLevelTx` 가 **없는** 사람을
 *     골라 같은 `sendSetKycLevel` 로 다시 보낸다(단순 대입이라 재전송이 안전하다).
 *     아래 revert 경로가 해시를 일부러 버리는 것도 그래서다 — 해시가 없어야 복구가 집어 간다.
 *  5. finalized 된 다음에만 `active` / `kycLevel: 1` / `chain.kycLevelTx` 를 쓴다(스펙 §10.4 규칙 3).
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
    const ok = verifyDiditSignature({
      raw,
      signature: String(req.get('X-Signature-V2') ?? ''),
      timestamp: Number(req.get('X-Timestamp') ?? '0'),
      secret: DIDIT_WEBHOOK_SECRET.value(),
      now: Math.floor(Date.now() / 1000),
    });
    if (!ok) {
      res.status(401).send('bad signature');
      return;
    }

    let body: DiditBody;
    try {
      body = JSON.parse(raw) as DiditBody;
    } catch {
      res.status(400).send('bad json');
      return;
    }

    const sessionId = body.session_id;
    const personId = body.vendor_data as Hex | undefined;
    if (!sessionId || !personId || !PERSON_ID_RE.test(personId)) {
      res.status(400).send('missing session or vendor_data');
      return;
    }

    const sessionRef = db.collection(KYC_SESSIONS).doc(sessionId);
    const personRef = db.collection(PERSONS).doc(personId);
    const decision = body.status ?? 'Unknown';
    const faceSearch = body.decision?.face_search?.status ?? null;

    // 받은 본문을 통째로 넣지 않는다. 여기 적힌 결정 필드만 추려 담고, 그 위에 레닥션을
    // 한 번 더 건다 — Didit 이 새 개인정보 필드를 추가해도 저장 경로로 샐 수 없다(스펙 §10.3).
    const sessionStamp = {
      personId,
      status: decision,
      decision,
      raw: redactDiditPayload({
        session_id: sessionId,
        status: decision,
        vendor_data: personId,
        decision: { face_search: { status: faceSearch } },
      }),
      receivedAt: FieldValue.serverTimestamp(),
    };
    const isStamped = (snap: { exists: boolean; get: (field: string) => unknown }): boolean =>
      snap.exists && snap.get('decision') === decision;

    // 우리가 만든 적 없는 `vendor_data` 로는 사람 문서를 만들지 않는다. 웹훅 입력이 곧
    // 새 사람이 되는 길을 열면 아무나 `persons/{아무 32바이트}` 를 찍어낼 수 있다.
    // 세션 id 와 사유만 남긴다 — 이 세 필드 말고는 아무것도 쓰지 않는다.
    const orphanStamp = { sessionId, status: 'orphan', reason: 'unknown_person' };

    // 사전 읽기. KMS 왕복과 트랜잭션에 들어가기 전에 중복·존재·전이를 먼저 걸러낸다.
    if (isStamped(await sessionRef.get())) {
      res.status(200).send('duplicate');
      return;
    }

    const prePerson = await personRef.get();
    if (!prePerson.exists) {
      // Didit 이 영원히 재시도하지 않도록 200 으로 받되, 사람 문서는 손대지 않는다.
      // `status:'orphan'` 이라 reconcile 스캔에 그대로 보인다. `decision` 을 쓰지 않으므로
      // 사람이 나중에 만들어져 같은 세션이 다시 오면 중복으로 삼켜지지 않고 정상 처리된다.
      await sessionRef.set(orphanStamp, { merge: true });
      res.status(200).send('unknown person');
      return;
    }

    // 비종료 상태는 사람 문서를 건드릴 것이 없다. 접수 사실만 남긴다.
    if (!TERMINAL.includes(decision)) {
      await db.runTransaction(async (tx) => {
        if (isStamped(await tx.get(sessionRef))) return;
        tx.set(sessionRef, sessionStamp, { merge: true });
      });
      res.status(200).send('pending');
      return;
    }

    const approved = decision === 'Approved' && faceSearch === 'clear';
    const target: PersonStatus = approved ? 'kyc_ok' : 'rejected';

    // 이미 레벨 1이면 다른 세션이 와도 체인에 다시 쓰지 않는다.
    if (approved && (prePerson.get('kycLevel') as number | undefined) === 1) {
      res.status(200).send('already-level-1');
      return;
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
      const identity = body.decision?.id_verification ?? {};
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
            lastReason: declineReason(decision, faceSearch),
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
      res.status(200).send(outcome === 'orphan' ? 'unknown person' : 'duplicate');
      return;
    }
    if (!approved) {
      res.status(200).send('rejected');
      return;
    }

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
      res.status(500).send('setKycLevel reverted');
      return;
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

    res.status(200).send('ok');
  },
);
