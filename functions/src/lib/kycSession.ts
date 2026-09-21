import { FieldValue } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import type { Hex } from '@monti/shared';
import { DIDIT_API_KEY, DIDIT_WORKFLOW_ID, RP_ID, expectedOrigins } from '../config.js';
import { PERSONS, db } from './db.js';
import { createDiditSession } from './didit.js';

export interface KycSession {
  kycUrl: string;
  sessionId: string;
}

/**
 * `opening` 도장의 수명. 세션을 만들다 죽은 호출이 이 시간을 넘기면 다음 호출이 가져간다 —
 * 도장이 영구 잠금이 되면 한 번 죽은 순간부터 그 사람은 영영 본인인증을 못 한다.
 */
const CLAIM_TTL_SECONDS = 60;

/** 웹이 복귀 주소를 넘기지 않았을 때의 기본값. */
export function defaultCallbackUrl(): string {
  return `https://${RP_ID.value()}/kyc/callback`;
}

/**
 * 복귀 주소는 **우리 origin** 이어야 한다. Didit 은 검증을 마친 사람의 브라우저를 이 주소로
 * 그대로 보내므로, 받은 값을 그냥 쓰면 우리 인증 흐름이 임의 사이트를 여는 열린 리디렉트가 된다.
 *
 * 허용 목록은 패스키와 **같은** `expectedOrigins()` 를 쓴다 — `https://<RP_ID>` 와 `DEV_ORIGINS`.
 * 안드로이드의 `android:apk-key-hash:…` origin 은 브라우저가 열 수 있는 주소가 아니라
 * 여기서 걸러진다(http/https 만 남긴다).
 */
export function assertCallbackUrl(candidate: unknown): string {
  if (typeof candidate !== 'string') throw new HttpsError('invalid-argument', 'BAD_CALLBACK_URL');

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new HttpsError('invalid-argument', 'BAD_CALLBACK_URL');
  }

  const allowed = new Set<string>();
  for (const origin of expectedOrigins()) {
    try {
      const parsed = new URL(origin);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') allowed.add(parsed.origin);
    } catch {
      // URL 이 아닌 origin(apk-key-hash)은 복귀 주소가 될 수 없다.
    }
  }
  if (!allowed.has(url.origin)) throw new HttpsError('invalid-argument', 'BAD_CALLBACK_URL');
  return url.toString();
}

type Claim = { reuse: KycSession } | { busy: true } | { claimed: true };

/**
 * 이 사람의 **열린** 본인인증 세션을 돌려준다. 없으면 하나 연다.
 *
 * Didit 은 **완료된 세션** 기준으로 과금한다. 관객이 링크를 놓치고 다시 누를 때마다 새 세션을
 * 만들면 그만큼 돈이 나가고, 웹훅이 옛 세션의 결정을 늦게 들고 와 방금 연 세션을 덮어쓴다.
 * 돈보다 나쁜 것은 **갈라진 세션**이다 — `processDeletions` 는 우리가 기록한 세션만 지우므로,
 * 기록에서 밀려난 세션의 얼굴 템플릿은 Didit 서버에 영원히 남는다.
 *
 * 그래서 읽기와 쓰기를 **한 트랜잭션**에 넣어 동시에 들어온 두 호출 중 하나만 도장을 찍게 한다.
 * HTTP 왕복은 트랜잭션 **밖**이다 — 안에 넣으면 Firestore 의 경합 재시도가 본문을 통째로 다시
 * 돌려 Didit 세션을 한 번 더 만들고, 버려진 그 세션이 바로 위에서 말한 갈라진 세션이 된다.
 *
 * `kycSessionIds` 는 지금까지 연 **모든** 세션 id 다. 파기(`processDeletions`)는 이 목록을
 * 전부 지운다 — 복귀 주소가 달라져 새 세션을 열었을 때 옛 세션이 버려지지 않게 하는 장치다.
 *
 * 세션을 연다고 레벨이 오르지는 않는다 — `kycLevel` 을 올리는 곳은 `diditWebhook` 하나뿐이고,
 * 체인 쓰기도 거기서 한다(스펙 §10.4 규칙 3).
 */
export async function ensureKycSession(personId: Hex, callbackUrl: string): Promise<KycSession> {
  const personRef = db.collection(PERSONS).doc(personId);
  const now = Math.floor(Date.now() / 1000);

  const claim = await db.runTransaction<Claim>(async (tx) => {
    const person = await tx.get(personRef);
    const status = person.get('kyc.status') as string | undefined;

    if (status === 'open') {
      const url = person.get('kyc.url') as string | undefined;
      const sessionId = person.get('kyc.sessionId') as string | undefined;
      // 복귀 주소가 다르면 재사용할 수 없다. Didit 은 세션을 만들 때 받은 주소로만 돌려보내므로,
      // A 공연에서 시작한 링크를 B 공연에서 그대로 쓰면 검증을 마치고 A 로 돌아간다.
      const sameCallback = (person.get('kyc.callbackUrl') as string | undefined) === callbackUrl;
      if (url && sessionId && sameCallback) return { reuse: { kycUrl: url, sessionId } };
    }

    // 다른 호출이 방금 도장을 찍고 Didit 을 부르는 중이다. 두 번째 세션을 만들지 않는다.
    if (status === 'opening' && now - ((person.get('kyc.claimedAt') as number | undefined) ?? 0) < CLAIM_TTL_SECONDS) {
      return { busy: true };
    }

    tx.set(
      personRef,
      {
        // 새 시도가 시작됐다. 지난 거절 사유가 남아 있으면 웹이 방금 연 세션에 그것을 그린다.
        kyc: { status: 'opening', claimedAt: now, lastReason: null },
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    return { claimed: true };
  });

  if ('reuse' in claim) return claim.reuse;
  if ('busy' in claim) throw new HttpsError('aborted', 'KYC_SESSION_IN_FLIGHT');

  let session: Awaited<ReturnType<typeof createDiditSession>>;
  try {
    session = await createDiditSession(
      personId, // vendor_data = 난수 personId. 개인정보는 넣지 않는다.
      DIDIT_API_KEY.value(),
      DIDIT_WORKFLOW_ID.value(),
      callbackUrl,
    );
  } catch (cause) {
    // 도장을 풀어 준다. 그대로 두면 이 사람은 TTL 이 지날 때까지 다시 시도할 수 없다.
    await personRef.set({ kyc: { status: FieldValue.delete(), claimedAt: FieldValue.delete() } }, { merge: true });
    throw cause;
  }

  await personRef.set(
    {
      kyc: {
        provider: 'didit',
        sessionId: session.sessionId,
        url: session.url,
        callbackUrl,
        status: 'open',
        // 이 세션을 **만든** 시각. 버려진 세션 스윕(`reconcilePending`)이 나이를 여기서 잰다 —
        // 사람 문서의 `updatedAt` 은 상관없는 쓰기에도 앞으로 가서 쓸 수 없고, 재사용 경로는
        // 아무것도 쓰지 않으므로 링크를 다시 눌러도 이 값은 그대로 늙는다(Didit 수명과 같다).
        openedAt: now,
        claimedAt: FieldValue.delete(),
        lastReason: null,
      },
      // 파기 때 지워야 할 세션 전부. 여기 없는 세션은 영영 못 지운다.
      kycSessionIds: FieldValue.arrayUnion(session.sessionId),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  return { kycUrl: session.url, sessionId: session.sessionId };
}
