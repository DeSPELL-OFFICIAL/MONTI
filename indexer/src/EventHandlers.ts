/**
 * MONTI 체인 인덱서 핸들러.
 *
 * 구독 목록은 `config.yaml`(생성물) 이 정하고, 저장 모양은 `schema.graphql` 이 정한다.
 * 이 파일은 그 둘을 잇기만 한다 — 여기서 Firestore 를 쓰지 않는다. 조직자 초대 완료
 * (`AdminSet`/`ManagerSet`)와 `devices.pendingChange` 정리(`DeviceChanged`)는
 * Tenderly 웹훅(`functions/src/functions/chainWebhook.ts`, Task 28)의 몫이다.
 *
 * 주소로 된 id·필드는 **전부 소문자**다. Functions 쪽 질의도 소문자로 보내므로
 * (`functions/src/lib/envio.ts` 의 호출자들) 한쪽만 체크섬이면 조용히 0건이 된다.
 */
import type { Gate, handlerContext } from 'generated';
import type { Abi } from 'viem';

// envio 는 이 파일을 ts-node 의 **CJS** 로더로 require 한다(`generated/src/Generated.res.js`
// 의 registerContractHandlers). `generated/index.js` 는 `module.exports = {...handlers, …}`
// 라 스프레드로 만든 객체이고, Node 의 cjs-module-lexer 는 거기서 `Identity` 를 이름으로
// 찾아내지 못한다 — 값을 `import` 로 가져오면 vitest(네이티브 ESM 경로)에서
// "does not provide an export named 'Identity'" 로 죽는다. 타입만 `import type` 으로
// 가져오고 값은 require 로 받으면 두 경로 모두에서 돈다. generated 의 `*.gen.ts` 들도
// 똑같이 한다.
const { Identity, Organizers, Ticket } = require('generated') as typeof import('generated');
// 같은 이유로 viem 도 require 다. 값 `import` 하나만 있어도 Node 22 의 타입 스트리퍼가
// 이 파일을 ESM 으로 판정해 envio 의 require() 가 깨진다.
const { createPublicClient, http } = require('viem') as typeof import('viem');
const { createEffect, S } = require('envio') as typeof import('envio');

/**
 * 워크스페이스 밖에서 가져오는 것이 하나도 없어야 한다. Envio 호스티드 서비스는 루트
 * 디렉터리로 `indexer/` **하나만** 올려 거기서 `pnpm install` 을 돌리므로, 예전처럼
 * `@monti/shared`(= `workspace:*`)를 require 하면 배포가 해석 실패로 죽는다. 그래서
 * 핸들러가 쓰는 셋을 `scripts/gen-config.mjs` 가 `src/vendored/*.json` 으로 복제해
 * 커밋한다 — 손으로 고치지 않는다(`pnpm indexer:check` 가 어긋남을 막는다).
 *
 * JSON 으로 둔 이유는 로더가 셋이기 때문이다: envio 의 ts-node, vitest, tsc. `.ts` 는
 * 셋이 CJS/ESM 을 다르게 판정할 여지가 있지만 `.json` 은 어느 쪽에서도 같은 값이다.
 */
const { abi: ticketAbi } = require('./vendored/ticket-abi.json') as { abi: Abi };
const { deployment } = require('./vendored/deployment.json') as {
  deployment: { chainId: number; block: number; ticket: `0x${string}` };
};
const { byCode: EVENT_STATUS_BY_CODE } = require('./vendored/event-status.json') as {
  byCode: readonly (string | undefined)[];
};

/** `register()` 가 기기 키를 이벤트에 싣지 않는 동안의 자리표시자. */
const ZERO32 = `0x${'00'.repeat(32)}`;

const addr = (value: string): string => value.toLowerCase();

// ───────────────────────────── Identity ─────────────────────────────

/**
 * `register()` 는 한 트랜잭션에서 `Registered` → `DeviceChanged` → `KycLevelSet` 를
 * 차례로 낸다(contracts/src/Identity.sol). `Registered` 자체는 기기 키도 kycLevel 도
 * 싣지 않으므로 여기서는 0 으로 시작하고, 같은 트랜잭션의 뒤 두 이벤트가 덮는다.
 * 즉 첫 블록부터 값이 맞는다 — 트랜잭션 입력을 디코드할 필요가 없다.
 */
Identity.Registered.handler(async ({ event, context }) => {
  context.IdentityAccount.set({
    id: addr(event.params.account),
    personId: event.params.personId,
    nickname: undefined,
    kycLevel: 0,
    deviceX: ZERO32,
    deviceY: ZERO32,
    locked: false,
    deviceUpdatedAt: 0n,
  });
});

Identity.KycLevelSet.handler(async ({ event, context }) => {
  const current = await context.IdentityAccount.get(addr(event.params.account));
  if (!current) return;
  context.IdentityAccount.set({ ...current, kycLevel: Number(event.params.level) });
});

