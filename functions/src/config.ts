import { setGlobalOptions } from 'firebase-functions/v2';
import { defineSecret, defineString } from 'firebase-functions/params';
import { FIREBASE_REGION, MONAD_TESTNET_CHAIN_ID, MONAD_TESTNET_RPC_URL } from '@monti/shared';

export const REGION = FIREBASE_REGION;

setGlobalOptions({ region: REGION, maxInstances: 20, memory: '512MiB', timeoutSeconds: 60 });

export const RP_ID = defineString('RP_ID', { default: 'monti.despell.io' });
export const RP_NAME = defineString('RP_NAME', { default: 'MONTI' });
/**
 * 안드로이드 앱의 서명 인증서 해시. 앱마다 서명 인증서가 다르므로 **쉼표로 구분한 목록**을 받는다
 * (참석자 `app.monti`, 스태프 `app.monti.staff`). 한 개만 넣어도 되고, 비워 두면 안드로이드 origin 은 없다.
 * 값은 서명 인증서의 SHA-256 을 base64url 로 쓴 것 — 패딩 없이 정확히 43글자다.
 */
export const ANDROID_APK_KEY_HASH = defineString('ANDROID_APK_KEY_HASH', { default: '' });
/**
 * 개발용 origin 목록(쉼표로 구분). 배포는 **비워 둔 채** 나간다.
 * 로컬 주소를 코드에 박아 두면 그 origin 이 운영 서버에서도 패스키를 통과시킨다.
 */
export const DEV_ORIGINS = defineString('DEV_ORIGINS', { default: '' });
export const CHAIN_ID = defineString('CHAIN_ID', { default: String(MONAD_TESTNET_CHAIN_ID) });
export const RPC_URL = defineString('RPC_URL', { default: MONAD_TESTNET_RPC_URL });
export const ENVIO_GRAPHQL_URL = defineString('ENVIO_GRAPHQL_URL', {
  default: 'http://127.0.0.1:8080/v1/graphql',
});
export const EXPORT_BUCKET = defineString('EXPORT_BUCKET', { default: 'monti-exports' });
export const IPFS_GATEWAY = defineString('IPFS_GATEWAY', { default: 'https://gateway.pinata.cloud/ipfs' });
export const BIGQUERY_DATASET = defineString('BIGQUERY_DATASET', { default: 'monti' });

export const ATTESTER_PK = defineSecret('ATTESTER_PK');
export const PHONE_INDEX_KEY = defineSecret('PHONE_INDEX_KEY');
export const DIDIT_API_KEY = defineSecret('DIDIT_API_KEY');
export const DIDIT_WORKFLOW_ID = defineSecret('DIDIT_WORKFLOW_ID');
export const DIDIT_WEBHOOK_SECRET = defineSecret('DIDIT_WEBHOOK_SECRET');
export const TENDERLY_WEBHOOK_SECRET = defineSecret('TENDERLY_WEBHOOK_SECRET');
/** Pinata 업로드 키. 서버에만 있다 — 브라우저가 들면 누구나 우리 계정에 파일을 올린다. */
export const PINATA_JWT = defineSecret('PINATA_JWT');

/** base64url SHA-256 은 패딩 없이 정확히 43글자다. `keytool` 이 뱉는 `AB:CD:…` 16진수는 여기 들어갈 값이 아니다. */
const APK_KEY_HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Android WebView는 origin을 `android:apk-key-hash:<base64url SHA-256>`로 보낸다.
 * 이 origin을 받지 않으면 안드로이드 껍데기의 패스키가 전부 거부된다(마스터 계획 Global Constraints).
 *
 * 안드로이드 앱이 둘(참석자 `app.monti`, 스태프 `app.monti.staff`)이고 서명 인증서가 서로 다르므로
 * `ANDROID_APK_KEY_HASH` 는 **쉼표로 구분한 목록**이다. 적힌 순서대로 origin 을 하나씩 만든다.
 *
 * 마지막으로 `DEV_ORIGINS` 에 적힌 주소를 **적힌 그대로** 덧붙인다. 개발자가 자기 환경에
 * 넣어야만 열리고, 운영 배포는 이 값을 비워 두므로 `http://localhost:…` 가 서버 코드에 남지 않는다.
 */
export function expectedOrigins(): string[] {
  const origins = [`https://${RP_ID.value()}`];
  for (const entry of ANDROID_APK_KEY_HASH.value().split(',')) {
    const hash = entry.trim();
    if (!hash) continue;
    if (!APK_KEY_HASH_PATTERN.test(hash)) {
      throw new Error(
        `ANDROID_APK_KEY_HASH: "${hash}" is not an APK signing-cert hash. Every entry must be the ` +
          "signing certificate's SHA-256 in base64url — exactly 43 characters of A-Z a-z 0-9 - _ — " +
          'and one app per entry, separated by commas.',
      );
    }
    origins.push(`android:apk-key-hash:${hash}`);
  }
  for (const origin of DEV_ORIGINS.value().split(',')) {
    const trimmed = origin.trim();
    if (trimmed) origins.push(trimmed);
  }
  return origins;
}
