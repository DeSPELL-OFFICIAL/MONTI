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
