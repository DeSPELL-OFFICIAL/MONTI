import deployment10143 from './deployments/10143.json';
import type { Hex } from './types.js';

export const MONAD_TESTNET_CHAIN_ID = 10143;
export const MONAD_MAINNET_CHAIN_ID = 143;
export const MONAD_TESTNET_RPC_URL = 'https://testnet-rpc.monad.xyz';
export const MONAD_MAINNET_RPC_URL = 'https://rpc.monad.xyz';

/** 로직에 체인 id를 박지 않는다. CHAIN_ID / VITE_CHAIN_ID 하나로 메인넷으로 넘어간다. */
export const DEFAULT_CHAIN_ID = Number(
  (typeof process !== 'undefined' ? process.env?.CHAIN_ID : undefined) ?? MONAD_TESTNET_CHAIN_ID,
);

export const ENTRY_POINT_V06_ADDRESS = '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789' as Hex;
export const P256_PRECOMPILE_ADDRESS = '0x0000000000000000000000000000000000000100' as Hex;
export const CREATE2_DEPLOYER_ADDRESS = '0x4e59b44847b379578588920cA78FbF26c0B4956C' as Hex;
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Hex;

/** Monad는 gas_limit 기준 과금이다. 모든 쓰기는 estimate × 1.075를 명시한다. */
export const GAS_LIMIT_MULTIPLIER_BPS = 10_750n;
export const BPS_DENOMINATOR = 10_000n;

export function withGasMargin(estimate: bigint): bigint {
  if (estimate < 0n) throw new Error('NEGATIVE_GAS_ESTIMATE');
  return (estimate * GAS_LIMIT_MULTIPLIER_BPS) / BPS_DENOMINATOR;
}

export const HCE_AID = 'D2760000850101';
export const NDEF_GATE_TYPE = 'monti.app:g';
export const NDEF_RESPONSE_TYPE = 'monti.app:s';

/**
 * NFC 쓰기가 불가능한 기기(아이폰 브라우저 접속자)를 위한 QR 폴백 문자열의 접두사.
 * `GateResponseWire` CBOR를 base64url로 실어 `MONTI1:<body>` 형태로 만든다.
 */
export const QR_PREFIX = 'MONTI1:';

/**
 * P-256(secp256r1) 군의 위수 `n` 과 그 절반. Solady 의 `P256.verifySignature` 가 `s > n/2`
 * 서명을 거부하므로(가변성 방지), 기기 키 서명을 체인에 올리는 쪽은 예외 없이 이 경계로
 * 판단한다. 값이 두 군데 있으면 한쪽만 고쳐지고 체크인 절반이 조용히 되돌려진다.
 */
export const P256_ORDER = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
export const P256_HALF_ORDER = P256_ORDER / 2n;

/**
 * 관객 기기 키가 서명하는 다이제스트의 형식. 두 가지가 있고, 어느 쪽인지는 **배포된**
 * Ticket 이 정한다.
 *
 * - `v1-fiveField` — `sha256(abi.encode(tokenId, gateId, eventId, nonce, issuedAt))`.
 *   은퇴한 배포본(Ticket `0xE9686503c4d675B0B1Ec9DE19AbEC51Fc59F1113`)의 `checkIn` 이
 *   검증하던 형식이다. 이 값을 받아 주는 컨트랙트는 이제 없다.
 * - `v2-domainSeparated` — 앞에 `chainId` 와 Ticket 주소 두 워드를 붙인 7워드 형식.
 *   01b 번들이 `Ticket._deviceDigest` 로 들여왔고, **지금 배포된** 것이 이쪽이다 —
 *   2026-09-23 재배포, chain 10143, Ticket `0x4B8353C9F3503Cdbd011E8f35da0a955D95b1367`.
 *
 * 그 재배포(01b 계획의 Task 15)가 끝났으므로 이 한 줄은 `v2-domainSeparated` 이고,
 * 서명·검증·QR 이 한꺼번에 여기에 따라온다. 형식을 고르는 곳은 여기 하나뿐이다.
 */
