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

/**
 * 이 사람의 **열린** 본인인증 세션을 돌려준다. 없으면 하나 연다.
 *
 * Didit 은 **완료된 세션** 기준으로 과금한다. 관객이 링크를 놓치고 다시 누를 때마다 새 세션을
 * 만들면 그만큼 돈이 나가고, 웹훅이 옛 세션의 결정을 늦게 들고 와 방금 연 세션을 덮어쓴다.
 * 그래서 `kyc.status === 'open'` 이면 **같은 링크를 그대로** 돌려준다.
 *
 * 세션을 연다고 레벨이 오르지는 않는다 — `kycLevel` 을 올리는 곳은 `diditWebhook` 하나뿐이고,
 * 체인 쓰기도 거기서 한다(스펙 §10.4 규칙 3).
 */
export async function ensureKycSession(personId: Hex, callbackUrl: string): Promise<KycSession> {
  const personRef = db.collection(PERSONS).doc(personId);
  const person = await personRef.get();

  if (person.get('kyc.status') === 'open') {
    const url = person.get('kyc.url') as string | undefined;
    const sessionId = person.get('kyc.sessionId') as string | undefined;
    if (url && sessionId) return { kycUrl: url, sessionId };
  }

  const session = await createDiditSession(
    personId, // vendor_data = 난수 personId. 개인정보는 넣지 않는다.
    DIDIT_API_KEY.value(),
    DIDIT_WORKFLOW_ID.value(),
    callbackUrl,
  );

  await personRef.set(
    {
      kyc: {
        provider: 'didit',
        sessionId: session.sessionId,
        url: session.url,
        status: 'open',
        // 새 시도가 시작됐다. 지난 거절 사유가 남아 있으면 웹이 방금 연 세션에 그것을 그린다.
        lastReason: null,
      },
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  return { kycUrl: session.url, sessionId: session.sessionId };
}
