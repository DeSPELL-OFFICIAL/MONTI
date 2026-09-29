# MONTI 릴레이 전환 Phase 2 — 설계 (2026-09-29)

상태: 설계안(코드 변경 없음, 배포 없음). Phase 1(발급 `claimFor`/신청 `requestClaimFor`/입장
`checkInFor`/`checkInForLate`)은 **이미 mvp 에 병합·라이브**다(git: 4e18724 등). Phase 2 는
**남아 있는 모든 스폰서드 UserOperation**(주최자 동작 + 남은 관객 동작=양도/신청취소)을
**기기 키가 서명하고 릴레이어가 대신 내는 일반 트랜잭션**으로 옮긴다. 그 결과 **ERC-4337
전체(MontiPaymaster·예치금/스테이크·Alchemy 번들러·`sendSponsoredOp` 경로·스마트계정 사전배포)
를 폐기**한다.

근거 파일(현행, MONTI-prod HEAD): `contracts/src/{Ticket.sol(1023L),Organizers.sol(205L),
Identity.sol(274L),MontiPaymaster.sol}`, `apps/web/src/shared/chain/{sendSponsoredOp,ops,
bundler,unsponsored,client}.ts`, `functions/src/functions/relay.ts(506L)`,
`functions/src/lib/{relayer.ts,relayTypes.ts,auth.ts}`, phase-1 설계/계획
(`2026-09-28-monti-relayed-actions-{design,plan}.md`).

---

## 0. 창업자용 한국어 요약 (비개발자, ≤20줄)

- **무엇을 바꾸나.** 주최자가 하는 일(행사 만들기·공개·수정·취소, 게이트 등록/열기/닫기/폐기,
  신청 승인/거절, 팀원 지정)과 관객의 남은 특수 트랜잭션(티켓 양도 보내기/취소/받기, 신청
  취소, 닉네임)을 지금은 비싼 스폰서드 op(4337)으로 냅니다. 이걸 관객·주최자가 **자기 기기
  키로 서명**하면 **MONTI 서버 지갑(릴레이어)이 대신 내는 일반 트랜잭션**으로 바꿉니다.
- **가장 큰 이득(비용보다 중요).** 스폰서드 op이 완전히 사라지므로 **유료 대납기(Paymaster)·
  그 예치금과 스테이크·외부 번들러(Alchemy)·`sendSponsoredOp` 코드 전체**를 지웁니다.
  가입할 때 하던 **스마트계정 사전배포 트랜잭션도 없앱니다**(주소만 쓰고 배포는 안 함).
  의존성·운영·코드가 크게 줄어드는 게 이번의 핵심입니다(창업자 원칙: 안 쓰는 경로 삭제).
- **어떻게(설계 한 줄).** 함수마다 `xFor` 를 20개씩 만들지 않고, **하나의 전달자(Forwarder)
  컨트랙트**를 둡니다. 검증된 표준(OpenZeppelin ERC-2771)을 기기 키(P-256)에 맞게 살짝 바꾼
  것입니다. Forwarder 가 서명을 확인하고 원래 함수를 호출하면, 컨트랙트는 "진짜 요청한 사람"을
  그대로 인식해 기존 권한 검사가 한 줄도 안 바뀝니다.
- **비용(100명 행사).** 지금 ≈ **4.9 MON**. Phase 2 로 주최자·승인 동작을 릴레이로 옮기면
  ≈ **4.5~4.6 MON**(₩40/MON 기준 ≈ **₩180~185/100명 행사**). 저장 슬림화(§12)는 **이미 09-29
  배포에 들어가 있어** 추가 절감 여지가 없고, 목표 4.1 은 이 구조로는 도달하지 않습니다(§6 정정).
  승인형 행사는 승인 트랜잭션이 릴레이로 바뀌어 가장 크게 줍니다(≈ 8~13 → ≈ 5.1 MON).
- **관객·주최자 화면.** 서명 방식·화면 흐름·게이트 판정 그대로. web3 단어 계속 안 보입니다.
- **가장 큰 위험 3.** ① Forwarder 한 홉이 동작당 gas ~10~15k 더 듦(주최자 동작은 저빈도라 무해,
  발급/입장엔 안 태움). ② 릴레이어가 이제 **모든 가스의 단일 지불처** — 잔액/알림/키 관리 집중.
  ③ ERC-2771 은 "믿는 Forwarder"만 발신자를 덧붙일 수 있어야 함(주소 고정+대상 allowlist 로 방어).
- **일정 감각.** 컨트랙트(Forwarder+ERC-2771, 재배포 필수) → 백엔드 콜러블 1개 →
  웹 주최자/양도/스태프 → e2e(≈4.5 실측·4337 코드 0 확인) → 컷오버. ≈ **6~9일**(에이전트 작업).

---

## 1. Q1 — 다수 함수의 인가 형식: 일반 메타트랜잭션 Forwarder (옵션 B) 채택

