# 01c — approval-mode claims — ABI and behaviour delta

승인제(관리자 승인 후 발급) 이벤트를 온체인으로 강제하는 변경이다. 기획서 §B(UX revision 3,
`docs/superpowers/plans/2026-09-26-monti-ux-revision-3.md`)의 결정 — "승인제 = 컨트랙트로 구현" —
을 `Ticket.sol` 하나에 담았다. **`Ticket` 만 바뀐다.** Identity·Organizers·MontiPaymaster 는
바이트가 그대로다(ABI 재수출에서도 Ticket.json 만 diff 가 난다).

선례는 두 곳이다: 신청/승인 두 단계 권한 축은 `requestOverride`/`manualOverride`
(`Ticket.sol` ROLE_APPROVER/ROLE_MANAGER)를, 자격 검사는 `claim` 을 그대로 모방했다.

모든 셀렉터·topic0 는 커밋된 export 에서 `cast sig` / `cast keccak` 로 재도출했다.

---

## 1. `Ticket` 함수 추가 (6개)

| Kind | Signature | Selector | What it is |
|---|---|---|---|
| function | `requestClaim(uint256,uint8)` | `0x85563044` | 관객이 승인제 이벤트에 신청한다. 민팅 없음, `requestId` 반환. `claim` 과 같은 자격 검사 + 신청 시점 공급 예약 |
| function | `approveClaims(uint256,uint256[])` | `0x0b177ad6` | 승인 권한자가 대기 신청들을 `claim` 내부 경로로 민팅. 대기 아닌 요청은 건너뜀(배치 되돌리지 않음) |
| function | `rejectClaims(uint256,uint256[])` | `0x2c261b04` | 승인 권한자가 대기 신청들을 거절, 예약 해제 |
| function | `cancelRequest(uint256,uint256)` | `0xd586d2e4` | 신청자 본인이 대기 중인 자기 요청을 취소, 예약 해제 |
| function | `claimRequest(uint256,uint256)` | (view) | `ClaimRequest{requester,tier,status}` 반환. status 0 대기·1 승인·2 거절/취소 |
| function | `pendingCount(uint256)` | (view) | 이벤트의 현재 대기(status 0) 신청 수 |

## 2. `Ticket` 이벤트 추가 (3개)

| Kind | Signature | topic0 |
|---|---|---|
| event | `ClaimRequested(uint256,uint256,address,uint8)` | `0x001cf03d8840ce6d70c7dc9a502900cf8accac4c652df240ec0cbba99dee7554` |
| event | `ClaimApproved(uint256,uint256,uint256)` | `0x4dca51fe62778515537c102a1e70b6860ccf0d30595ecf313f2a901614b6f505` |
| event | `ClaimRejected(uint256,uint256)` | `0x621ea19c1c391f183740fbd3d1b9f99b02a5726390a86366e23d2e729899bac1` |

- `ClaimRequested(eventId, requestId, requester, tier)` — 앞 세 인자 indexed.
- `ClaimApproved(eventId, requestId, tokenId)` — eventId·requestId indexed. **같은 트랜잭션에서
  `Claimed(tokenId,eventId,to,tier)` 도 나간다** → 인덱서의 `Ticket` 행은 직접 `claim` 과 동일하게
  생성된다(별도 핸들러 불필요, 상태 패치만).
- `ClaimRejected(eventId, requestId)` — 거절과 신청자 취소가 **같은 이벤트**를 쓴다(취소도 결과적으로
  거절과 같은 종료 상태이므로, 인덱서는 이벤트 하나만 보면 된다).

## 3. `Ticket` 에러 변경

| 변화 | Signature | Selector |
|---|---|---|
| 제거 | ~~`ApprovalRequiredNotSupported()`~~ | — |
| 추가 | `ApprovalRequired()` | `0x5fcb45ee` |
| 추가 | `ApprovalNotRequired()` | `0x2805f1de` |
| 추가 | `RequestNotPending()` | `0xf41814a7` |

- `claim` 은 승인제 이벤트에서 이제 `ApprovalRequired()` 로 되돌린다(직접 발급 봉쇄 → 신청 경로 강제).
- `requestClaim` 은 선착순(`approvalRequired==false`) 이벤트에서 `ApprovalNotRequired()` 로 되돌린다.
- `cancelRequest` 는 대기 상태가 아닌 요청에서 `RequestNotPending()` 로 되돌린다.