/**
 * `rotateAccount(personId, newAccount)` — 그리고 01b 의 `cancelRotation()`, 이쪽은
 * `AccountRotated(personId, current, msg.sender)` 를 **먼저** 내고 그 뒤에
 * `RotationCancelled` 를 낸다(MONTI-01b `contracts/src/Identity.sol:160-162`).
 * 그래서 이 한 핸들러가 회전과 회전 취소를 모두 처리한다. `RotationCancelled` 는
 * 2026-09-23 재배포로 ABI·config 에 들어와 실제로 구독하지만, 인덱서에게는 순수한
 * 감사 로그다 — 계정 상태는 앞선 `AccountRotated` 가 이미 되돌렸고 `IdentityAccount`
 * 에 회전 대기 플래그 같은 쓸 열이 없어, 따로 핸들러를 달 것이 없다.
 *
 * 옮기는 것과 옮기지 않는 것을 갈라 두는 게 이 핸들러의 전부다:
 * - 사람(`personId`)과 kycLevel(`_kycLevel[personId]`)은 사람에 붙으므로 따라간다.
 * - 닉네임은 두 함수 모두 `_nicknameOf` 를 활성 계정으로 옮기므로 따라간다.
 * - **기기(x/y/locked/updatedAt)는 계정별이라 따라가지 않는다.** `rotateAccount` 는
 *   새 계정의 `_devices` 를 건드리지 않아 체인 위에서 0 이고(첫 `setActiveDevice`
 *   까지), `cancelRotation` 은 되돌린 계정의 잠금을 **일부러** 풀지 않는다
 *   (같은 파일 :132-134). 여기서 `locked: false` 로 덮으면 문 앞에서 DENY 가 날
 *   계정을 앱에 "통과"로 보여 주게 된다.
 *
 * 밀려난 행은 지우지 않는다. `Ticket.migrate` 가 옛 티켓에서 사람을 되찾을 때까지
 * 그 계정은 살아 있고, `personOf` 도 체인에 남는다.
 *
 * **옛 행이 없어도 새 행을 만든다.** 다른 핸들러들과 달리 여기서는 `previous` 가
 * 없다고 지나가지 않는다 — `Registered` 가 구독 시작 블록보다 앞선 계정이라도
 * 회전한 뒤의 **현재 계정**은 인덱스에 있어야 하고, 이 이벤트가 `personId` 를
 * 싣고 있어 지어낸 값 없이 행을 세울 수 있다. 그때 kycLevel 은 0 에서 시작하고
 * 다음 `KycLevelSet` 이 맞춘다(닉네임은 비어 있다).
 */
Identity.AccountRotated.handler(async ({ event, context }) => {
  const from = addr(event.params.oldAccount);
  const to = addr(event.params.newAccount);
  const previous = await context.IdentityAccount.get(from);
  // 회전 취소는 이미 행이 있는 계정으로 되돌아온다.
  const target = await context.IdentityAccount.get(to);

  if (previous) context.IdentityAccount.set({ ...previous, nickname: undefined });

  context.IdentityAccount.set({
    id: to,
    personId: event.params.personId,
    nickname: previous?.nickname ?? target?.nickname,
    kycLevel: previous?.kycLevel ?? target?.kycLevel ?? 0,
    deviceX: target?.deviceX ?? ZERO32,
    deviceY: target?.deviceY ?? ZERO32,
    locked: target?.locked ?? false,
    deviceUpdatedAt: target?.deviceUpdatedAt ?? 0n,
  });
});

/**
 * `register()` 와 `setActiveDevice()` 가 낸다. 잠금은 건드리지 않는다 —
 * `setActiveDevice` 는 잠겨 있던 경우에만 `DeviceLocked(account, false)` 를 따로
 * 내고, 아래 핸들러가 그걸 받는다.
 */
Identity.DeviceChanged.handler(async ({ event, context }) => {
  const current = await context.IdentityAccount.get(addr(event.params.account));
  if (!current) return;
  context.IdentityAccount.set({
    ...current,
    deviceX: event.params.x,
    deviceY: event.params.y,
    deviceUpdatedAt: BigInt(event.block.timestamp),
  });
});

/**
 * `setActiveDevice` 의 해제, 그리고 01b 의 `rotateAccount` 가 밀려난 계정에 대해
 * 함께 내는 `DeviceLocked(oldAccount, true)` — 같은 시그니처라 같은 핸들러가 받는다.
 * **2026-09-23 재배포로 실제로 도는 경로다**(01b 델타 §6): 같은 트랜잭션에서
 * `AccountRotated` 바로 뒤에 오고, 대상은 회전이 만든 새 계정이 아니라 **밀려난 옛
 * 계정**이라 두 핸들러의 쓰기가 겹치지 않는다. 이미 잠겨 있던 계정에는 컨트랙트가
 * 이벤트를 내지 않고(Identity.sol:110-116), 내더라도 이 핸들러는 `locked` 를 같은
 * 값으로 덮을 뿐이라 재생·중복에 안전하다.
 */
Identity.DeviceLocked.handler(async ({ event, context }) => {
  const current = await context.IdentityAccount.get(addr(event.params.account));
  if (!current) return;
  context.IdentityAccount.set({ ...current, locked: event.params.locked });
});

Identity.NicknameSet.handler(async ({ event, context }) => {
  const current = await context.IdentityAccount.get(addr(event.params.account));
  if (!current) return;
  context.IdentityAccount.set({ ...current, nickname: event.params.nickname });
});

// ──────────────────────────── Organizers ────────────────────────────

Organizers.OrganizerCreated.handler(async ({ event, context }) => {
  context.Organizer.set({ id: event.params.orgId.toString(), owner: addr(event.params.owner) });
});

Organizers.OwnerTransferred.handler(async ({ event, context }) => {
  context.Organizer.set({ id: event.params.orgId.toString(), owner: addr(event.params.to) });
});

/** bits 는 uint32 — Int 보다 넓어서 BigInt 열이다. 권한 해제도 bits 0 인 같은 이벤트다. */
Organizers.AdminSet.handler(async ({ event, context }) => {
  const account = addr(event.params.admin);
  context.Admin.set({
    id: `${event.params.orgId}-${account}`,
    orgId: event.params.orgId,
    account,
    bits: event.params.bits,
  });
});

/** `exists: false` 가 제거다 — 행을 지우면 "한 번 매니저였다"는 사실까지 사라진다. */
Organizers.ManagerSet.handler(async ({ event, context }) => {
  const account = addr(event.params.manager);
  context.Manager.set({
    id: `${event.params.orgId}-${account}`,
    orgId: event.params.orgId,
    account,
    exists: event.params.exists,
    canApprove: event.params.canApprove,
  });
});

Organizers.GateRegistered.handler(async ({ event, context }) => {
  context.Gate.set({
    id: event.params.gateId.toString(),
    eventId: event.params.eventId,
    account: addr(event.params.gateAccount),
    kx: event.params.kx,
    ky: event.params.ky,
    isOpen: false,
    revoked: false,
  });
});

/**
 * 플래그 이벤트는 gateId 하나만 싣는다. 등록을 못 본 게이트(= 구독 시작 블록보다
 * 앞선 것)라면 행을 지어내지 않고 넘긴다 — kx/ky 를 모르는 게이트 행은 스태프 앱에
 * 쓸모가 없고, 체크인 검증에 쓰이면 위험하다.
 */
