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

// envio 는 이 파일을 ts-node 의 **CJS** 로더로 require 한다(`generated/src/Generated.res.js`
// 의 registerContractHandlers). `generated/index.js` 는 `module.exports = {...handlers, …}`
// 라 스프레드로 만든 객체이고, Node 의 cjs-module-lexer 는 거기서 `Identity` 를 이름으로
// 찾아내지 못한다 — 값을 `import` 로 가져오면 vitest(네이티브 ESM 경로)에서
// "does not provide an export named 'Identity'" 로 죽는다. 타입만 `import type` 으로
// 가져오고 값은 require 로 받으면 두 경로 모두에서 돈다. generated 의 `*.gen.ts` 들도
// 똑같이 한다.
const { Identity, Organizers } = require('generated') as typeof import('generated');

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
 * 그래서 이 한 핸들러가 회전과 회전 취소를 모두 처리하고, `RotationCancelled` 는
 * 인덱서에게 순수한 감사 로그다 — 이 저장소의 ABI 에 들어오더라도 쓸 열이 없다.
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