## 4. 권한 비트 추가 — `PERM_APPROVE_CLAIM = 32`

권한 비트는 `Organizers._adminBits` **한 네임스페이스**를 Ticket 과 Organizers 가 함께 쓴다.
쓰인 비트: 1 `PERM_CREATE_EVENT` · 2 `PERM_MANAGE_GATES` · 4 `PERM_APPROVE_OVERRIDE`(Ticket) ·
8 `PERM_MANAGE_MANAGERS` · 16 `PERM_MANAGE_BUDGET`(Organizers). **다음 빈 비트는 32.**
(8 을 골랐다면 `PERM_MANAGE_MANAGERS` 와 충돌해 매니저 관리 권한자가 승인 권한까지 갖게 된다 —
회귀 테스트 `test_strangerManagerNoAndWrongAdminBitAllRejected` 가 이 비충돌을 못박는다.)

`approveClaims`/`rejectClaims` 권한: **소유자**(전 비트 보유) · **`PERM_APPROVE_CLAIM` admin** ·
**`canApprove` 매니저**. `manualOverride` 의 ROLE_APPROVER/ROLE_MANAGER 와 같은 축이다.

## 5. 페이마스터 허용 목록 (재배포 불필요, 배포 후 `setAllowed`)

`MontiPaymaster` 는 **바뀌지 않고 재배포하지 않는다.** 새 Ticket 을 배포한 뒤, 배포자가
`setAllowed(selector, kind, word)` 를 네 번 호출해 스폰서 대상에 추가한다. 넷 다
`ArgKind.EventId(=2)`, word `0`(첫 인자가 스칼라 `uint256 eventId` — `claim` 과 같은 규약).

| Selector | Signature | ArgKind | word |
|---|---|---|---|
| `0x85563044` | `requestClaim(uint256,uint8)` | EventId | 0 |
| `0x0b177ad6` | `approveClaims(uint256,uint256[])` | EventId | 0 |
| `0x2c261b04` | `rejectClaims(uint256,uint256[])` | EventId | 0 |
| `0xd586d2e4` | `cancelRequest(uint256,uint256)` | EventId | 0 |

동적 배열(`uint256[]`)이 뒤에 와도 문제없다 — 페이마스터는 **첫 워드(eventId)만** 읽어 스폰서
슬롯을 정하고, 배열 워드는 건드리지 않는다. (배열을 인자로 지목했다면 오프셋이라 디코딩 불가 —
그래서 word 0 의 eventId 를 쓴다.) 새 배포 스택을 처음부터 세운다면 같은 네 줄을 페이마스터
생성자 `_seedSelectors()` 에 `_allow(..., ArgKind.EventId)` 로 넣으면 된다(이번 재배포에는 불필요).

## 6. 동작 규약

- **공급 예약.** `requestClaim` 은 신청 시점에 `t.minted += 1` 로 공급을 예약한다. 그래서
  대기 + 발급이 `supply` 를 절대 넘지 못한다(초과 발행 방지). `approveClaims` 는 예약을 발급으로
  전환할 뿐 공급을 두 번 세지 않는다. `rejectClaims`/`cancelRequest` 는 예약을 되돌린다.
- **지갑 한도 = 대기 + 발급.** `requestClaim` 은 `balanceOfEvent + _pendingOf >= maxPerWallet`
  로 막는다. 승인되면 `_pendingOf` 몫이 `balanceOfEvent` 로 옮겨가 한도가 그대로 유지된다.
- **부분 승인에 강함.** `approveClaims`/`rejectClaims` 는 이미 대기가 아닌 요청(승인·거절·취소·
  미존재)을 만나면 **되돌리지 않고 건너뛴다.** 중복 제출·경합·존재하지 않는 id 가 섞여도 안전하다.
- **인덱서 호환.** 승인 민팅도 `Claimed` 를 낸다 → `Ticket` 행 정상 생성.

## 7. 가스 · 크기