type GatePatch = Partial<Pick<Gate, 'isOpen' | 'revoked'>>;

async function patchGate(context: handlerContext, gateId: bigint, patch: GatePatch): Promise<void> {
  const current = await context.Gate.get(gateId.toString());
  if (!current) return;
  context.Gate.set({ ...current, ...patch });
}

Organizers.GateOpened.handler(async ({ event, context }) => {
  await patchGate(context, event.params.gateId, { isOpen: true });
});

Organizers.GateClosed.handler(async ({ event, context }) => {
  await patchGate(context, event.params.gateId, { isOpen: false });
});

/** 취소된 게이트는 다시 열릴 수 없다. `isOpen` 도 같이 내려 둬야 질의 한쪽만 봐도 안전하다. */
Organizers.GateRevoked.handler(async ({ event, context }) => {
  await patchGate(context, event.params.gateId, { revoked: true, isOpen: false });
});

// ────────────────────────────── Ticket ──────────────────────────────

/**
 * `EventCreated(eventId, orgId, creator)` 는 셋만 싣는다. 나머지 메타와 티어 배열은
 * 컨트랙트 뷰에서 한 번 읽는다 — 공연 생성은 드물어 동기화 속도에 영향이 없고,
 * `EventMeta` 를 이벤트에 통째로 실으면 생성 가스가 그만큼 비싸진다.
 *
 * 클라이언트는 **처음 쓸 때** 만든다. 모듈 로드 시점에 `RPC_URL` 을 굳혀 버리면
 * 테스트가 로컬 스텁을 물릴 자리가 없다(`test/ticket.test.ts`).
 */
const DEFAULT_RPC_URL = 'https://testnet-rpc.monad.xyz';
// 복제해 둔 배포 파일은 10143 하나다. 다른 체인을 요구하면 예전 `loadDeployment` 와
// 똑같이 여기서 크게 실패한다 — 엉뚱한 주소를 읽는 조용한 폴백은 없다.
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 10143);
if (CHAIN_ID !== deployment.chainId) throw new Error(`NO_DEPLOYMENT:${CHAIN_ID}`);

let rpcClient: ReturnType<typeof createPublicClient> | undefined;
function rpc(): ReturnType<typeof createPublicClient> {
  rpcClient ??= createPublicClient({ transport: http(process.env.RPC_URL ?? DEFAULT_RPC_URL) });
  return rpcClient;
}

/** `Ticket.eventMeta(eventId)` 의 튜플. uint64 는 bigint, uint8/16/32 는 number 로 디코드된다. */
interface ChainEventMeta {
  orgId: bigint;
  titleHash: string;
  descHash: string;
  imageCid: string;
  startsAt: bigint;
  endsAt: bigint;
  venueHash: string;
  saleStart: bigint;
  saleEnd: bigint;
  transferable: boolean;
  transferCutoffSeconds: number;
  maxTransfers: number;
  approvalRequired: boolean;
  category: number;
  regionCode: string;
  requireKyc: boolean;
}

/** `Ticket.tiers(eventId)` 의 원소. */
interface ChainTier {
  name: string;
  priceUsdCents: bigint;
  supply: number;
  minted: number;
  maxPerWallet: number;
  seated: boolean;
}

/** `createEvent` 가 강제하는 티어 상한(1..8). `updateEventMeta` 도 같다. */
const MAX_TIERS = 8;

const chainMetaSchema = S.schema({
  orgId: S.bigint,
  titleHash: S.string,
  descHash: S.string,
  imageCid: S.string,
  startsAt: S.bigint,
  endsAt: S.bigint,
  venueHash: S.string,
  saleStart: S.bigint,
  saleEnd: S.bigint,
  transferable: S.boolean,
  transferCutoffSeconds: S.number,
  maxTransfers: S.number,
  approvalRequired: S.boolean,
  category: S.number,
  regionCode: S.string,
  requireKyc: S.boolean,
});

const chainTierSchema = S.schema({
  name: S.string,
  priceUsdCents: S.bigint,
  supply: S.number,
  // 체인의 `minted` 도 읽히지만 **쓰지 않는다** — 아래 `writeTiers` 의 주석을 보라.
  minted: S.number,
  maxPerWallet: S.number,
  seated: S.boolean,
});

/**
 * 공연 한 건의 체인 상태를 **그 이벤트가 난 블록에 고정해서** 읽는다.
 *
 * 블록을 고정하지 않으면(= latest) 과거를 재생할 때마다 값이 달라진다 — 재싱크는
 * Task 38 이 반드시 한 번 밟는 경로다. 고정한 뒤에는 `(eventId, blockNumber)` 가 곧
 * 답이므로 캐시가 성립한다: 재싱크 두 번째부터는 RPC 에 나가지 않는다.
 *
 * envio 2.32 의 `createEffect` 로 감쌌다(`experimental_createEffect` 는 같은 함수의
 * 옛 이름이고 이 버전에서 deprecated 다). 효과는 입력별로 중복 제거·캐시되고,
 * 출력 스키마가 디코드 결과를 검증한다 — 01b 델타 §5 가 경고하는 튜플 드리프트가
 * 조용한 오독 대신 **에러**로 드러난다.
 *
 * **아카이브 RPC 가 필요하다.** 과거 블록의 상태를 묻기 때문이다(Task 38 인계).
 */
const readEventState = createEffect(
  {
    name: 'ticketEventState',
    input: { eventId: S.bigint, blockNumber: S.bigint },
    output: S.schema({ meta: chainMetaSchema, tiers: S.array(chainTierSchema) }),
    // 공연 생성·수정은 드물고 한 건당 두 번 읽는다. 초당 상한을 둘 이유가 없다.
    rateLimit: false,
    cache: true,
  },
  async ({ input }) => {
    // ABI 는 리터럴 타입이 없는 JSON 이라 결과는 여기서 캐스팅한다(`src/vendored/ticket-abi.json`).
    const [meta, tiers] = await Promise.all([
      rpc().readContract({
        address: deployment.ticket,
        abi: ticketAbi,
        functionName: 'eventMeta',
        args: [input.eventId],
        blockNumber: input.blockNumber,
      }) as Promise<ChainEventMeta>,
      rpc().readContract({
        address: deployment.ticket,
        abi: ticketAbi,
        functionName: 'tiers',
        args: [input.eventId],
        blockNumber: input.blockNumber,
      }) as Promise<ChainTier[]>,
    ]);
    return { meta, tiers };
  },
);

