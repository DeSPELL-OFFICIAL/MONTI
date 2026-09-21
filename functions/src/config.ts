import { setGlobalOptions } from 'firebase-functions/v2';
import { defineSecret, defineString } from 'firebase-functions/params';
import { FIREBASE_REGION, MONAD_TESTNET_CHAIN_ID, MONAD_TESTNET_RPC_URL } from '@monti/shared';

export const REGION = FIREBASE_REGION;

setGlobalOptions({ region: REGION, maxInstances: 20, memory: '512MiB', timeoutSeconds: 60 });

export const RP_ID = defineString('RP_ID', { default: 'monti.app' });
export const RP_NAME = defineString('RP_NAME', { default: 'MONTI' });
export const ANDROID_APK_KEY_HASH = defineString('ANDROID_APK_KEY_HASH', { default: '' });
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

/**
 * Android WebView는 origin을 `android:apk-key-hash:<base64url SHA-256>`로 보낸다.
 * 두 origin을 모두 받지 않으면 안드로이드 껍데기의 패스키가 전부 거부된다(마스터 계획 Global Constraints).
 */
export function expectedOrigins(): string[] {
  const origins = [`https://${RP_ID.value()}`];
  const hash = ANDROID_APK_KEY_HASH.value();
  if (hash) origins.push(`android:apk-key-hash:${hash}`);
  return origins;
}