export type DeviceDigestForm = 'v1-fiveField' | 'v2-domainSeparated';
export const DEVICE_DIGEST_FORM: DeviceDigestForm = 'v2-domainSeparated';

export const GATE_CODE_ROTATE_MS = 3_000;
export const CODE_WINDOW_SECONDS = 60;
/**
 * `Ticket.LATE_WINDOW`. 오프라인 큐가 뒤늦게 밀어 넣는 `checkInLate` 가 받아 주는 폭이다 —
 * 코드는 개장 12시간 전부터 유효하고, 제출은 종료 12시간 뒤까지 받는다. 체인 읽기
 * (`LATE_WINDOW()`)가 있는 화면은 그쪽을 먼저 쓴다. 이 상수는 읽기 전에 미리 그릴 때만이다.
 */
export const LATE_WINDOW_SECONDS = 43_200;
/**
 * `Ticket.MIGRATE_DELAY`. 회수된 계정을 티켓이 따라가기까지 기다리는 시간이고, 설계상
 * `Identity.ROTATION_UNDO_WINDOW` 와 같은 값이다 — 컨트랙트 테스트가 그 동치를 단언한다.
 * 여기서도 체인 읽기(`MIGRATE_DELAY()` / `ROTATION_UNDO_WINDOW()`)가 있으면 그쪽이 먼저다.
 */
export const MIGRATE_DELAY_SECONDS = 86_400;
/**
 * `Ticket.CLOCK_SKEW`. 게이트 폰 시계가 체인보다 이만큼 앞서 가는 것까지는 위조가 아니다.
 * 관객 폰도 같은 값으로 판단해야 체인이 받아 줄 코드를 먼저 거절하지 않는다.
 */
export const CLOCK_SKEW_SECONDS = 5;
export const ARM_WINDOW_SECONDS = 60;
export const ROTATION_COOLDOWN_SECONDS = 7 * 24 * 60 * 60;
export const DEVICE_COOLDOWN_SECONDS = 7 * 24 * 60 * 60;
export const DIDIT_WEBHOOK_TOLERANCE_SECONDS = 300;
export const SNAPSHOT_TTL_SECONDS = 12 * 60 * 60;
export const AUTH_CHALLENGE_TTL_SECONDS = 300;

export const FIREBASE_REGION = 'us-east1';

/**
 * 관객 화면 카피에 등장하면 안 되는 금지어 목록(스펙 §3.2).
 * 매칭 규칙은 `copy-lint.ts`가 결정한다:
 * - 한글 낱말은 부분 문자열로 매칭한다.
 * - 영어 낱말은 단어 경계(`\bword\b`)로 매칭해 `tokenId`·`gasLimit`·`chainId` 같은 식별자를 흘려보낸다.
 * - `NFT`만 예외로, ASCII지만 부분 문자열로(대소문자 무시) 매칭한다.
 * 모든 매칭은 대소문자를 무시한다.
 */
export const BANNED_ATTENDEE_WORDS: readonly string[] = [
  '지갑',
  'NFT',
  '민팅',
  '가스',
  '체인',
  '토큰',
  '트랜잭션',
  'wallet',
  'mint',
  'gas',
  'chain',
  'token',
  'transaction',
  'blockchain',
  'monad',
];

/** 이벤트 채팅 한 메시지 상한. Firestore 규칙과 서버가 같은 값을 쓴다. */
export const EVENT_CHAT_MESSAGE_MAX_CHARS = 500;
/** 전화번호 양도 초대 유효기간. */
export const TRANSFER_INVITE_TTL_SECONDS = 7 * 24 * 60 * 60;
/** 종료된 이벤트 채팅을 닫는 스케줄. */
export const CHAT_CLOSE_SCHEDULE = 'every 10 minutes';
/** 사용자가 직접 쓸 수 있는 유일한 필드들. Firestore 규칙과 정합성 테스트가 함께 쓴다. */
export const USER_WRITABLE_FIELDS = ['nickname', 'locale', 'chatOrder', 'displayName'] as const;