/** 체인 메타 → `Event` 의 열. id·orgId·creator·status 는 부르는 쪽이 정한다. */
function metaColumns(meta: ChainEventMeta) {
  return {
    titleHash: meta.titleHash,
    descHash: meta.descHash,
    imageCid: meta.imageCid,
    startsAt: meta.startsAt,
    endsAt: meta.endsAt,
    venueHash: meta.venueHash,
    saleStart: meta.saleStart,
    saleEnd: meta.saleEnd,
    transferable: meta.transferable,
    transferCutoffSeconds: BigInt(meta.transferCutoffSeconds),
    maxTransfers: meta.maxTransfers,
    approvalRequired: meta.approvalRequired,
    category: meta.category,
    regionCode: meta.regionCode,
    requireKyc: meta.requireKyc,
  };
}

/**
 * 티어 배열을 통째로 다시 쓴다. `updateEventMeta` 는 `delete _tiers[eventId]` 뒤에
 * 새 배열을 넣으므로(Ticket.sol:215), 줄어든 경우 옛 행을 지워야 앱에 유령 티어가
 * 남지 않는다. 상한이 8 이라 훑는 비용은 고정이다.
 *
 * **`minted` 는 체인 값을 쓰지 않고 0 에서 시작한다.** 이 열은 오직 `Claimed` 가 센다.
 * 체인 값을 씨앗으로 놓으면 그 뒤 재생되는 `Claimed` 가 같은 claim 을 한 번 더 세어
 * 잔여 수량(`supply - minted`)이 두 배로 틀린다. 0 이 맞는 씨앗인 근거는 둘이다:
 * 구독이 배포 블록부터라 놓치는 claim 이 없고, `updateEventMeta` 도 체인에서
 * `t.minted = 0` 으로 되돌린다(Ticket.sol:216-218) — Draft 에서만 되므로 티켓이 없다.
 */
async function writeTiers(
  context: handlerContext,
  eventId: bigint,
  tiers: readonly ChainTier[],
): Promise<void> {
  tiers.forEach((tier, idx) => {
    context.Tier.set({
      id: `${eventId}-${idx}`,
      eventId,
      idx,
      name: tier.name,
      priceUsdCents: tier.priceUsdCents,
      supply: BigInt(tier.supply),
      minted: 0n,
      maxPerWallet: BigInt(tier.maxPerWallet),
      seated: tier.seated,
    });
  });
  for (let idx = tiers.length; idx < MAX_TIERS; idx += 1) {
    const stale = await context.Tier.get(`${eventId}-${idx}`);
    if (!stale) break;
    context.Tier.deleteUnsafe(stale.id);
  }
}

/**
 * `createEvent` 는 한 트랜잭션에서 `EventCreated` → `EventStatusChanged(0)` 를 낸다.
 * 여기서 Draft 로 시작해도 같은 값이라 충돌하지 않는다.
 */
Ticket.EventCreated.handler(async ({ event, context }) => {
  const eventId = event.params.eventId;
  const { meta, tiers } = await context.effect(readEventState, {
    eventId,
    blockNumber: BigInt(event.block.number),
  });
  context.Event.set({
    id: eventId.toString(),
    orgId: event.params.orgId,
    creator: addr(event.params.creator),
    ...metaColumns(meta),
    status: 'Draft',
    pendingRequests: 0,
  });
  await writeTiers(context, eventId, tiers);
});

/**
 * `updateEventMeta` 는 Draft 인 공연에서만 되고 `orgId` 는 지킨다(Ticket.sol:210).
 * 그래서 여기서도 orgId·creator·status 는 그대로 두고 메타와 티어만 갈아 끼운다.
 */
Ticket.EventMetaUpdated.handler(async ({ event, context }) => {
  const eventId = event.params.eventId;
  const current = await context.Event.get(eventId.toString());
  if (!current) return;
  const { meta, tiers } = await context.effect(readEventState, {
    eventId,
    blockNumber: BigInt(event.block.number),
  });
  context.Event.set({ ...current, ...metaColumns(meta) });
  await writeTiers(context, eventId, tiers);
});

/**
 * 0/1/2/3 → Draft/Published/Cancelled/Ended. 모르는 코드는 **던지지 않는다** —
 * 인덱서가 멈추면 공연 하나가 아니라 체인 전체가 멈춘다. 로그만 남기고 지나간다.
 */
Ticket.EventStatusChanged.handler(async ({ event, context }) => {
  const current = await context.Event.get(event.params.eventId.toString());
  if (!current) return;
  const code = Number(event.params.status);
  const status = EVENT_STATUS_BY_CODE[code];
  if (status === undefined) {
    context.log.warn('EventStatusChanged: unknown status code', {
      eventId: event.params.eventId.toString(),
      code,
    });
    return;
  }
  context.Event.set({ ...current, status });
});

/**
 * `claim` 은 `_safeMint` → `emit Claimed` 순이라 민팅 `Transfer(0→to)` 가 **먼저** 온다.
 * 티켓 행을 만드는 것은 여기다(그쪽은 행이 없어 그냥 지나간다).
 *
 * `identity` 는 소문자 주소로 `IdentityAccount` 를 가리킨다 — `listAttendees`·`snapshot`
 * 이 이 연결로 닉네임과 kycLevel 을 읽는다.
 */