- **`approveClaims` 항목당 가스(한계):** 약 **101,528 gas/item**(1건 배치 112,418 gas, 6건 배치
  620,059 gas, 차이 ÷5). 대부분 `_safeMint` 의 ERC-721 SSTORE 다. `test_batchApproveGasPerItem` 참조.
- **크기 게이트(`ContractSize.t.sol`, Monad 한도 131,072B):** Ticket 런타임 26,351 → **29,574 B**
  (+3,223), 여유 **101,498 B**. 이니트코드 27,665 → 30,916 B. 게이트 녹색.

## 8. 재배포 노트

- **Ticket 만 재배포.** Identity·Organizers 는 그대로. 새 Ticket 주소를 Organizers `setTicket`
  (배포자, 1회)로 다시 물리고, 페이마스터 생성자 immutable `ticket` 은 옛 주소를 가리키므로 —
  스폰서 검증은 `ticket` 주소 대상 호출만 받는다 — **새 Ticket 을 물린 페이마스터가 필요하다.**
  즉 실무적으로 페이마스터도 새 Ticket 주소로 다시 세워야 스폰서가 새 Ticket 을 받는다. 셀렉터
  네 개는 §5 의 `setAllowed` 로 넣는다.
- Organizers 는 `setTicket` 이 1회성(`TicketAlreadySet`)이라, Ticket 재배포는 Organizers 도
  새로 배포해 다시 엮거나, 배포 스크립트대로 네 컨트랙트를 함께 재배포하는 흐름을 따른다
  (01b Task 15 재배포 절차와 동일). — **결정 필요 지점:** §5 는 "페이마스터 재배포 불필요"라는
  과업 지시를 따르나, 페이마스터 `ticket` 이 immutable 이라 새 Ticket 을 스폰서하려면 재배포가
  사실상 필요하다. 배포자가 01b 번들처럼 네 컨트랙트를 함께 재배포하면 §5 는 생성자 씨딩으로
  대체된다.

## 9. 컨슈머 후속(이 과업 범위 밖 — 웹/인덱서는 건드리지 않음)

- `apps/web/src/staff/types.ts` 의 에러 이름 목록에서 `ApprovalRequiredNotSupported` 를 빼고
  `ApprovalRequired`/`ApprovalNotRequired`/`RequestNotPending` 를 넣는다.
- `apps/web/src/organizer/scene/usePublish.ts` 의 주석(옛 되돌림 설명)을 갱신.
- `packages/shared/src/chain/abis.ts`·`UsedFunction` 에 네 함수 추가(T-UX3-2 웹 몫).
- 인덱서 `schema.graphql`/`EventHandlers.ts` 에 `ClaimRequest` 타입 + 3개 핸들러(기획서 §B-4).

## 10. Deployed 2026-09-26 — Monad testnet (chain 10143)

T-UX3-3. A **new Ticket and a new MontiPaymaster** on the **kept** Identity and Organizers — no
account was reset. `forge script DeployTicket` then `forge script Seed`, both `--broadcast --slow
--non-interactive --code-size-limit 131072`, RPC `https://testnet-rpc.monad.xyz`. 369 tests (363 +
6 new `DeployTicketTest`) and `.github-checks.sh` green on `8fbebab` beforehand.

| | Address |
|---|---|
| `ticket` (new) | `0x40D90AF3a3B22542AEeF0ec3E6a66F1EAb6f7AFA` |
| `paymaster` (new) | `0xf73220B082114D4E37bAE8d3ab7E76CAdA858dE4` |
| `identity` (kept) | `0x961a895b47Cf200C14acf38F5689979FF5bd8133` |
| `organizers` (kept) | `0xa88C8D110Ca8f0c925A781AB8042bA012d7281F0` |
| `attester` (kept) | `0x6af898aA4d99375839d7069431A7019a6D84C4Ed` |
| `entryPoint` (kept) | `0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789` |
| `coinbaseFactory` (kept) | `0xBA5ED110eFDBa3D005bfC882d75358ACBbB85842` |
| retired (`previous[0]`) | `ticket 0x4B8353C9…1367` / `paymaster 0xBDDBDaA9…28B2` |

`block` = **65856800** (simulation-time lower bound; the eight deploy tx landed in
65856830–65856857, the eight seed tx in 65857217–65857256).