### 결정
**하나의 `MontiForwarder` 컨트랙트 + ERC-2771 컨텍스트**를 채택한다(옵션 B). 함수마다 `xFor(Auth,
sig)` 변형을 만드는 옵션 A 는 **기각**. **단, Phase 1 의 `claimFor`/`requestClaimFor`/`checkInFor`/
`checkInForLate` 는 지금 그대로 두고 Forwarder 로 통합하지 않는다**(하이브리드).

### Forwarder 인터페이스 (신규 독립 컨트랙트, `contracts/src/MontiForwarder.sol`)
```solidity
struct ForwardRequest {
    address from;      // 행위 주체(관객/주최자 스마트 계정 주소)
    address to;        // ticket | organizers | identity (대상 allowlist)
    uint256 nonce;     // == forwarderNonce[from]
    uint64  deadline;  // block.timestamp <= deadline
    bytes   data;      // 대상 함수 calldata (from 은 미포함 — 아래서 append)
}
bytes32 private constant FORWARD_REQUEST_TAG = keccak256("MONTI:FORWARD_REQUEST:v1");
mapping(address => uint256) public forwarderNonce;   // from 별 순번(자동 getter=클라가 읽음)
IIdentity public immutable identity;                 // activeDevice/isMember/isLocked
address   public immutable ticket;
address   public immutable organizers;               // identity 는 address(identity) 로 대상 검사

function forwardDigest(ForwardRequest calldata r) public view returns (bytes32) {
    return sha256(abi.encode(
        FORWARD_REQUEST_TAG, block.chainid, address(this),
        r.from, r.to, r.nonce, r.deadline, keccak256(r.data)));   // 계약·체인·호출 전체를 바인딩
}

function execute(ForwardRequest calldata r, bytes calldata deviceSig)
    external returns (bytes memory ret)
{
    if (block.timestamp > r.deadline) revert AuthExpired();
    if (r.to != ticket && r.to != organizers && r.to != address(identity)) revert TargetNotAllowed();
    if (r.nonce != forwarderNonce[r.from]) revert BadNonce();
    if (!identity.isMember(r.from)) revert NotMember();
    if (identity.isLocked(r.from)) revert DeviceLocked();
    (bytes32 x, bytes32 y) = identity.activeDevice(r.from);
    if (deviceSig.length != 64) revert BadDeviceSignature();
    (bytes32 sr, bytes32 ss) = abi.decode(deviceSig, (bytes32, bytes32));
    if (!P256.verifySignature(forwardDigest(r), sr, ss, x, y)) revert BadDeviceSignature();
    forwarderNonce[r.from]++;                                       // 소비(호출 전, CEI)
    bool ok;
    (ok, ret) = r.to.call(abi.encodePacked(r.data, r.from));        // ERC-2771: data ‖ from
    if (!ok) assembly { revert(add(ret, 0x20), mload(ret)) }        // 대상 revert 그대로 버블
}
```
- **P-256·sha256·태그** 는 Phase 1 `claimAuthDigest` 와 동일 계열이다. 그래서 클라이언트의
  `signWithDeviceKey`(raw 32B 다이제스트 서명, WebCrypto 프리이미지/네이티브 다이제스트 규칙
  포함, 09-29 fix) 가 **한 줄도 안 바뀌고** 그대로 재사용된다. EIP-712 keccak(OZ 원본) 대신
  sha256-태그를 쓰는 유일한 이유가 이 서명 경로 일치다.
- OZ `ERC2771Forwarder.execute` 를 **P-256(기기 키)·Identity 해석·sha256 태그**로 각색한 것.
  검증된 패턴을 그대로 따르되 서명계만 프로젝트 것으로 바꿈(창업자 원칙 1·6·8).

### 대상 컨트랙트: ERC-2771 컨텍스트 인지 (Ticket·Organizers·Identity)
OZ `ERC2771Context` 를 상속하고 `trustedForwarder = MontiForwarder`(immutable)로 둔다. 그러면
`_msgSender()` 가 **`msg.sender==forwarder` 일 때 append 된 마지막 20바이트(=from)** 를, 아닐 때
`msg.sender` 를 돌려준다. 기존 권한 검사에서 **`msg.sender` → `_msgSender()`** 로만 바꾸면
`hasPermission(orgId, _msgSender(), bit)`·`ownerOf(tokenId)==_msgSender()` 등 **모든 검사가 그대로
동작**한다(§2 목록). ERC-721 내부(`approve`/`transferFrom`/`_update`)도 `_msgSender()`를 쓰므로
`safeTransferFrom`·`acceptOffer` 도 자동으로 Forwarder 경로가 된다.

### 근거 (옵션 A vs B, 그리고 하이브리드 경계)
- **함수 수.** 이관 대상이 **Ticket 15 + Organizers 6 + Identity 2 ≈ 23개**(§2). 옵션 A 는
  23개 `xFor` + 23개 다이제스트 + 23개 백엔드 시뮬 경로. 옵션 B 는 **컨트랙트 1개 + 다이제스트
  1개 + 콜러블 1개**. 창업자 "가장 단순한 구현"에 압도적으로 부합.