Ticket.Claimed.handler(async ({ event, context }) => {
  const tier = Number(event.params.tier);
  const owner = addr(event.params.to);
  context.Ticket.set({
    id: event.params.tokenId.toString(),
    eventId: event.params.eventId,
    tier,
    owner,
    transfers: 0,
    revoked: false,
    checkIn_id: undefined,
    identity_id: owner,
  });
  // 체인의 `t.minted` 도 claim 마다 +1 이다(Ticket.sol:246). 생성 때 읽은 값에서 이어 센다.
  const row = await context.Tier.get(`${event.params.eventId}-${tier}`);
  if (row) context.Tier.set({ ...row, minted: row.minted + 1n });
});

/**
 * 민팅(from == 0)은 세지 않는다 — 체인의 `_transfers` 도 `from != 0 && to != 0` 일 때만
 * 오른다(Ticket.sol:537). 소각(to == 0)은 이 컨트랙트에 경로가 없다.
 *
 * 새 주인의 `IdentityAccount` 로 다시 잇는다. 연결이 옛 주인에 남아 있으면 주최자
 * 목록이 앞사람의 닉네임을 계속 보여 준다(Task 27 리뷰).
 */
Ticket.Transfer.handler(async ({ event, context }) => {
  const current = await context.Ticket.get(event.params.tokenId.toString());
  if (!current) return;
  const isMint = addr(event.params.from) === `0x${'00'.repeat(20)}`;
  const owner = addr(event.params.to);
  context.Ticket.set({
    ...current,
    owner,
    identity_id: owner,
    transfers: isMint ? current.transfers : current.transfers + 1,
  });
});

/**
 * 같은 트랜잭션이 이미 써 둔 체크인 행의 `manual`·`late` 는 지킨다.
 *
 * 두 경로가 `CheckedIn` **앞에** 자기 행을 남긴다:
 * - `manualOverride` → `ManualOverride` 뒤에 `CheckedIn`(Ticket.sol:426-427)
 * - 01b `checkInLate` → `CheckedInLate` 뒤에 `CheckedIn`(01b Ticket.sol:468-469)
 * 그래서 여기서 무조건 false 로 덮으면 수동 입장과 지각 입장이 둘 다 지워진다.
 * 다른 트랜잭션의 옛 행이면 새 입장이므로 false 로 시작한다.
 */
Ticket.CheckedIn.handler(async ({ event, context }) => {
  const id = event.params.tokenId.toString();
  const prior = await context.CheckIn.get(id);
  const sameTx = prior?.txHash === event.transaction.hash;
  context.CheckIn.set({
    id,
    gateId: event.params.gateId,
    ts: event.params.ts,
    nonceHash: event.params.nonceHash,
    manual: sameTx ? prior.manual : false,
    late: sameTx ? prior.late : false,
    txHash: event.transaction.hash,
    block: BigInt(event.block.number),
  });
  const ticket = await context.Ticket.get(id);
  if (ticket) context.Ticket.set({ ...ticket, checkIn_id: id });
});

/**
 * 01b 의 `CheckedInLate(tokenId, gateId, issuedAt, ts)` — 오프라인 큐가 복구 뒤에 밀어 넣은
 * 입장이다(`contracts/docs/abi-delta-01b.md` §2). **2026-09-23 재배포로 살아 있는
 * 경로다**: ABI 에 들어왔고 `config.yaml` 도 실제로 구독한다.
 *
 * `CheckedIn` 보다 **먼저** 오므로(01b Ticket.sol:468-469) 여기서 행을 세우고,
 * 바로 뒤의 `CheckedIn` 이 진짜 nonceHash·ts 로 덮으면서 `late` 를 지킨다.
 * 입장 수는 `CheckedIn` 하나로 센다 — 여기서 두 번째 입장으로 세지 않는다.
 */
Ticket.CheckedInLate.handler(async ({ event, context }) => {
  const id = event.params.tokenId.toString();
  const prior = await context.CheckIn.get(id);
  context.CheckIn.set({
    id,
    gateId: event.params.gateId,
    ts: event.params.ts,
    nonceHash: ZERO32,
    manual: prior?.txHash === event.transaction.hash ? prior.manual : false,
    late: true,
    txHash: event.transaction.hash,
    block: BigInt(event.block.number),
  });
  const ticket = await context.Ticket.get(id);
  if (ticket) context.Ticket.set({ ...ticket, checkIn_id: id });
});

/**
 * 수동 입장. `ManualOverride` 는 eventId 를 싣지 않으므로 공연은 짝이 되는 `CheckedIn`
 * (또는 `Ticket`)을 타고 찾는다. 행 둘을 쓴다 — 감사용 `Override` 와, 뒤따라오는
 * `CheckedIn` 이 이어받을 체크인 행이다.
 */
Ticket.ManualOverride.handler(async ({ event, context }) => {
  const id = event.params.tokenId.toString();
  context.Override.set({
    id: `${event.transaction.hash}-${event.logIndex}`,
    tokenId: event.params.tokenId,
    gateId: event.params.gateId,
    approver: addr(event.params.approver),
    role: Number(event.params.role),
    reason: Number(event.params.reason),
    requested: false,
  });
  context.CheckIn.set({
    id,
    gateId: event.params.gateId,
    ts: BigInt(event.block.timestamp),
    nonceHash: ZERO32,
    manual: true,
    late: false,
    txHash: event.transaction.hash,
    block: BigInt(event.block.number),
  });
  const ticket = await context.Ticket.get(id);
  if (ticket) context.Ticket.set({ ...ticket, checkIn_id: id });
});

/** 요청은 입장이 아니다 — 체크인 행을 만들지 않는다. role 은 `ROLE_NONE`(0). */
Ticket.OverrideRequested.handler(async ({ event, context }) => {
  context.Override.set({
    id: `${event.transaction.hash}-${event.logIndex}`,
    tokenId: event.params.tokenId,
    gateId: event.params.gateId,
    approver: addr(event.params.requester),
    role: 0,
    reason: Number(event.params.reason),
    requested: true,
  });
});

Ticket.Revoked.handler(async ({ event, context }) => {
  const current = await context.Ticket.get(event.params.tokenId.toString());
  if (!current) return;
  context.Ticket.set({ ...current, revoked: true });
});

