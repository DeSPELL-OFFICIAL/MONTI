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

export const P256_PRECOMPILE_ADDRESS = '0x0000000000000000000000000000000000000100' as Hex;
export const CREATE2_DEPLOYER_ADDRESS = '0x4e59b44847b379578588920cA78FbF26c0B4956C' as Hex;
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Hex;

/**
 * Coinbase Smart Wallet 팩토리(체인 공통 canonical 주소). 4337 릴레이 경로는 폐기됐지만
 * 계정은 여전히 counterfactual 이라, registerPasskey/recoverAccess 가 이 팩토리의 `getAddress`
 * view 로 패스키 소유자의 계정 주소만 예측한다. 배포 JSON 에서 빠진(설계 §3) 뒤로는 정적 설정값이다.
 */
export const COINBASE_SMART_WALLET_FACTORY_ADDRESS =
  '0xBA5ED110eFDBa3D005bfC882d75358ACBbB85842' as Hex;

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
 *   최신 재배포는 2026-09-30, chain 10143, Ticket `0x7E1fdfCB3688C5b0539101cEAE6a7Ee5bD9b51Cf`.
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

/**
 * 수동 승인(스펙 §7.5)의 사유 코드. `Ticket.requestOverride` 와 `Ticket.manualOverride` 가
 * `uint8 reason` 으로 **체인에 기록하는 바로 그 숫자**이므로 순서는 얼어 있다 — 번호를 다시
 * 매기면 이미 기록된 모든 승인의 사유가 통째로 바뀐다.
 *
 * 숫자만 여기 있고 문장은 없다. 문장은 로케일마다 다르고 화면의 것이라서 `staff/copy.ts` 에
 * 산다. 여기 있는 것은 계약이 읽는 값이고, 그래서 계약을 읽는 모든 앱이 같은 곳에서 가져간다.
 */
export const OVERRIDE_REASON = {
  /** 신분증·사진을 스태프가 직접 대조했다. */
  photoChecked: 1,
  /** 관객 휴대폰이 잠겼거나 NFC 가 되지 않는다. */
  phoneTrouble: 2,
  /** 표시가 시간이 지나 게이트가 받아 주지 않는다. */
  staleCode: 3,
  /** 그 밖의 현장 판단. */
  other: 4,
} as const;

export type OverrideReasonCode = (typeof OVERRIDE_REASON)[keyof typeof OVERRIDE_REASON];

/** 화면에 늘어놓는 차례. 코드 순서 그대로이고, 화면이 자기 목록을 따로 들지 않게 한다. */
export const OVERRIDE_REASONS = [
  OVERRIDE_REASON.photoChecked,
  OVERRIDE_REASON.phoneTrouble,
  OVERRIDE_REASON.staleCode,
  OVERRIDE_REASON.other,
] as const;

/**
 * `Ticket.ROLE_*`(`contracts/src/Ticket.sol:80-82`). `ManualOverride` 이벤트가 승인자와 함께
 * 남기는 역할 표식이다: `approver` 는 `PERM_APPROVE_OVERRIDE` 를 가진 소유자·관리자,
 * `manager` 는 `canApprove` 가 켜진 매니저. `none` 은 계약이 되돌리는 값이라 체인에 남지 않는다.
 */
export const OVERRIDE_ROLE = { none: 0, approver: 1, manager: 2 } as const;
export type OverrideRoleCode = (typeof OVERRIDE_ROLE)[keyof typeof OVERRIDE_ROLE];

/**
 * `Organizers.PERM_APPROVE_OVERRIDE`. 계약은 이 비트를 `private` 으로 두고 값으로만 쓰므로
 * (`Ticket.sol:86`) ABI 로는 읽을 수 없다. 수동 승인 권한을 묻는 모든 화면이 여기서 가져간다.
 */
export const PERM_APPROVE_OVERRIDE = 4;

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
  /** Phase 2 ERC-2771 전달자(설계 §1). 2026-09-30 재배포부터 배포 파일의 필수 키다. */
  forwarder: Hex;
  attester: Hex;
}

const ADDRESS_FIELDS = [
  'identity',
  'organizers',
  'ticket',
  'forwarder',
  'attester',
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
/** Phase 2 전달자 주소. 2026-09-30 재배포부터 필수 키라 loadDeployment 가 부재를 이미 막는다. */
export const forwarderAddress = (chainId?: number): Hex => loadDeployment(chainId).forwarder;
export const attesterAddress = (chainId?: number): Hex => loadDeployment(chainId).attester;

/**
 * Circle USDC 의 소수 자릿수. 정산 금고에 예치되는 토큰 금액(usdCents → 토큰 최소단위)을
 * 환산할 때 쓴다. 웹과 (나중의) 릴레이어가 같은 상수를 보도록 shared 에 둔다.
 */
export const USDC_DECIMALS = 6;

/**
 * 분배 비율 합(= 100%)의 basis-point 값. `BPS_DENOMINATOR`(bigint)의 number 판으로, 정산
 * 편집기가 수령인 비율 합이 10000 인지 UI 에서 검증할 때 쓴다.
 */
export const BPS_TOTAL = 10_000;

/**
 * MONTI 플랫폼 수수료 기본 비율(5%). `SettlementVault.MIN_PLATFORM_BPS` 와 같은 하한이며,
 * 정산 편집기의 고정 플랫폼 행이 이 값으로 시작한다. 올릴 수는 있어도 이 아래로는 못 내린다.
 */
export const DEFAULT_PLATFORM_BPS = 500;