- **컨트랙트 크기.** Ticket 은 이미 크다. 옵션 A 는 23개 함수 본문을 Ticket/Organizers 에
  더해 크기를 키운다. 옵션 B 의 `ERC2771Context` 추가분은 미미(_msgSender/_msgData 2개)하고,
  무거운 검증 로직은 **별도 Forwarder 컨트랙트**에 있어 대상 크기에 안 얹힌다. **AC: 재배포 전
  `ContractSize.t.sol` 한도 통과 재확인**(Ticket 이 현 한도에 얼마나 여유인지 착수 시 실측 —
  미확인 항목, §8).
- **nonce 공유 vs 분리.** Forwarder 는 **from 별 단일 순번**. 주최자 동작(만들기→공개→게이트)과
  관객 양도는 **저빈도·순차 UI** 라 단일 순번으로 충분(동일 from 동시 2건이면 둘째가 BadNonce →
  릴레이어가 순서 보장 + 콜러블 멱등). 반대로 **발급/입장은 고빈도(100+/행사)** 이고 §12 가
  발급 nonce 를 (eventId,account) 로 좁혀 **콜드 슬롯 1개·행사 간 병렬**을 얻는다. 이를 단일
  Forwarder 순번에 넣으면 그 최적화가 깨지고 홉 gas 가 100배 곱해진다. **그래서 발급/입장은
  Forwarder 밖(현행 유지), 나머지는 Forwarder 안** — 이 경계가 하이브리드의 핵심이자 최적.
- **입장(checkInFor)은 구조적으로 Forwarder 에 안 맞음.** 입장은 "게이트가 관객을 넣는" **이중
  서명(게이트 키 + 관객 기기 키)** 이라 "from 이 자기 호출을 서명"하는 단일 발신 모델과 다르다.
  그대로 두는 게 옳다.
- **홉 오버헤드.** Forwarder 한 홉 ≈ +10~15k gas. 주최자 동작 실행 gas 가 수십만~백만대라 상대
  무해(§6). 발급/입장엔 안 태우므로 고빈도 비용에 영향 0.

---

## 2. Q2 — 이관 대상 열거 + `_msgSender()` 변경 지점

### 웹/스태프에 남은 스폰서드 op 전수(현행 selector, `functionName:` grep 기준)
| # | 함수 | 컨트랙트 | 호출부(apps/web/src) | 현행 인가(`msg.sender`) | Phase2 |
|---|---|---|---|---|---|
| 1 | createEvent | Ticket | organizer/scene/usePublish.ts:501 | hasPermission PERM_CREATE_EVENT | Forwarder |
| 2 | publishEvent | Ticket | organizer/lifecycle.ts:48 | _requireEventPermission | Forwarder |
| 3 | cancelEvent | Ticket | organizer/lifecycle.ts:48 | _requireEventPermission | Forwarder |
| 4 | updateEventMeta | Ticket | organizer/lifecycle.ts:48 | _requireEventPermission | Forwarder |
| 5 | approveClaims | Ticket | organizer/requests/Requests.tsx:103 | _requireClaimApprover | Forwarder |
| 6 | rejectClaims | Ticket | organizer/requests/Requests.tsx:103 | _requireClaimApprover | Forwarder |
| 7 | revoke | Ticket | (organizer 티켓 폐기) | _requireEventPermission | Forwarder |
| 8 | requestOverride | Ticket | staff/override/route.ts:148 | managerOf/PERM_APPROVE_OVERRIDE | Forwarder |
| 9 | manualOverride | Ticket | staff/override/route.ts:148 | PERM_APPROVE_OVERRIDE/managerOf | Forwarder |
| 10 | createOffer | Ticket | attendee/transfer/useInvite.ts:96 | ownerOf==sender | Forwarder |
| 11 | cancelOffer | Ticket | attendee/transfer/useInvite.ts:142 | ownerOf==sender | Forwarder |
| 12 | acceptOffer | Ticket | attendee/{transfer/offers.ts:54,tickets/Inbox.tsx:93} | offerDigest(sender)+_update(sender) | Forwarder |
| 13 | safeTransferFrom | Ticket(721) | attendee/transfer/useTransfer.ts:95 | ERC721 `_msgSender` | Forwarder(자동) |
| 14 | cancelRequest | Ticket | attendee/claim/ClaimFlow.tsx:284 | r.requester==sender | Forwarder |
| 15 | migrate | Ticket | attendee/me/NewDevice.tsx:295 | current==sender | Forwarder |
| 16 | registerGate | Organizers | organizer/gates/Gates.tsx:114 | PERM_MANAGE_GATES | Forwarder |
| 17 | openGate | Organizers | organizer/gates/Gates.tsx:114 | PERM_MANAGE_GATES(_mutateGate) | Forwarder |
| 18 | closeGate | Organizers | organizer/gates/Gates.tsx:114 | _mutateGate | Forwarder |
| 19 | revokeGate | Organizers | organizer/gates/Gates.tsx:114 | _mutateGate | Forwarder |
| 20 | setAdmin | Organizers | organizer/Team.tsx:312 | owner==sender | Forwarder |
| 21 | setManager | Organizers | organizer/Team.tsx:313 | PERM_MANAGE_MANAGERS | Forwarder |
| 22 | setNickname | Identity | attendee/me/Nickname.tsx:121 | isMember(sender) | Forwarder |
| 23 | cancelRotation | Identity | attendee/me/NewDevice.tsx:261 | _personOf[sender] | Forwarder |