/**
 * 회전한 계정이 제 티켓을 되찾는다. `migrate` 는 `_internalMove` 라 체인의 `_transfers`
 * 를 올리지 않는데(Ticket.sol:544), 인덱서에는 같은 트랜잭션의 `Transfer` 가 **먼저**
 * 와서 이미 +1 해 놓았다. 그 한 번을 여기서 되돌린다 — 남겨 두면 양도 한도가
 * 체인보다 빨리 닫힌 것처럼 보인다.
 *
 * 그 `Transfer` 를 정말 봤는지 확인하고 뺀다: 봤다면 행의 주인이 이미 새 계정이다.
 * 아니라면 무엇인가 가정과 어긋난 것이므로 **빼지 않고 경고를 남긴다** — 조용히
 * 깎으면 양도 수가 체인보다 하나 적어지고, 아무도 그 사실을 모른다.
 */
Ticket.Migrated.handler(async ({ event, context }) => {
  const id = event.params.tokenId.toString();
  const current = await context.Ticket.get(id);
  if (!current) return;
  const owner = addr(event.params.to);
  const sawTransfer = current.owner === owner;

  let transfers = current.transfers;
  if (!sawTransfer) {
    context.log.warn('Migrated without the paired Transfer — transfer count left as is', {
      tokenId: id,
      owner: current.owner,
      to: owner,
    });
  } else if (transfers === 0) {
    context.log.warn('Migrated with a zero transfer count — nothing to give back', { tokenId: id });
  } else {
    transfers -= 1;
  }

  context.Ticket.set({ ...current, owner, identity_id: owner, transfers });
});

/** 티켓 하나에 오퍼는 하나다(`_offers[tokenId]`) — 그래서 id 가 tokenId 다. */
Ticket.OfferCreated.handler(async ({ event, context }) => {
  context.Offer.set({
    id: event.params.tokenId.toString(),
    from: addr(event.params.from),
    commitment: event.params.recipientCommitment,
    expiresAt: event.params.expiresAt,
    status: 'open',
  });
});

/** 체크인·양도·직접 취소가 모두 낸다(Ticket.sol:309, 365, 423, 539). */
Ticket.OfferCancelled.handler(async ({ event, context }) => {
  const current = await context.Offer.get(event.params.tokenId.toString());
  if (!current) return;
  context.Offer.set({ ...current, status: 'cancelled' });
});

/**
 * `acceptOffer` 는 `delete _offers` 를 `_update` **앞에** 해서(Ticket.sol:321) 취소
 * 이벤트를 내지 않는다. 그래서 여기 한 번만 닫힌다. 01b 의 EIP-712 전환은
 * 서명 다이제스트만 바꾸므로 이 핸들러는 그대로다.
 */
Ticket.OfferAccepted.handler(async ({ event, context }) => {
  const current = await context.Offer.get(event.params.tokenId.toString());
  if (!current) return;
  context.Offer.set({ ...current, status: 'accepted' });
});

// ─────────────────────── Ticket: 승인제 클레임(01c) ───────────────────────

/**
 * `Event.pendingRequests` 를 하나 내린다. **0 밑으로는 내려가지 않는다.**
 * 카운터는 오직 Pending 을 떠날 때만 낮춘다(아래 두 핸들러의 status 검사) — 이미
 * 결정된 요청에 종결 이벤트가 다시 재생돼도 여기까지 오지 않으므로 재생·중복에 안전하다.
 */
async function decrementPending(context: handlerContext, eventId: bigint): Promise<void> {
  const evt = await context.Event.get(eventId.toString());
  if (!evt) return;
  context.Event.set({ ...evt, pendingRequests: Math.max(0, evt.pendingRequests - 1) });
}

/**
 * `requestClaim` → `ClaimRequested(eventId, requestId, requester, tier)`. Pending 행을
 * 열고 그 공연의 `pendingRequests` 를 +1 한다. id 는 `eventId-requestId` — requestId 는
 * `requestClaim` 이 돌려주는 공연별 순번이다. 공연을 못 본 경우(구독 시작 전)에도 요청
 * 행은 남기되 카운터는 올리지 않는다.
 */
Ticket.ClaimRequested.handler(async ({ event, context }) => {
  const eventId = event.params.eventId;
  context.ClaimRequest.set({
    id: `${eventId}-${event.params.requestId}`,
    eventId,
    requestId: event.params.requestId,
    requester: addr(event.params.requester),
    tier: Number(event.params.tier),
    status: 'Pending',
    tokenId: undefined,
    requestedAt: BigInt(event.block.timestamp),
    decidedAt: undefined,
    txHash: event.transaction.hash,
  });
  const evt = await context.Event.get(eventId.toString());
  if (evt) context.Event.set({ ...evt, pendingRequests: evt.pendingRequests + 1 });
});

/**
 * `approveClaims` → `ClaimApproved(eventId, requestId, tokenId)`. 요청을 Approved 로
 * 닫고 민팅된 tokenId 를 싣는다 — 짝이 되는 `Claimed` 가 **먼저** 와서 `Ticket` 행은
 * 이미 만들어져 있다(Ticket.sol). 카운터는 이 요청이 Pending 이었을 때만 내린다.
 */
Ticket.ClaimApproved.handler(async ({ event, context }) => {
  const id = `${event.params.eventId}-${event.params.requestId}`;
  const current = await context.ClaimRequest.get(id);
  if (!current) return;
  context.ClaimRequest.set({
    ...current,
    status: 'Approved',
    tokenId: event.params.tokenId,
    decidedAt: BigInt(event.block.timestamp),
  });
  if (current.status === 'Pending') await decrementPending(context, event.params.eventId);
});

/**
 * `rejectClaims` **와** `cancelRequest` 가 모두 `ClaimRejected(eventId, requestId)` 를 낸다.
 * 취소 전용 이벤트가 없고(actor 가 로그에 없으며 페이마스터가 msg.sender 를 가린다),
 * 컨트랙트의 `claimRequest` 뷰도 reject 와 cancel 을 상태 2 로 합치므로(Ticket.sol),
 * 요청자 본인 취소도 주최자 거절과 구분되지 않고 **Rejected** 로 떨어진다. 카운터는
 * 이 요청이 Pending 이었을 때만 내려 재생·중복에 안전하다.
 */
