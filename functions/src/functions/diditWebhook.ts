import { FieldValue } from 'firebase-admin/firestore';
import { onRequest } from 'firebase-functions/v2/https';
import type { Hex, PersonStatus } from '@monti/shared';
import { ATTESTER_PK, DIDIT_WEBHOOK_SECRET } from '../config.js';
import { awaitFinalized, deployment, publicClient, sendAttesterTx } from '../lib/chain.js';
import { KYC_SESSIONS, PERSONS, assertStatusTransition, db } from '../lib/db.js';
import { identityKycAbi, redactDiditPayload, verifyDiditSignature } from '../lib/didit.js';
import { encryptField, piiAad } from '../lib/kms.js';

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
 *  1. `req.rawBody` 바이트에 대한 HMAC-SHA256 을 상수 시간으로 맞춰 본다(파싱된 JSON 이 아니다).
 *  2. `kycSessions/{session_id}` 를 트랜잭션에서 먼저 읽어 같은 결정의 재배달을 no-op 으로 끝낸다.
 *  3. 승인 + Face Search `clear` 면 `kyc_ok` 로 두고 `setKycLevel(personId, 1)` 을 보낸 뒤,
 *     **finalized 된 다음에만** `active` / `kycLevel: 1` 을 쓴다(스펙 §10.4 규칙 3).
 *     중간에 죽어도 `reconcilePending` 이 `kyc_ok` 를 복구한다.
 *  4. 거절·중복 얼굴이면 `rejected` 로만 두고 `kycLevel` 은 0 그대로다.
 */
export const diditWebhook = onRequest(
  { secrets: [DIDIT_WEBHOOK_SECRET, ATTESTER_PK], cors: false, invoker: 'public', timeoutSeconds: 120 },
  async (req, res) => {
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
    const faceSearch = body.decision?.face_search?.status ?? null;
    const duplicate = await db.runTransaction(async (tx) => {
      const current = await tx.get(sessionRef);
      if (current.exists && current.get('decision') === body.status) return true;
      tx.set(
        sessionRef,
        {
          personId,
          status: body.status ?? 'Unknown',
          decision: body.status ?? 'Unknown',
          // 받은 본문을 통째로 넣지 않는다. 여기 적힌 결정 필드만 추려 담고, 그 위에 레닥션을
          // 한 번 더 건다 — Didit 이 새 개인정보 필드를 추가해도 저장 경로로 샐 수 없다(스펙 §10.3).
          raw: redactDiditPayload({
            session_id: sessionId,
            status: body.status ?? 'Unknown',
            vendor_data: personId,
            decision: { face_search: { status: faceSearch } },
          }),
          receivedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      return false;
    });
    if (duplicate) {
      res.status(200).send('duplicate');
      return;
    }

    if (!TERMINAL.includes(body.status ?? '')) {
      res.status(200).send('pending');
      return;
    }

    const faceSearchOk = faceSearch === 'clear';
    const approved = body.status === 'Approved' && faceSearchOk;
    const personRef = db.collection(PERSONS).doc(personId);

    // 거절·중복 얼굴이면 레벨을 올리지 않고 status 만 'rejected' 로 둔다(kycLevel 은 0 그대로).
    if (!approved) {
      const current = (await personRef.get()).get('status') as PersonStatus | undefined;
      if (current) assertStatusTransition(current, 'rejected');
      await personRef.set(
        {
          status: 'rejected',
          kyc: {
            provider: 'didit',
            sessionId,
            status: 'rejected',
            // Didit 이 준 자유 문장이 아니라 우리가 정한 코드만 쓴다.
            rejectedReason: body.status === 'Approved' ? 'duplicate_face' : 'declined',
          },
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      res.status(200).send('rejected');
      return;
    }

    // 여기부터는 승인된 경우다. 개인정보는 KMS 봉투로만 저장한다. 평문은 어디에도 남지 않는다.
    // AAD 는 `personId:field` — 봉투를 다른 사람 문서나 다른 필드로 옮겨 붙이면 열리지 않는다.
    const identity = body.decision?.id_verification ?? {};
    const fullName = `${identity.last_name ?? ''}${identity.first_name ?? ''}`.trim();
    const portrait = (identity.portrait_image ?? '').replace(/^data:image\/[a-z]+;base64,/, '');
    const [encName, encDoc, encPhoto] = await Promise.all([
      fullName ? encryptField(fullName, piiAad(personId, 'name')) : Promise.resolve(''),
      identity.document_number
        ? encryptField(identity.document_number, piiAad(personId, 'docNumber'))
        : Promise.resolve(''),
      portrait ? encryptField(portrait, piiAad(personId, 'photo')) : Promise.resolve(''),
    ]);
    await personRef.set({ enc: { name: encName, docNumber: encDoc }, photoEnc: encPhoto }, { merge: true });

    // 웹훅 재시도 멱등: 이미 레벨 1이면 체인에 다시 쓰지 않는다.
    const person = await personRef.get();
    if ((person.get('kycLevel') as number | undefined) === 1) {
      res.status(200).send('already-level-1');
      return;
    }

    // 승인됐지만 setKycLevel 이 아직 확정되지 않은 중간 상태가 'kyc_ok' 다.
    const before = (person.get('status') ?? 'pending') as PersonStatus;
    assertStatusTransition(before, 'kyc_ok');
    await personRef.set({ status: 'kyc_ok', updatedAt: FieldValue.serverTimestamp() }, { merge: true });

    const txHash = await sendAttesterTx({
      address: deployment().identity,
      abi: identityKycAbi,
      functionName: 'setKycLevel',
      args: [personId, 1],
    });
    // 해시를 먼저 남긴다. 여기서 죽어도 reconcilePending 이 kyc_ok 를 복구한다.
    await personRef.set({ chain: { kycLevelTx: txHash } }, { merge: true });
    const receipt = await publicClient().waitForTransactionReceipt({ hash: txHash, timeout: 30_000 });
    if (receipt.status !== 'success') {
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
          faceSearchOk,
        },
        chain: { kycLevelTx: txHash, block: Number(receipt.blockNumber) },
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    res.status(200).send('ok');
  },
);