export interface Deployment {
  chainId: number;
  /** 01의 Deploy.s.sol 이 기록한 배포 블록. 인덱서의 start_block 이 된다. */
  block: number;
  identity: Hex;
  organizers: Hex;
  ticket: Hex;
  paymaster: Hex;
  attester: Hex;
  coinbaseFactory: Hex;
  entryPoint: Hex;
}

const ADDRESS_FIELDS = [
  'identity',
  'organizers',
  'ticket',
  'paymaster',
  'attester',
  'coinbaseFactory',
  'entryPoint',
] as const;

/**
 * `expectedChainId`를 넘기면 파일 본문의 `chainId`가 그 키와 같은지까지 확인한다.
 * `10143.json` 안에 `chainId: 143`이 들어 있는 식의 잘못 묶인 배포는 조용히 통과하지 않고
 * `DEPLOYMENT_CHAIN_MISMATCH:<요청한 chainId>` 로 크게 실패한다. 폴백은 없다.
 */
export function parseDeployment(raw: unknown, expectedChainId?: number): Deployment {
  if (typeof raw !== 'object' || raw === null) throw new Error('BAD_DEPLOYMENT');
  const value = raw as Record<string, unknown>;
  if (typeof value.chainId !== 'number') throw new Error('BAD_DEPLOYMENT_FIELD:chainId');
  if (typeof value.block !== 'number' || value.block < 0) {
    throw new Error('BAD_DEPLOYMENT_FIELD:block');
  }
  const out: Record<string, unknown> = { chainId: value.chainId, block: value.block };
  for (const field of ADDRESS_FIELDS) {
    const address = value[field];
    if (typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
      throw new Error(`BAD_DEPLOYMENT_FIELD:${field}`);
    }
    out[field] = address as Hex;
  }
  const deployment = out as unknown as Deployment;
  if (expectedChainId !== undefined && deployment.chainId !== expectedChainId) {
    throw new Error(`DEPLOYMENT_CHAIN_MISMATCH:${expectedChainId}`);
  }
  return deployment;
}

const RAW_DEPLOYMENTS: Record<number, unknown> = {
  [MONAD_TESTNET_CHAIN_ID]: deployment10143,
};
const parsed = new Map<number, Deployment>();

/**
 * 지연 로딩. `import '@monti/shared'` 만으로는 절대 던지지 않는다 —
 * 배포 파일이 비어 있거나 모양이 틀렸다면 **이 함수를 부를 때** 알게 된다.
 */
export function loadDeployment(chainId: number = DEFAULT_CHAIN_ID): Deployment {
  const cached = parsed.get(chainId);
  if (cached) return cached;
  const raw = RAW_DEPLOYMENTS[chainId];
  if (raw === undefined) throw new Error(`NO_DEPLOYMENT:${chainId}`);
  const deployment = parseDeployment(raw, chainId);
  parsed.set(chainId, deployment);
  return deployment;
}

/** 얇은 접근자들. sub-plan 04는 `attesterAddress()` 로 스냅샷 서명을 검증한다. */
export const identityAddress = (chainId?: number): Hex => loadDeployment(chainId).identity;
export const organizersAddress = (chainId?: number): Hex => loadDeployment(chainId).organizers;
export const ticketAddress = (chainId?: number): Hex => loadDeployment(chainId).ticket;
export const paymasterAddress = (chainId?: number): Hex => loadDeployment(chainId).paymaster;
export const attesterAddress = (chainId?: number): Hex => loadDeployment(chainId).attester;
export const coinbaseFactoryAddress = (chainId?: number): Hex => loadDeployment(chainId).coinbaseFactory;
export const entryPointAddress = (chainId?: number): Hex => loadDeployment(chainId).entryPoint;