부수(코드에 있으나 저빈도/특수): `transferOwner`(Organizers, owner==sender) — 발견 시 Forwarder.
`createOrganizer`(Organizers) — **미확인 항목**: 셀프서비스면 Forwarder, 온보딩을 어테스터/창업자가
하면 직접/어테스터 유지(§8 착수 시 확정). 소유권 이전·조직 생성은 극저빈도라 어느 쪽이든 비용 무관.

### `_msgSender()` 로 바꿀 지점 (라인 = 현행 Ticket.sol/Organizers.sol/Identity.sol)
- **Ticket.sol:** 280·294(createEvent+emit), 499(cancelRequest), 571·582·583(createOffer),
  587(cancelOffer), 599·603·604(acceptOffer), 742·743·752(requestOverride), 768·771·790
  (manualOverride), 820·830·833(migrate), 892(`_requireEventPermission` — publish/cancel/update/
  revoke 공통), 901·902(`_requireClaimApprover` — approve/reject 공통). ERC-721 상속 내부는 OZ
  가 `_msgSender()` 를 쓰므로 자동.
- **Organizers.sol:** 87(transferOwner), 95(setAdmin), 104(setManager), 129(registerGate),
  188(`_mutateGate` — open/close/revoke 공통). **70~71 `setTicket` 은 `msg.sender==deployer`
  로 유지**(배포자 1회 셋업, Forwarder 로 부르면 안 됨).
- **Identity.sol:** 221(setActiveDevice, isMember), 250·255·258·261·262·264(setNickname),
  141·145·149·156·157·160(cancelRotation). **`onlyAttester`(register/rotateAccount/setKycLevel)
  와 `lockDevice` 의 `msg.sender==attester()` 분기는 raw `msg.sender` 유지**(어테스터가 직접
  호출, Forwarder 비경유). `lockDevice` 의 `msg.sender==account` 분기는 `_msgSender()==account`
  로 바꿔 관객이 Forwarder 로 자기 잠금 가능하게.

### 그대로(서명·직접) 두는 것 — 명시
- **Phase 1 발급/입장** `claimFor`/`requestClaimFor`/`checkInFor`/`checkInForLate`: permissionless,
  (eventId,account) nonce, 이중서명 — **무변경**.
- **어테스터 흐름**(register/rotateAccount/setKycLevel/lockDevice[어테스터], setActiveDevice 의
  복구 케이스): 백엔드 어테스터 EOA 직접 호출 — Forwarder 밖. 기기 분실 복구는 어테스터가 권위.
- **배포자 셋업**(Organizers.setTicket, Forwarder 대상 고정): deployer 직접.
- **시드 스크립트**(`script/Seed.s.sol`): 테스트 P-256 서명으로 Forwarder.execute 호출하도록 갱신
  (또는 어테스터/직접). 데이터 마이그레이션 없음(재배포 리셋).
- **인덱서 이벤트**: EventCreated/Claimed/CheckedIn/OfferCreated/OfferAccepted/Transfer 등 **전부
  불변**(로그는 그대로 방출) → **Envio 스키마 무변경**, config 만 신주소로 재생.

---

## 3. Q3 — ERC-4337 폐기

### 삭제 대상 (창업자 원칙: 안 쓰는 경로·호환 레이어 삭제)
- **컨트랙트:** `MontiPaymaster.sol` 삭제, `Deploy*.s.sol` 에서 paymaster 배포/자금/ArgKind
  allowlist 제거. EntryPoint 참조 제거.
- **웹:** `apps/web/src/shared/chain/{sendSponsoredOp.ts, ops.ts, bundler.ts, unsponsored.ts}` +
  paymaster 인코딩(`encodePaymasterAndData`)·`UserOperationV06`·`MIN_VERIFICATION_GAS` 삭제.
  `opReverted.ts`/`OpReverted` 는 콜러블 revert 매핑으로 대체(디코딩 유틸만 재사용 가능).
- **env:** `VITE_BUNDLER_URL`, 번들러/paymaster 키, MontiPaymaster 주소 — 웹/Functions/Vercel
  에서 제거. **삭제 전 GET 으로 실재 확인 후 제거**(오늘밤 교훈, §8).
- **인프라:** Alchemy 번들러 의존 종료. paymaster 예치금/스테이크 **컷오버 시 인출**(운영 EOA 로).