Ticket.ClaimRejected.handler(async ({ event, context }) => {
  const id = `${event.params.eventId}-${event.params.requestId}`;
  const current = await context.ClaimRequest.get(id);
  if (!current) return;
  context.ClaimRequest.set({
    ...current,
    status: 'Rejected',
    decidedAt: BigInt(event.block.timestamp),
  });
  if (current.status === 'Pending') await decrementPending(context, event.params.eventId);
});

// ──────────────────────────── SettlementVault ────────────────────────────

/**
 * 프로그래머블 정산 레이어(설계 2026-10-01). 공개 정산 페이지가 읽을 정책·에스크로·지급을
 * 인덱싱한다. 금고는 코어 넷과 **분리된** 스탠드얼론이라, 아직 배포되지 않았거나(설정에 없음)
 * 배포되었어도 코어 인덱싱과 독립적으로 붙는다.
 *
 * **등록은 조건부다.** `generated.SettlementVault` 는 config.yaml 에 금고 컨트랙트가 들어온
 * 뒤(= 배포 + 재생성)에만 존재한다. 그 전에는 `undefined` 라 여기서 아무 핸들러도 달지
 * 않는다 — codegen·tsc 가 그대로 green 이고(엔티티는 schema 에 늘 있으므로 타입은 난다),
 * 금고가 배포되면 재생성만으로 인덱싱이 켜진다. ABI(`getPolicy` 호출용)는 아직 공유로
 * 내보내지 않아 `src/vendored/settlement-vault-abi.json` 에 벤더해 두고 거기서 읽는다.
 */
const settlementContract = (require('generated') as Record<string, unknown>).SettlementVault as
  | Record<string, { handler: (fn: (args: { event: SettlementEvent; context: handlerContext }) => Promise<void>) => void }>
  | undefined;
const { abi: settlementAbi } = require('./vendored/settlement-vault-abi.json') as { abi: Abi };
const settlementVaultAddress = (deployment as { settlementVault?: `0x${string}` }).settlementVault;

/** 핸들러가 읽는 금고 이벤트의 느슨한 모양. params 는 이벤트마다 달라 Record 로 둔다. */
interface SettlementEvent {
  params: Record<string, string | bigint | boolean | number>;
  block: { number: number; timestamp: number };
  transaction: { hash: string };
  logIndex: number;
}

/** `getPolicy(eventId)` 가 돌려주는 SplitPolicy 튜플. uint16/32 는 number, 나머지는 보이는 대로. */
interface ChainRecipient {
  account: string;
  bps: number;
  reasonHash: string;
  tag: string;
}
interface ChainPolicy {
  recipients: ChainRecipient[];
  platformBps: number;
  reserveBps: number;
  noShowRefund: boolean;
  frozen: boolean;
  version: number;
}

const chainRecipientSchema = S.schema({
  account: S.string,
  bps: S.number,
  reasonHash: S.string,
  tag: S.string,
});
const chainPolicySchema = S.schema({
  recipients: S.array(chainRecipientSchema),
  platformBps: S.number,
  reserveBps: S.number,
  noShowRefund: S.boolean,
  frozen: S.boolean,
  version: S.number,
});

/**
 * 정책의 수취인별 분배는 **이벤트에 실리지 않는다**(`PolicySet` 은 policyHash·version 만).
 * bps·tag 까지 보여 주려면 체인에서 읽어야 하므로, `Ticket.eventMeta` 와 똑같은 방식으로
 * setPolicy 가 난 **블록에 고정해** `getPolicy(eventId)` 를 한 번 읽는다(재싱크에도 값이 고정).
 */
const readPolicy = createEffect(
  {
    name: 'settlementPolicy',
    input: { eventId: S.bigint, blockNumber: S.bigint },
    output: chainPolicySchema,
    rateLimit: false,
    cache: true,
  },
  async ({ input }: { input: { eventId: bigint; blockNumber: bigint } }) => {
    if (!settlementVaultAddress) throw new Error('NO_SETTLEMENT_VAULT');
    return (await rpc().readContract({
      address: settlementVaultAddress,
      abi: settlementAbi,
      functionName: 'getPolicy',
      args: [input.eventId],
      blockNumber: input.blockNumber,
    })) as ChainPolicy;
  },
);

/**
 * 이벤트별 집계(`EventSettlement`)를 get-or-create 로 갱신한다. 금고 핸들러는 어느 것이든
 * 먼저 올 수 있어(입금 전에 정책, 또는 구독 시작 블록을 걸친 경우) 늘 없으면 0 에서 만든다.
 * totalReleased 는 Released·NoShowSettled 를 함께 세고(둘 다 수취인 분배), totalRefunded 는
 * Refunded 를, payoutCount 는 Paid 줄 수를 센다.
 */
async function bumpSettlement(
  context: handlerContext,
  eventId: bigint,
  delta: { deposited?: bigint; released?: bigint; refunded?: bigint; payouts?: number },
): Promise<void> {
  const id = eventId.toString();
  const cur = await context.EventSettlement.get(id);
  const base = cur ?? {
    id,
    totalDeposited: 0n,
    totalReleased: 0n,
    totalRefunded: 0n,
    payoutCount: 0,
  };
  context.EventSettlement.set({
    id,
    totalDeposited: base.totalDeposited + (delta.deposited ?? 0n),
    totalReleased: base.totalReleased + (delta.released ?? 0n),
    totalRefunded: base.totalRefunded + (delta.refunded ?? 0n),
    payoutCount: base.payoutCount + (delta.payouts ?? 0),
  });
}

/** 에스크로를 종결 상태로 옮긴다(Released/Refunded/NoShowSettled). 입금이 구독 시작보다 앞서
 *  행이 없으면 지나간다 — 그 돈은 우리 창 밖에서 이미 흘렀다. */
async function settleEscrow(
  context: handlerContext,
  event: SettlementEvent,
  status: string,
): Promise<void> {
  const cur = await context.Escrow.get(String(event.params.tokenId));
  if (!cur) return;
  context.Escrow.set({
    ...cur,
    status,
    releasedAt: BigInt(event.block.timestamp),
    settleTxHash: event.transaction.hash,
  });
}