**Why a new paymaster and not a Ticket-only redeploy** — see §8: `MontiPaymaster.ticket` is immutable
and `_slotOfInnerCall` refuses any other target, so a Ticket at a new address is unsponsored by the
old paymaster. **Why Organizers was not re-pointed** — `setTicket` is once-only and already spent on
the retired Ticket; it does not need re-pointing, because every `Ticket → Organizers` call
(`hasPermission`/`ownerOf`/`isOpenGate`/`gateInfo`/`gateOf`/`managerOf`) is independent of
`Organizers.ticket`, and gate management for the reused org 1 / event 1 resolves the same org through
the retired Ticket (`eventOrg(1) = 1`). A gate for an event that exists only on the new Ticket cannot
be registered through this Organizers — out of scope for the demo, flagged for the record.

**Allow-list on the new paymaster** — the constructor re-seeded the whole 2026-09-23 table (§10 of
`abi-delta-01b.md`, 29 selectors), and `DeployTicket.installApprovalSelectors` added the four 01c
rows with `setAllowed`, for **33** total. The four new, read back with `argKindOf`/`argWordOf`
(2 = EventId):

| Selector | Signature | Kind | Word |
|---|---|---|---|
| `0x85563044` | `requestClaim(uint256,uint8)` | 2 | 0 |
| `0x0b177ad6` | `approveClaims(uint256,uint256[])` | 2 | 0 |
| `0x2c261b04` | `rejectClaims(uint256,uint256[])` | 2 | 0 |
| `0xd586d2e4` | `cancelRequest(uint256,uint256)` | 2 | 0 |

**Seed** (`SEED_REUSE_ORG=1`): org 1 reused (owner = deployer), a fresh event 1 created and published
on the new Ticket, the placeholder gate reused (already registered and open, bound to event 1, which
the new Ticket's first event also is), the three demo members skipped on `register` (already on the
kept Identity) and re-issued tickets 1/2/3 on the new Ticket. `isOpenGate(1, gate)` on the new event
is true. `seed-10143.json` is byte-identical to the 2026-09-23 file — the ids did not change.

**Cost.** Deploy: 8 tx (CREATE Ticket + CREATE paymaster + `addStake` + `depositPlatform` +
4 × `setAllowed`), plus 1 MON stake and 1 MON EntryPoint deposit. Seed: 8 tx (deployer 5, three
members one claim each; zero attester tx — the members were already registered). Gas at 102 gwei.
Deployer `0x509ed82E…BCf3` 11.530 → **8.004 MON** (−3.526, of which **2 MON is the recoverable stake
+ deposit**, ~1.53 MON gas + member top-ups). New Ticket runtime ≈ 29,574 B (Monad's 131,072 B
limit; EIP-170 not enforced here).

**Old paymaster funds — recovery pending (not executed).**
`0xBDDBDaA9811C8944AF82319b19169A209A0928B2` still holds **1 MON deposit + 1 MON stake**
(`getDepositInfo` = `(1e18, true, 1e18, 86400, 0)` — unlock not started). Recovery:
`withdrawPlatform(to, 1e18)` for the deposit now (deployer-only), and `unlockStake()` → wait 24 h →
`withdrawStake(to)` for the stake. Both are deployer-only and safe to run any time.

## 11. Deployed 2026-09-28 — full redeploy (chain 10143)

전체 재배포다. 01c 부분 재배포(§10)는 Ticket·Paymaster 만 새로 올리고 Identity·Organizers 를
유지했지만, kept Organizers 의 `setTicket` 은 한 번만 호출 가능하고 이미 옛 Ticket 에 묶여 있어
**새 행사가 자기 게이트를 등록할 수 없다**. 실제 스태프 게이트가 나중에 앱의 pendingGates 흐름으로
등록되려면 fresh Organizers 가 필요하므로 네 계약을 모두 새로 배포했다. **ABI 는 그대로다**(01c 가 이미
소비자에 반영됨) — 주소 4개만 바뀐다.

새 주소:

| | Address |
|---|---|
| `identity` (**new**) | `0xa2914cA1F78DbBb872f5093587AC3c51c219fc80` |
| `organizers` (**new**) | `0x5D8Ed32AE39Fa8b1d0F9870485FC259c64FFDc11` |
| `ticket` (**new**) | `0x6046e51B3127a4f8F71d83A83b2d265d25A3CfE5` |
| `paymaster` (**new**) | `0xe8dD86534453Ff512ECF6252D7a4DFAB265a9EF3` |
| gate account (seed, **placeholder**, reused) | `0xDe2F7cf570Fe27308CC8256F033376aF2683b8dA` |
| `attester`/`entryPoint`/`coinbaseFactory` (reused) | `0x6af898aA…C4Ed` / `0x5FF137D4…2789` / `0xBA5ED110…5842` |

`block` = **66320553** (Deploy 가 기록한 시뮬레이션 시점 값, 인덱서 `start_block` 의 하한).
`deployments/10143.json` 의 `previous[]` 에 09-26 세트(identity/organizers/ticket/paymaster,
block 65856800)와 09-23 세트(ticket/paymaster, block 64921775)를 순서대로 보존했다.

**예치금.** `Deploy.s.sol` 이 stake 1 MON + deposit 1 MON(EntryPoint) 을 넣은 뒤, deployer 가
`EntryPoint.depositTo(paymaster)` 로 **4 MON 을 추가 예치**했다(페르소나 harness 예산). 플랫폼 슬롯은
내부 카운터가 아니라 `budgetOf(PLATFORM) = entryPoint.balanceOf(paymaster)` 를 직접 읽으므로 depositTo
가 그대로 플랫폼 예산이 된다. 확인: `budgetOf(0) = 5e18`, `EntryPoint.balanceOf(pm) = 5e18`.

**허용 목록.** 생성자가 29개(§10 / abi-delta-01b §10)를 심고, 배포 후 deployer 가 `setAllowed` 로
01c 4개를 추가해 **33개**. 4개는 `argKindOf/argWordOf = EventId(2) / word 0` 로 확인:
`requestClaim 0x85563044`, `approveClaims 0x0b177ad6`, `rejectClaims 0x2c261b04`,
`cancelRequest 0xd586d2e4`. 브리핑이 확인 요청한 셀렉터(createEvent·updateEventMeta·claim·checkIn·
checkInLate·transfer/offer·cancelRotation·createOrganizer·setAdmin·승인 4개) 전부 `allowedSelector = true`,
attester 전용(`register 0x2ddda87f`·`rotateAccount 0xda8c1ce8`)은 의도대로 `false`.

**시드(실제 스태프 폰 없음 → 플레이스홀더 게이트).** fresh Organizers 라 `SEED_REUSE_ORG` 는 끈 채:
`createOrganizer`(org 1, owner=deployer) → `createEvent`/`publishEvent`(event 1, "MONTI Demo Night",
approvalRequired=false) → `registerGate`+`openGate`(gate 1, 2026-09-23 플레이스홀더 KX/KY) → 데모 멤버
3명 `register`(attester)+`claim` → 토큰 1/2/3. `isOpenGate(1, gate) = true`. `seed-10143.json` 은 id 가
그대로여서(org/event/gate = 1/1/1, tokens 1/2/3, 결정적 멤버 키) 이전 파일과 바이트 동일. 실제 스태프
게이트는 나중에 앱 pendingGates 로 event 1 에 `registerGate`+`openGate` 하면 된다(재시드 불필요).

**비용.** deployer `0x509ed82E…BCf3` **11.893 → 4.038 MON**(−7.855, 이 중 stake 1 MON 은 `unlockStake`
→24h→`withdrawStake` 로 회수 가능, deposit 5 MON 은 gas 예산으로 소진). attester `0x6af898aA…C4Ed`
**3.551 → 3.463 MON**(−0.088, 데모 멤버 3명 `register` 가스). 가스가 203 gwei 로 09-26(102 gwei)보다
높아 절대 비용이 커졌다.

**옛 페이마스터 자금(이월).** `0xf73220B0…858dE4`(01c) 와 `0xBDDBDaA9…0928B2`(01b) 는 여전히 각
1 MON deposit + 1 MON stake 를 들고 있다. `withdrawPlatform` 은 즉시, `unlockStake`→24h→`withdrawStake`
로 회수 가능(모두 deployer 전용).