### 스마트계정 사전배포 — **하지 않는다(skip pre-deploy)**
근거(증거 기반):
- 티켓은 **counterfactual 주소로 민팅**된다(ERC-721 `_mint`는 코드 불요). 소유는 주소만으로 성립.
- Identity 는 **기기 키를 주소에 바인딩**(register 는 주소·pubkey 저장, 코드 불요).
- 양도(acceptOffer)·migrate 는 이제 **Forwarder 경유**라 `_msgSender()==from`; 계정이 tx 를 직접
  **실행할 일이 없다**. `_update`/rotate/migrate 어느 경로도 계정 코드를 요구하지 않음(§2 확인).
- 4337 을 지우면 계정이 UserOp 를 실행할 유일한 이유가 사라진다 → **배포 자체가 불필요**.
- **효과:** 가입당 배포 tx(어테스터 자금) 제거 → **0.03~0.05 MON/가입 + 어테스터 tx 1건 절감**,
  가입 지연·실패 표면 감소, 번들러 의존 제거.
- **유지:** 계정 **주소 파생**(Coinbase Smart Wallet counterfactual, 소유자 passkey 기준)은 그대로.
  주소는 안정적으로 재현되면 되고 배포만 안 한다. (더 깊은 단순화: 4337 이 없으니 passkey-소유자
  개념을 없애고 기기 키에서 주소를 파생하는 방안도 가능 — 재배포로 어차피 리셋되므로 검토 가치는
  있으나 **범위·위험 상 이번엔 최소 변경(주소 파생 유지)** 권고, §8 후속.)

### 인덱서·withdrawal
- 인덱서 이벤트 무변경(§2). config 재생 + Envio 무료 플랜이라 **옛 배포 삭제 후 신규 릴리스**.
- paymaster 예치/스테이크 인출은 컷오버 체크리스트 항목(§8).

---

## 4. Q4 — 릴레이어 서비스 일반화

### 결정: 제네릭 콜러블 `relayAction` 1개 (+ Phase 1 relayClaim/relayCheckIn 유지)
함수마다 타입 콜러블을 만들면 옵션 A 의 N-경로 문제가 백엔드에 재현된다. Forwarder 가 제네릭
이니 콜러블도 제네릭이 대칭적이고 단순하다.
```ts
// functions/src/functions/relay.ts (추가)
interface RelayActionRequest {
  target: 'ticket' | 'organizers' | 'identity';   // 서버 allowlist(온체인 대상 미러)
  to: Hex; from: Hex;                              // from == 세션 계정이어야 함
  data: Hex;                                       // 대상 calldata(from 미포함)
  nonce: string; deadline: string;                // forwarderNonce(from) 재대조
  deviceSig: Hex;                                  // r‖s 64B
  kind: string;                                    // 회계/문서용 라벨(예: 'createEvent')
}
interface RelayActionResult { relayId: string; status: 'sent'|'confirmed'; txHash?: string }
```
콜러블 로직(Phase 1 패턴 재사용):
1. `resolveCallerAccount(request)` 로 세션 계정 확인 → **`from` 과 일치해야 함**(자기 것만 대행).
2. **서버 allowlist**: `target/to` ∈ {ticket, organizers, identity}, `data` 앞 4바이트 selector 가
   **허용 selector 집합**(§2 표의 23개) 에 있어야 함 — 임의 calldata 대납 차단.
3. `nonce` 를 체인 `forwarderNonce(from)` 와 재대조(진부/중복 조기 거절).
4. **가스 쓰기 전 `eth_call` 시뮬**: `forwarder.execute(req, deviceSig)` → revert 면 **전송 않고**
   사유 매핑 반환(Unauthorized/BadNonce/AuthExpired/TargetNotAllowed/DeviceLocked/… + 대상 함수
   고유 revert). Monad 는 revert 도 한도 과금 → 시뮬 필수.
5. `sendRelayed`(현행 `lib/relayer.ts`, +margin, 리스 안 nonce+sign+broadcast) 로 전송.
6. `relays/{relayId}` 문서(`kind` 포함) → 클라 구독. 멱등키 `(from, nonce)`.
7. **레이트리밋**: uid 별 + **orgId 별**(주최자 폭주 방지) + `MAX_PENDING`(현행 5) + App Check.

### 오프체인 조직별 회계 (온체인 budget 슬롯 대체)
MontiPaymaster 의 온체인 예산 슬롯을 지운 자리에, **집계 전용** 원장을 둔다(집행 없음):
```
usage/{orgId}: { monSpentWei: string(FieldValue.increment), actionCount, lastAt, byKind: {createEvent: n, ...} }
```
각 relay 확정 시 `gasLimit×effectiveGwei`(또는 receipt 의 gasUsed×price)를 누적. 미래 BM(정산·과금)
의 데이터 기반이 되나 **지금은 강제·차단 안 함**(창업자: 지금은 무료·최소 유지). 관객 개인 동작은
`usage/persons/{account}` 로 분리 집계(선택).