/** 수취인의 pull 잔액(= PendingWithdrawal)을 올린다. id = recipient-token. */
async function creditPending(
  context: handlerContext,
  recipientRaw: string,
  tokenRaw: string,
  amount: bigint,
): Promise<void> {
  const recipient = addr(recipientRaw);
  const token = addr(tokenRaw);
  const id = `${recipient}-${token}`;
  const cur = await context.PendingWithdrawal.get(id);
  context.PendingWithdrawal.set({ id, recipient, token, amount: (cur?.amount ?? 0n) + amount });
}

if (settlementContract) {
  const SettlementVault = settlementContract;

  // PolicySet(eventId, organizer, policyHash, version). 수취인 분배는 getPolicy 로 읽어 JSON 으로.
  SettlementVault.PolicySet.handler(async ({ event, context }) => {
    const eventId = event.params.eventId as bigint;
    const policy = await context.effect(readPolicy, {
      eventId,
      blockNumber: BigInt(event.block.number),
    });
    const recipients = policy.recipients.map((r) => ({
      account: addr(r.account),
      bps: r.bps,
      reasonHash: r.reasonHash,
      tag: r.tag,
    }));
    context.SettlementPolicy.set({
      id: eventId.toString(),
      eventId,
      organizer: addr(String(event.params.organizer)),
      policyHash: String(event.params.policyHash),
      version: Number(event.params.version),
      platformBps: policy.platformBps,
      reserveBps: policy.reserveBps,
      noShowRefund: policy.noShowRefund,
      recipients: JSON.stringify(recipients),
      setAt: BigInt(event.block.timestamp),
      txHash: event.transaction.hash,
    });
    await bumpSettlement(context, eventId, {}); // 집계 행을 먼저 세워 둔다.
  });

  // Deposited(eventId, tokenId, token, amount, payer) — 에스크로를 Held 로 연다.
  SettlementVault.Deposited.handler(async ({ event, context }) => {
    const eventId = event.params.eventId as bigint;
    const amount = BigInt(event.params.amount as bigint);
    context.Escrow.set({
      id: String(event.params.tokenId),
      eventId,
      token: addr(String(event.params.token)),
      amount,
      payer: addr(String(event.params.payer)),
      status: 'Deposited',
      depositedAt: BigInt(event.block.timestamp),
      releasedAt: undefined,
      depositTxHash: event.transaction.hash,
      settleTxHash: undefined,
    });
    await bumpSettlement(context, eventId, { deposited: amount });
  });

  // Released(eventId, tokenId, token, amount) — 입장 뒤 분배. 수취인 줄은 Paid 가 따로 낸다.
  SettlementVault.Released.handler(async ({ event, context }) => {
    await settleEscrow(context, event, 'Released');
    await bumpSettlement(context, event.params.eventId as bigint, {
      released: BigInt(event.params.amount as bigint),
    });
  });

  // NoShowSettled(eventId, tokenId, token, amount) — 노쇼 몫을 수취인에게(환불 아님) 분배.
  SettlementVault.NoShowSettled.handler(async ({ event, context }) => {
    await settleEscrow(context, event, 'NoShowSettled');
    await bumpSettlement(context, event.params.eventId as bigint, {
      released: BigInt(event.params.amount as bigint),
    });
  });

  // Refunded(eventId, tokenId, token, amount, payer) — 취소/노쇼환불로 payer 에게 되돌림.
  SettlementVault.Refunded.handler(async ({ event, context }) => {
    await settleEscrow(context, event, 'Refunded');
    await bumpSettlement(context, event.params.eventId as bigint, {
      refunded: BigInt(event.params.amount as bigint),
    });
  });

  // Paid(eventId, tokenId, recipient, amount, reasonHash) — 분배의 수취인 한 줄.
  SettlementVault.Paid.handler(async ({ event, context }) => {
    context.Payout.set({
      id: `${event.transaction.hash}-${event.logIndex}`,
      eventId: event.params.eventId as bigint,
      tokenId: event.params.tokenId as bigint,
      recipient: addr(String(event.params.recipient)),
      amount: BigInt(event.params.amount as bigint),
      reasonHash: String(event.params.reasonHash),
      at: BigInt(event.block.timestamp),
      txHash: event.transaction.hash,
    });
    await bumpSettlement(context, event.params.eventId as bigint, { payouts: 1 });
  });

  // PayoutDeferred(eventId, tokenId, recipient, token, amount) — push 실패분을 pull 로 적립.
  SettlementVault.PayoutDeferred.handler(async ({ event, context }) => {
    await creditPending(
      context,
      String(event.params.recipient),
      String(event.params.token),
      BigInt(event.params.amount as bigint),
    );
  });

  // Withdrawn(recipient, token, amount) — withdraw() 는 그 토큰 잔액을 통째로 뺀다 → 적립분을 뺀다.
  SettlementVault.Withdrawn.handler(async ({ event, context }) => {
    const recipient = addr(String(event.params.recipient));
    const token = addr(String(event.params.token));
    const id = `${recipient}-${token}`;
    const cur = await context.PendingWithdrawal.get(id);
    const amount = cur ? cur.amount - BigInt(event.params.amount as bigint) : 0n;
    context.PendingWithdrawal.set({ id, recipient, token, amount: amount > 0n ? amount : 0n });
  });

  // TokenAllowed(token, allowed) — USDC(및 향후 스테이블) 허용 목록.
  SettlementVault.TokenAllowed.handler(async ({ event, context }) => {
    context.SettlementToken.set({
      id: addr(String(event.params.token)),
      allowed: Boolean(event.params.allowed),
    });
  });

  // DepositorSet(account, allowed) — 트레저리/PG 어댑터 허용 목록.
  SettlementVault.DepositorSet.handler(async ({ event, context }) => {
    context.SettlementDepositor.set({
      id: addr(String(event.params.account)),
      allowed: Boolean(event.params.allowed),
    });
  });
}