### 릴레이어 = 모든 가스의 단일 지불처 — 자금·알림
- Phase 1 이미 릴레이어 EOA(어테스터와 분리)를 발급/입장에 씀. Phase 2 는 여기에 주최자/양도
  가스를 더한다. 여전히 저빈도 증분(100명 행사 조직 오버헤드 ≈ 0.14 MON, §6).
- **충전 ~10~15 MON, 잔액 <3 MON 경보**(현행 `relayerBalance` 스케줄러 재사용, 임계만 상향 검토).
- in-flight 예약 = `gasLimit×maxFee`(동작당 ≈ 0.02~0.06 MON) — paymaster 예치(op당 ~0.42) 대비
  여전히 압도적 효율. 단일 EOA nonce 레인은 저빈도 주최자 동작엔 충분(발급/입장과 같은 리스 공유,
  버스트는 큐잉).
- **키 침해 반경**은 Phase 1 과 동일: 서명된 요청 제출 + 자기 가스 소모뿐(§7).

---

## 5. Q5 — 클라이언트 변경 (화면별)

공통: **op 핸들 소스만 `relays/{id}` 구독으로 교체**, OpProgress/상태머신·45초 캡·자동재전송(맹목
금지)·web3 금지어 규칙(Phase 1 09-27 규약)을 **그대로 이식**. 공통 헬퍼 `buildForwardRequest(to,
data, deviceKey)` 신설: `forwarderNonce(from)` 읽기 → ForwardRequest 구성(deadline=now+10분) →
`signWithDeviceKey`(무변경) → `relayAction` 호출.

- **주최자 씬(organizer/scene, usePublish/useEventDraft/Created/TicketSection).** createEvent/
  publish/update/cancel 를 `ticketOp` → `buildForwardRequest`+`relayAction`. `sendSponsoredOp`/
  `ops.ts` import 제거. 만들기 45초 캡·재폴링 UX 유지.
- **승인 UI(organizer/requests/Requests.tsx).** approveClaims/rejectClaims(배치 배열 그대로 data
  에 인코딩) → relayAction. 배치 1건이 여러 신청을 승인하므로 relay 1건.
- **게이트/팀(organizer/gates/Gates.tsx, Team.tsx).** register/open/close/revokeGate·setAdmin/
  setManager → relayAction(target='organizers').
- **양도(attendee/transfer/**, tickets/Inbox.tsx).** createOffer/cancelOffer/acceptOffer/
  safeTransferFrom → relayAction. acceptOffer 의 `attesterSig` 는 data 에 포함(수신자 KYC 게이트
  유지). recipientCommitment/offerDigest 로직 무변경.
- **신청취소/닉네임/기기(attendee/claim/ClaimFlow.tsx, me/Nickname.tsx, me/NewDevice.tsx).**
  cancelRequest/setNickname/cancelRotation/migrate → relayAction.
- **스태프 오버라이드(staff/override/**).** requestOverride/manualOverride → relayAction. 게이트
  체크인은 Phase 1 relayCheckIn 그대로.
- **카피.** 릴레이 비가시("확인 중"/"완료"). 콜러블 revert 코드 → 기존 deny/limit 카피 재사용.
- **안드로이드(MONTI-staff).** 오버라이드 제출을 relayAction 으로. 게이트 키 Keystore/StrongBox·
  체크인(relayCheckIn) 무변경. 번들러/paymaster 연결 제거. Capacitor 재빌드.

---

## 6. Q6 — 비용 모델 (Phase 2 후)

**정직한 판단(중요, 오케스트레이터 정정 2026-09-29 16:00).** §12 슬림 저장은 **이미 09-29 재배포에
반영되어 라이브**다(Batch A: 압축 발급 슬롯 + usedAt 8장/슬롯). 라이브 실측 발급 0.0268 · 입장 0.0175 MON
은 그 슬림 저장 **위에서** 나온 값이며, 설계 §12 의 추정치(0.0138/0.0090)가 낮았던 이유는 로컬 실행
gas 만 세고 트랜잭션 입장료 21k·calldata·타 컨트랙트 콜드 읽기·견적 여유를 빠뜨렸기 때문이다(F2
보고서). 따라서 **"§12 를 함께 태우면 2.6"이라는 시나리오는 존재하지 않는다.** 발급·입장만으로
100명 = 4.43 MON 이 현재 구조의 바닥이고, 주최자 동작을 릴레이로 옮기면 **≈ 4.5~4.6 MON(₩180~185)**
이 정직한 Phase 2 결과다. 4.1 은 이 구조로는 도달하지 않는다(부족분 ≈0.4 MON 은 발급의 ERC-721
표준 슬롯 2개와 입장의 콜드 읽기에서 나오며, 표준을 깨지 않고는 못 줄인다). Phase 2 의 가치는
비용 0.4 MON 절감보다 **4337·페이마스터·번들러·사전배포 제거로 부품과 장애 지점이 줄어드는 것**이다.

### 건당(릴레이 일반 tx, 한도 기준 102 gwei)
| 동작 | 경로 | MON/건(근거) |
|---|---|---|
| checkInFor | 릴레이(Phase1, §12 슬림 저장 적용됨) | 0.0175(라이브) |
| claimFor | 릴레이(Phase1, §12 슬림 저장 적용됨) | 0.0268(라이브, 행사당 첫 발급) |
| createEvent | 릴레이(Forwarder) | ≈0.05~0.07 (4337 0.156 의 PVG≈70% 제거 + 홉~15k) |
| publishEvent | 릴레이(Forwarder) | ≈0.03~0.04 (4337 0.118 기준) |
| registerGate | 릴레이(Forwarder) | ≈0.02~0.03 |
| openGate | 릴레이(Forwarder) | ≈0.012~0.02 |
| approveClaims | 릴레이(Forwarder) | ≈0.02 + ~0.01/건(배치); 4337 스폰서 0.087/건 대비 대폭↓ |

> Forwarder 경로 건당 값은 **추정**(4337 실측에서 PVG 비중을 제거한 역산 + 홉 오버헤드).
> 착수 시 `ClaimGas`/신규 `ForwardGas` 테스트로 실측 확정 필요(§8).

### 100명 행사 (만들기+공개+게이트등록+열기 + 100발급 + 100입장, 무료 모드)
| 시나리오 | 주최자 오버헤드 | 발급×100 | 입장×100 | 합계 |
|---|---|---|---|---|
| 현행 Phase 1(주최자 4337) | 0.156+0.118+0.12+0.10 ≈ 0.49 | 2.68 | 1.75 | **≈ 4.9** |
| **Phase 2(주최자·승인 릴레이, 4337 폐기)** | ≈ 0.12~0.16 | 2.68 | 1.75 | **≈ 4.5~4.6** |
| 승인 모드(request 100 + approveClaims 배치) | ≈ 0.12~0.16 + ≈1.0(100건 승인) | 2.23(request) | 1.75 | **≈ 5.1~5.2** (현행 승인 모드 ≈ 8~13 대비 대폭↓) |

- **Phase 2 결과 ≈ 4.5~4.6 MON/100명 (₩180~185, MON ₩40 기준)**. 4.1 은 불가 — 창업자에게 명시.
- 승인 모드 행사는 승인 op 이 스폰서드(0.04~0.09/장)에서 릴레이(≈0.01/장)로 바뀌어 가장 크게 준다.
- 실질 이득은 비용보다 **단순화**: 페이마스터 예치·스테이크 관리, 번들러 의존, PVG 부풀림, 사전배포
  0.03~0.05 MON/가입, in-flight 예약금 문제가 모두 사라진다.

---

## 7. Q7 — 보안 리뷰

- **재생/nonce/deadline.** Forwarder from 별 순번 소비 + deadline. 동일 서명 재제출=BadNonce.
  cross-chain=chainId, cross-forwarder=forwarder 주소, cross-action=keccak(data)+nonce 로 봉인.
- **대상 allowlist.** 온체인 `to ∈ {ticket,organizers,identity}` + 서버 selector allowlist 이중.
  Forwarder 로 임의 컨트랙트 호출 불가(ERC-2771 미인지 대상에 20B 덧붙는 혼동 차단).
- **calldata 바인딩.** 다이제스트에 `keccak256(data)` → 릴레이어가 data 한 바이트도 못 바꿈.
- **ERC-2771 함정(핵심).** ① `_msgSender`/`_msgData` 는 **`msg.sender==trustedForwarder` 일
  때만** suffix 를 신뢰 — forwarder 주소를 각 대상에 **immutable** 로 고정해 위조 불가. ② 민감
  경로는 **raw `msg.sender` 유지**(Organizers.setTicket=deployer, Identity onlyAttester/attester
  분기) → Forwarder 로 우회 불가. ③ `_contextSuffixLength`/다중상속 순서(Context→ERC2771Context)
  정확히 override(OZ 표준). ④ `_msgData()` 를 쓰는 로직은 suffix 스트립본을 봐야 함(현행 코드가
  msg.data 를 직접 파싱하지 않는지 착수 시 확인 — 미확인, §8).
- **기기 잠금/회전/복구.** execute 가 isMember(from)+!isLocked(from)+activeDevice(from) 확인.
  잠긴/버려진 계정은 Forwarder 불가. 복구(rotateAccount/lockDevice)는 어테스터 권위(무변경).
  setActiveDevice 는 **현재 기기 보유 시** Forwarder 로 교체, 분실 시 어테스터 경로.
- **릴레이어 침해 반경.** 서명된 요청 제출 + 자기 EOA 가스 소모뿐. 필드 변조·자기 민팅·임의
  권한 행사·어테스터/deployer 함수 접근 **전부 불가**(기기 키 없음, _msgSender 는 서명된 from
  만 반영). 완화: 잔액 상한·<3 MON 경보·데모 후 키 로테이트.
- **permissionless Forwarder vs 릴레이어 전용.** permissionless 유지(Phase1 claimFor 와 동일 철학).
  제3자가 서명된 요청을 먼저 내도 "사용자가 원한 동작 + 제3자가 가스 부담" → 무해/이득. nonce
  경합은 한쪽 성공·한쪽 BadNonce, 릴레이어는 시뮬-우선으로 revert 가스 회피. 조직 동작엔 경제적
  MEV 유인 없음(양도는 recipientCommitment+attesterSig 로 수신자 고정).
- **DoS/레이트리밋.** uid+orgId 레이트리밋, MAX_PENDING, App Check, 시뮬-우선(미전송=온체인 0).
- **릴레이어 다운 시.** 온체인은 아무것도 안 깨짐. 사용자는 "확인 중" 재시도. permissionless 라
  임시로 다른 EOA 제출도 가능(운영 회복력).

---

## 8. Q8 — 마이그레이션 / 롤아웃

데이터 마이그레이션 없음(재배포 = 계정·행사 리셋, 데모 전이라 창업자 룰상 허용). 순서(Phase1 미러):

1. **컨트랙트(mvp-01b):** `MontiForwarder.sol` 신규; Ticket/Organizers/Identity 에 ERC2771Context
   + `_msgSender()` 치환(§2); **MontiPaymaster 삭제 + Deploy 스크립트 정리**; **§12 슬림 저장 동시
   반영(권고)**; 배포 순서 = Identity → Forwarder(identity) → Organizers(forwarder) →
   Ticket(organizers,forwarder) → Forwarder.setTargets(ticket,organizers) [deployer 1회] →
   Organizers.setTicket. 테스트: Forwarder 유효/BadNonce/AuthExpired/TargetNotAllowed/DeviceLocked/
   위조서명, 각 이관 함수의 `_msgSender` 경로, ContractSize 한도, `ForwardGas`/`ClaimGas` 실측.
   재배포 → 신주소 `deployments/*.json` + `previous[]` append, `export-abi.sh`.
2. **shared/ABI(병렬):** `forwardRequestPreimage/Digest` + `FORWARD_REQUEST_TAG` 인코딩, Forwarder
   ABI 추가, MontiPaymaster ABI 삭제, 신주소 동기화. 교차검증 테스트(shared==컨트랙트 다이제스트).
3. **백엔드(mvp-backend):** `relayAction` 콜러블 + selector allowlist + `usage/{orgId}` 원장 +
   Firestore 규칙/인덱스; paymaster 참조 제거; Functions 재배포. 통합: 테스트넷 1건씩.
4. **웹 주최자 ‖ 웹 관객 양도 ‖ 스태프:** relayAction 배선, `sendSponsoredOp`/`ops.ts`/`bundler.ts`/
   `unsponsored.ts`/paymaster env 삭제, 스마트계정 사전배포 제거. Vercel env 신주소.
5. **e2e:** 발급/입장/양도/주최자 시나리오 릴레이 경로, **코스트 시나리오 ≤4.1(권고안) 실측**,
   **4337 코드 0 grep**.
6. **컷오버/문서:** 병합 mvp-01b→backend→web/staff→e2e→mvp. 인덱서 config 재생 + Envio 옛 배포
   삭제 후 재릴리스. **paymaster 예치/스테이크 인출.** abi-delta·런북 갱신.

**컷오버 체크리스트(오늘밤 교훈 반영):** 모든 env(신주소·RELAYER_PK·Functions/Vercel)를 **삭제/설정
전 GET 으로 실재 확인**. 삭제 대상(VITE_BUNDLER_URL 등)도 GET 후 제거. 혼합 상태 금지(단일 컷오버).

**미확인/착수 검증(추측 명시):**
- Ticket ContractSize 여유(ERC2771Context 추가 후 한도 통과) — **미측정**.
- Forwarder 경로 건당 gas — **추정**(4337 역산). `ForwardGas`/`ClaimGas` 로 확정.
- 현행 코드가 `msg.data`/`_msgData` 를 직접 파싱하는 곳 없는지 — 착수 시 grep 확인.
- `createOrganizer`/`transferOwner` 인가 경로(셀프서비스 vs 어테스터) — 착수 시 확정.
- Monad P-256 precompile(0x100)은 Phase 1 에서 실측 확인됨(설계 §11-1, 2026-09-28) — 유효 전제.

## 롤백 노트
데이터 마이그레이션 없음 → 롤백 = `deployments/*.json` 을 `previous[]` 직전 항목으로 복원 →
shared/Functions/Vercel env 되돌림 → 웹 재배포 → 인덱서 config 재생 + Envio 옛 배포 삭제 후 이전
주소 재릴리스. 컨트랙트 시그니처가 바뀌므로 **부분 롤백 불가**(단일 컷오버). 릴레이어 문제만이면
컨트랙트 롤백 없이 EOA 재충전/키 로테이트(permissionless 라 임시 타 EOA 제출 가능).
