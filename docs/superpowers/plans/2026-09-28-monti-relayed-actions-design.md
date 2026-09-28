# MONTI 관객 동작 릴레이 전환 — 설계 (2026-09-28)

상태: 설계 확정안(코드 변경 없음). 창업자 결정(최종·재론 안 함): 관객의 두 고빈도 동작
**티켓 받기(claim)** 와 **입장 체크인(check-in)** 을 ERC-4337 스폰서드 op에서 떼어내,
**릴레이된 일반 트랜잭션**으로 옮긴다. 관객 폰이 기기 키로 짧은 승인서에 서명하고,
MONTI 클라우드 함수가 호출자를 확인한 뒤 MONTI 운영 EOA(릴레이어)로 **동작당 일반
트랜잭션 1건을 배치 없이 즉시** 보낸다. 게이트는 지금처럼 "먼저 통과" 판정을 로컬에서
내리고, 체인 기록은 ~1초 안에 따라온다. 주최자 동작(createEvent/publish/gate/approveClaims)은
당분간 4337 + MontiPaymaster 유지.

관련 근거 파일:
`MONTI-01b/contracts/src/Ticket.sol`(claim/requestClaim/checkIn/_admit/deviceDigest),
`MONTI-01b/contracts/src/Identity.sol`(activeDevice/isLocked/isMember),
`MONTI-01b/contracts/src/Organizers.sol`(gateInfo/isOpenGate — **무변경**),
`MONTI-01b/contracts/test/CheckInGas.t.sol`(체크인 실측 123,753 gas),
`MONTI-backend/functions/src/functions/registerIdentity.ts`·`device.ts`·`lib/attesterLock.ts`·`lib/chain.ts`·`lib/auth.ts`(어테스터 패턴 재사용 원본),
`MONTI-web/packages/shared/src/encoding.ts`(gateCodeHash·deviceDigest 원문),
`MONTI-web/apps/web/src/attendee/enter/buildResponse.ts`·`staff/gate/{gateCode,gateKey,checkInOp}.ts`·`enter/verifyGate.ts`.

---

## 0. 창업자용 한국어 요약 (비개발자, ≤20줄)

- **무엇을 바꾸나.** 관객이 "티켓 받기"와 "입장"을 할 때, 지금은 값비싼 특수 트랜잭션
  (스폰서드 op)을 씁니다. 이걸 **평범한 일반 송금 트랜잭션**으로 바꿉니다. 관객 폰은
  지금처럼 자기 기기 키로 서명만 하고, 실제 전송은 **MONTI 서버가 가진 지갑 한 개
  (릴레이어)** 가 대신 냅니다. 한 동작에 한 건씩, 묶지 않고 바로 보냅니다.
- **왜 싸지나.** Monad는 트랜잭션을 "쓴 만큼"이 아니라 "한도(limit)"로 청구합니다.
  스폰서드 op은 그 한도가 규칙상 크게 부풀어(claim 1건이 145만 gas ≈ 0.15 MON) 청구됩니다.
  일반 트랜잭션은 한도가 **실제 사용량(체크인 약 12만, 받기 약 20만 gas)** 근처라
  **동작당 약 0.017~0.022 MON**으로 떨어집니다. **약 7~9배 저렴**해집니다.
- **비용 (100명 행사: 만들기 + 100 받기 + 100 입장).**
  - 지금(전부 4337): 약 **30 MON**.
  - 바꾼 뒤: 약 **4.4 MON** (범위 4.2~4.7). **목표 5 MON 이하 달성**, 여유 약 0.6 MON.
- **무엇을 그대로 두나.** 관객 폰이 서명하는 방식·화면 흐름·"먼저 통과" 게이트 판정,
  주최자의 행사 만들기/공개/승인, 오프라인 큐, 오프라인 스냅샷, 인덱서(같은 이벤트를
  그대로 냄 → 주소만 갱신). 관객 화면엔 web3 단어가 계속 안 보입니다.
- **가장 큰 위험 3가지.** ① Monad 테스트넷에 P-256 서명 검증 가속기(precompile)가 실제로
  살아 있어야 합니다 — 없으면 동작당 gas가 33만 늘어 목표가 깨집니다(기기 테스트가 아직
  안 돼 **실측 확인이 1순위**). ② 릴레이어가 가스 한도를 넉넉히 잡으면(한도로 청구되므로)
  비용이 다시 오릅니다 — **한도를 타이트하게** 잡아야 합니다. ③ 릴레이어 지갑이 털리면
  가스를 낭비당할 수 있으나(서명된 승인서만 대신 보낼 뿐 티켓 위조·신원 변경은 불가),
  잔액을 10 MON 선으로 제한하고 알림을 겁니다.
- **일정 감각.** 컨트랙트(재배포 필수) → 백엔드 함수 2개 → 웹/안드로이드 제출 경로 →
  e2e로 5 MON 실측. 총 개발 규모 **약 8~11일**(에이전트 작업 기준, 아래 계획 참조).

---

## 1. 핵심 통찰 — 왜 "릴레이된 일반 tx"가 싼가

비용 문서 v2(`2026-09-28-monti-sponsored-op-cost-v2.md`)가 확정한 사실:

- Monad는 번들을 **gas LIMIT**으로 청구한다(66건 전부 한도=사용량).
- 4337 번들러는 `PVG ≈ CGL + 3×VGL + 65k`로 예약분을 PVG에 밀어넣는다. 그래서 실사용이
  36만인 claim이 **145만 gas(≈0.15 MON)** 로 청구된다. PVG가 비용의 65~78%.

일반 트랜잭션에는 EntryPoint·PVG·VGL·paymaster postOp가 **없다**. 청구 한도 = `intrinsic(21k)
+ calldata + 실행 gas`이고, 릴레이어가 그 한도를 실제 사용량 + 7.5% 마진으로 타이트하게
잡으면 **한도 자체가 작다.** 이것이 절감의 전부다 — 컨트랙트 로직을 줄여서가 아니라
"부풀린 한도"를 없애서 싸진다.

실측 앵커(로컬 osaka EVM, 실제 P-256 precompile 0x100, `CheckInGas.t.sol`):
- **checkIn 실행 = 123,753 gas** (P-256 검증 포함, 상한 200k 강제 통과).
- 즉 일반 tx 체크인 총 gas ≈ 21k + calldata + 123.8k(+게이트서명검증 ~7k) ≈ **~155k**.
  한도(×1.075) ≈ **167k** → **0.017 MON/건**. 4337 대비 약 9배 절감.

> **P-256 precompile 의존성(1순위 검증).** `CheckInGas.t.sol` 주석: `evm_version="osaka"`가
> 로컬 EVM에 진짜 EIP-7951 P-256 precompile(0x100, ~6,900 gas)을 준다. solady
> `P256.verifySignature`가 이를 staticcall한다. **단, ForkTest도 로컬 EVM을 쓰므로 Monad
> 노드가 0x100을 실제로 실행하는지는 증명하지 못한다.** 비용 문서상 기기 테스트 미시작 →
> claim/check-in의 온체인 P-256이 Monad 테스트넷에서 실행된 적이 없을 수 있다. **없으면
> solady가 순수 Solidity 폴백(~330k gas/검증)으로 떨어져 동작당 +0.034 MON → 200동작에
> +6.8 MON → 목표 붕괴.** 착수 전 라이브 RPC로 실제 checkIn 1건(또는 P256.verifySignature
> staticcall)을 반드시 확인. (정황상 지원 가능성 높음: 스펙 8.3이 이를 전제, 기기 P-256 키가
> 설계 근간. 그러나 추측이므로 실측 필수.)

---

## 2. Q1 — 승인서(authorization) 형식: 관객이 서명하는 것

### 결정
릴레이 claim의 승인서 `ClaimAuth`에 대해, **관객 기기 키(P-256)가 다음 32바이트
다이제스트에 raw 서명**한다(체크인과 동일한 서명 코드 경로 `signWithDeviceKey`, 칩이 재해싱
안 함):

```
CLAIM_AUTH_TAG = keccak256("MONTI:CLAIM_AUTH:v1")   // bytes32 상수(도메인/목적 태그)

claimAuthDigest = sha256(abi.encode(
    bytes32  CLAIM_AUTH_TAG,   // 목적 태그 — 체크인 다이제스트와 절대 혼동 불가
    uint256  block.chainid,
    address  address(this),    // 이 Ticket
    uint256  eventId,
    uint8    tier,
    address  account,          // 티켓을 받을 스마트 계정(수신자)
    uint256  nonce,            // 계정별 claim nonce == claimNonce[account]
    uint64   deadline))        // block.timestamp <= deadline
```

### 근거
- **도메인 분리(혼동 불가).** 체인에는 이미 sha256(abi.encode(...)) 다이제스트가 둘 있다:
  - 게이트 코드: `sha256(abi.encode(gateId, eventId, issuedAt, nonce))` — **게이트 키**가 서명.
  - 체크인 관객 승인: `sha256(abi.encode(chainId, ticket, tokenId, gateId, eventId, nonce, issuedAt))`
    — **관객 기기 키**가 서명(`encoding.ts` v2, `Ticket._admit`가 재계산).

  claim 다이제스트는 **선두에 CLAIM_AUTH_TAG(32B keccak 상수)** + 필드 개수·타입이 위 둘과
  전부 다르다. sha256에서 서로 다른 프리이미지 → 충돌 불가. 게다가 체크인 다이제스트의 첫
  워드는 chainid(작은 정수)라 32B 태그와 자리부터 어긋난다. 따라서 **한 서명을 다른 경로로
  재사용하는 것이 구조적으로 불가능**하다(태그는 자명성·명시성을 위한 벨트+멜빵).
- **체인 검증.** `Ticket.claimFor`가 `a.account`의 활성 기기 키를 Identity에서 풀어 검증한다:
  `(bytes32 x, bytes32 y) = identity.activeDevice(a.account)`; `P256.verifySignature(digest,
  r, s, x, y)`. 이는 `_admit`가 `holder`의 기기 키를 푸는 방식과 동일(`Ticket.sol:581-588`).
- **DeviceLocked는 반드시 차단.** `_admit`가 `identity.isLocked(holder)`를 막듯,
  `claimFor`도 `identity.isLocked(a.account)`면 `DeviceLocked`로 revert한다. 잠금은 "이 기기
  키를 더는 신뢰하지 않는다"는 뜻(분실/회전/도난)이므로, 잠긴 계정의 기기 서명을 받아들이면
  잠금의 의미가 무너진다. `isMember(a.account)`도 확인(회전으로 버려진 계정 차단).
- **재생 방지 = 계정별 nonce(Identity 아님, Ticket).** `mapping(address => uint256) public
  claimNonce` **를 Ticket에 둔다.** claim은 Ticket 동작이고, Identity는 신원/기기 키 레지스트리로
  좁게 유지한다(관심사 분리). `claimFor`는 `a.nonce == claimNonce[a.account]` 확인 후
  `claimNonce[a.account]++`(민팅 전, checks-effects-interactions). 이는 EIP-2612 permit의
  검증된 패턴이며, 계정당 claim을 직렬화한다. 대안 "사용된 다이제스트 해시맵"은 매번 fresh
  slot(20k) SSTORE로 무한 성장 → 기각. `deadline`은 미제출 승인서의 수명을 제한(약 10분).
- **기기 회전/복구 상호작용(`recoverAccess`).**
  - 같은 계정 기기 교체(`setActiveDevice`, 잠금 해제): claimNonce 불변, 새 키가 다음 nonce에
    서명. 옛 승인서는 무효(키 불일치 + 서명 당시 잠김이었음).
  - 계정 회전(`rotateAccount`): 새 계정 주소 → `claimNonce[new]`는 0에서 시작. 옛 계정은
    `isMember=false` + 기기 잠김 → `claimFor(old)`는 NotMember/DeviceLocked로 revert. 일관.

---

## 3. Q2 — 컨트랙트 API (Ticket.sol 국한, Organizers/Identity 무변경)

### 구조체·상수·저장소 (추가)
```solidity
struct ClaimAuth {
    uint256 eventId;
    uint8   tier;
    address account;   // 수신자(관객 스마트 계정)
    uint256 nonce;     // == claimNonce[account]
    uint64  deadline;
}
bytes32 private constant CLAIM_AUTH_TAG = keccak256("MONTI:CLAIM_AUTH:v1");
mapping(address => uint256) public claimNonce;   // 자동 getter = 클라이언트가 읽는 nonce
```

### 함수 (추가)
```solidity
// 공개 뷰(offerDigest/deviceDigest와 같은 이유: 클라이언트·테스트 교차검증)
function claimAuthDigest(ClaimAuth calldata a) public view returns (bytes32) {
    return sha256(abi.encode(
        CLAIM_AUTH_TAG, block.chainid, address(this),
        a.eventId, a.tier, a.account, a.nonce, a.deadline));
}

function claimFor(ClaimAuth calldata a, bytes calldata deviceSig)
    external returns (uint256 tokenId);      // Claimed 이벤트(직접 claim과 동일)

function requestClaimFor(ClaimAuth calldata a, bytes calldata deviceSig)
    external returns (uint256 requestId);    // ClaimRequested 이벤트(승인제)
```

내부 공통화(두 경로가 갈라지지 않게, `_admit` 패턴 답습):
```solidity
function _verifyClaimAuth(ClaimAuth calldata a, bytes calldata deviceSig) private {
    if (block.timestamp > a.deadline) revert AuthExpired();
    if (a.nonce != claimNonce[a.account]) revert BadNonce();
    if (!identity.isMember(a.account)) revert NotMember();
    if (identity.isLocked(a.account)) revert DeviceLocked();
    (bytes32 x, bytes32 y) = identity.activeDevice(a.account);
    if (deviceSig.length != 64) revert BadDeviceSignature();
    (bytes32 r, bytes32 s) = abi.decode(deviceSig, (bytes32, bytes32));
    if (!P256.verifySignature(claimAuthDigest(a), r, s, x, y)) revert BadDeviceSignature();
    claimNonce[a.account]++;   // 소비(민팅 전)
}
// claimFor: _verifyClaimAuth(a, sig); return _claimTo(a.eventId, a.tier, a.account);
// requestClaimFor: _verifyClaimAuth(a, sig); return _requestClaimFrom(a.eventId, a.tier, a.account);
// _claimTo / _requestClaimFrom: 기존 claim/requestClaim 본문에서 msg.sender→to 로 추출
```

추가 에러: `AuthExpired()`, `BadNonce()`, `BadGateSignature()`(체크인용, Q3). `BadDeviceSignature`·
`NotMember`·`DeviceLocked`는 기존 재사용.

### 직접 `claim()`·`requestClaim()` 제거
**제거한다**(창업자 원칙: 쓰이지 않는 경로 삭제·하위호환 레이어 금지). 전환 후 관객 claim은
전부 `claimFor` 경로다. 직접 claim(msg.sender=계정, 4337)을 남기면 인증 방식이 다른 두 claim
경로가 공존해 표면·유지비가 는다. 비용: `TicketClaim.t.sol`·`CheckInGas.t.sol`(픽스처가
`ticket.claim(...)` 호출)·`Seed.s.sol` 등이 claimFor로 이전 필요(테스트 헬퍼가 vm.signP256 +
P256Vectors로 ClaimAuth 서명 생성 — Foundry는 secp256r1 `vm.signP256` 지원).

### 허가 없는(permissionless) 제출 vs 릴레이어 allowlist
**permissionless로 둔다**(allowlist 없음). 근거:
- 승인서가 **완결적**이다: eventId·tier·account·nonce·deadline·chainId·컨트랙트를 묶고 기기
  키로 서명. `claimFor`는 msg.sender를 인가에 전혀 쓰지 않는다(체크인과 다른 점 — Q3).
- **그리핑/프론트러닝 무해.** 승인서는 백엔드에만 있고(관객→콜러블) 제출 전까지 온체인에
  안 뜬다. 제3자가 그것을 손에 넣어 먼저 제출해도 결과는 "관객이 원한 그 티켓이 관객
  계정으로 민팅"이고 가스는 제3자가 냈다(오히려 이득). nonce 경합은 한쪽만 성공하고
  다른 쪽은 `BadNonce` revert — 릴레이어가 지는 쪽이면 revert 가스를 소모하나, **제출 직전
  eth_call 시뮬레이션 + (account,nonce) 멱등**으로 회피. 경제적 가치(무료 티켓)가 없어 MEV
  유인도 없다.
- allowlist는 컨트랙트 상태·릴레이어 운영을 늘린다(원칙3 위배). permissionless는 릴레이어
  키 분실 시 어느 EOA로도 제출 가능한 운영 회복력도 준다.

### gas 추정(건당)
- `claimFor`: claim 실행(~155k, 콜드 SSTORE 다수: _eventOf/_tierOf/owner/balance/balanceOfEvent)
  + P-256(~6.9k) + nonce SSTORE(첫 claim 계정 20k / 이후 5k) + Identity 크로스콜 SLOAD(~10k)
  ≈ **실행 ~185k**; 일반 tx 총 ≈ 21k + calldata~3k + 185k ≈ **~200k** → 한도 ~215k.
- `requestClaimFor`: _safeMint 없이 공급 예약만 → **~150k 실행**; 총 ~165k → 한도 ~178k.

---

## 4. Q3 — 릴레이된 체크인

### 결정: 옵션 (a) — 게이트가 코드에 서명, 온체인에서 검증, 누구나 제출
```solidity
function checkInFor(uint256 tokenId, GateCode calldata g, bytes calldata gateSig, bytes calldata deviceSig) external;
function checkInForLate(uint256 tokenId, GateCode calldata g, bytes calldata gateSig, bytes calldata deviceSig) external;
```
`_admit`에서 **`msg.sender==게이트` 검사(`isOpenGate(eventId,msg.sender)` +
`gateOf(msg.sender)==g.gateId`)를 게이트 서명 검증으로 교체**한다:
```solidity
(uint256 gEventId, , bytes32 kx, bytes32 ky, bool open, bool revoked) = organizers.gateInfo(g.gateId);
if (gEventId != eventId || revoked) revert GateNotOpen();     // late: revoked만 금지, open 불요
if (!late && !open) revert GateNotOpen();
// 게이트 코드 다이제스트 = 스태프가 이미 서명하는 그 값(gateCodeHash, 무변경)
bytes32 gh = sha256(abi.encode(g.gateId, g.eventId, g.issuedAt, g.nonce));
(bytes32 gr, bytes32 gs) = abi.decode(gateSig, (bytes32, bytes32));
if (gateSig.length != 64 || !P256.verifySignature(gh, gr, gs, kx, ky)) revert BadGateSignature();
```
나머지 `_admit`(관객 deviceSig 검증·신선도·1회 입장·locked·member·이벤트 상태)는 **한 줄도
안 바뀐다.** 이벤트도 그대로: `CheckedIn` / `CheckedInLate`.

### 근거 (옵션 비교)
- **(a) 채택.** 스태프 앱은 **이미 게이트 키(kx,ky)로 게이트 코드에 서명**한다
  (`staff/gate/gateCode.ts` `signGateCode`, `gateKey.ts`), 관객 폰은 그 서명을 온체인
  (kx,ky)에 대해 로컬 검증한다(`enter/verifyGate.ts` layer③). **옵션 (a)는 그 동일 서명을
  온체인에서도 검증할 뿐**이라 게이트 서명·관객 서명 클라이언트 코드에 변경이 없다(gateSig를
  콜러블/컨트랙트에 넘기는 배선만 추가). `Organizers.gateInfo`가 이미 (kx,ky,open,revoked)를
  반환 → **Organizers.sol 무변경.**
- **(b) 게이트를 자금 있는 EOA로 + msg.sender 유지 — 기각.** 게이트마다 EOA를 충전·nonce·gas
  관리해야 하고 안드로이드가 개인키를 들고 tx를 직접 보낸다. "MONTI 릴레이어 1개가 낸다"는
  예산과 최소 운영 원칙에 어긋남.
- **(c) Organizers에 릴레이어 allowlist — 기각.** msg.sender=릴레이어면 게이트를 msg.sender로
  식별할 수 없어 결국 게이트 서명이 필요 → (a)로 수렴. allowlist만 두고 릴레이어를 믿으면
  릴레이어 침해 시 임의 입장 가능(보안 후퇴).
- **이전 결정 뒤집기(명시).** 09-27 재배포 계획 D1은 "checkInLate 별도 함수, **게이트
  공동서명 없음**"을 택했다. 그 판단은 **msg.sender==게이트가 게이트 권한을 주던 전제** 위에서
  옳았다. 릴레이로 msg.sender가 릴레이어가 되는 지금, 게이트 권한을 서명으로 옮겨야 하므로
  **뒤집는다.** 게이트 서명은 온체인에서 코드의 진위를 강제해(예전엔 클라이언트만 검증)
  오히려 강해진다.

### 스태프 단말·키 저장 / 오프라인 / 폐기 / 이중입장 / 그리핑 평가
- **스태프 단말 = 안드로이드 앱(MONTI-staff), 게이트 키 = StrongBox/TEE, 생체 없음
  (`requireAuth:false`, 3초마다 서명).** 변경 없음. 게이트는 이제 스마트 계정/paymaster가
  필요 없다 — 코드에 서명(기존)하고 콜러블을 호출(신규)할 뿐.
- **오프라인 큐(`checkInForLate`).** 게이트가 오프라인에서 서명한 (GateCode,gateSig,response)를
  복구 후 스태프 폰이 릴레이어 콜러블에 POST → 릴레이어가 `checkInForLate` 제출. 게이트
  서명이 오프라인에서도 권한을 증명. 관객 기기 서명은 여전히 필수(T15).
- **폐기(revoke).** `gateInfo.revoked`를 그대로 확인 → 폐기 게이트는 온·오프라인 모두 거부.
  `revokeGate`(T14 대응) 유효.
- **이중입장(두 게이트/더블탭).** 온체인 **1회 입장(`_checkIns[tokenId].ts!=0` →
  `AlreadyCheckedIn`)** 이 경로·게이트 무관하게 막는다(불변). ~1초 창은 Q5의 대기 테이블이
  덮는다.
- **그리핑.** permissionless 제출이라도 (GateCode,gateSig,deviceSig) 완결 튜플이 필요 →
  제3자가 제출해도 "관객이 원한 입장"일 뿐. 게이트 서명 사전수확은 late `issuedAt` 하한이
  막음(기존 D1 방어 유지).

---

## 5. Q4 — 릴레이어 서비스 (Cloud Functions 콜러블)

### 릴레이어 키 = 어테스터와 **분리된 신규 EOA** (`RELAYER_PK`, Secret Manager)
근거: ① **블래스트 반경 분리** — 어테스터는 register/rotateAccount/lockDevice(민감), 릴레이어는
서명된 승인서 제출 + 가스만. ② **nonce 레인 분리** — claim/체크인 버스트가 register/lock과
경합하지 않게. ③ 어테스터 리스는 "직렬화 후 대기"라 50건/10초 버스트엔 부적합.

### 콜러블 2개 (`functions/src/functions/relay.ts`, us-east1, Node 22)

**`relayClaim`** — 관객이 티켓을 받는다.
- 입력: `{ auth: {eventId, tier, account, nonce, deadline}, deviceSig: hex, mode?: 'claim'|'request' }`.
- 인증: `resolveCallerAccount(request)`(기존 `lib/auth.ts`) → 호출자 계정. `auth.account`가
  호출자 계정과 일치해야 함(자기 것만 claim). 온체인 `isMember`·`!isLocked` 선확인.
- **가스 쓰기 전 검증(핵심 절감):** `nonce`를 체인 `claimNonce(account)`와 재대조(진부/중복
  차단). `eth_call`로 `claimFor(auth,deviceSig)`(또는 `requestClaimFor`) 시뮬레이션 → revert면
  **전송하지 않고** 사유를 매핑해 반환(SoldOut/MaxPerWalletExceeded/SaleClosed/KycRequired/
  ApprovalRequired/DeviceLocked/BadDeviceSignature/BadNonce/AuthExpired/NotMember). Monad는
  revert도 한도로 청구하므로 이 시뮬레이션이 필수.
- 멱등: `(account, nonce)` 키. 동일 키의 pending/sent/confirmed relay 문서 있으면 재사용.
- 반환: `{ relayId }`. 클라이언트가 `relays/{relayId}` 구독.

**`relayCheckIn`** — 게이트가 관객을 입장시킨다.
- 입력: `{ code: GateCodeWire(gateId,eventId,issuedAt,nonce,kx,ky,sig), response: GateResponseWire(tokenId,nonce,deviceSig), late?: boolean }`.
- 인증: 로그인된 MONTI 사용자(스태프 폰). **정확성의 권한은 온체인 게이트 서명 + 관객
  서명**이 지므로 콜러블 인증은 남용 방지용. (옵션: 해당 이벤트의 게이트 운영자로 좁히기 —
  `isEventOrganizer`/게이트 운영자 클레임 — 데모 후 강화.)
- 가스 쓰기 전: `code.nonce==response.nonce` 확인, `checkInFor(tokenId,GateCode,gateSig,deviceSig)`
  eth_call 시뮬 → revert면 기존 DENY 카피로 매핑(GateNotOpen/CodeExpired/AlreadyCheckedIn/
  DeviceLocked/BadDeviceSignature/TicketRevoked/WrongEvent/BadGateSignature) 후 미전송.
- 멱등: `tokenId` 키(1회 입장). Q5 대기 테이블과 연동.
- 반환: `{ relayId }`. 게이트는 로컬 "PASS"를 먼저 띄우고(현행 유지), relay 문서가 확정.

### nonce 관리 (단일 릴레이어 EOA, 버스트: 선착순 ~50건/10초, Monad 300~400ms 블록)
- **어테스터 리스(`attesterLock.ts`)를 릴레이어용으로 복제**(`relayerLock.ts`, LEASE_DOC=
  'relayer'), **브로드캐스트 후 즉시 반납**(`sendAttesterTx`가 해시만 반환하고 finality를
  안 기다림 — `lib/chain.ts` 확인). 임계구역 = nonce 배정+서명+브로드캐스트뿐.
- **estimateGas·eth_call 시뮬은 리스 밖에서** 수행(느린 RPC를 임계구역에서 제거 → 처리량↑).
- nonce는 리스 안에서 `getTransactionCount(relayer,'pending')`를 명시적으로 읽어
  `writeContract({nonce})`에 전달(in-flight 포함 → 연속 증가 보장). "nonce too low"는 1회
  재시도(기존 `sendSerialized` 규약).
- 처리량: 임계구역 ~50ms → ~15~20 tx/s(단일 레인). 버스트 5/s를 여유 처리. 리스는 12초
  대기열이라 몰려도 실패가 아니라 큐잉(관객은 잠깐 "확인 중"). **min-instances=1로 웜 유지.**
- **레버(필요 시):** Firestore nonce 할당기로 병렬 브로드캐스트(레인 분리) — 갭 필러 필요,
  복잡. 데모 규모(100명)엔 단일 리스로 충분. 문서화만.

### 가스 정책 (일반 tx)
- gasLimit = `estimateGas × 1.075`(`gasLimitFor`/`withGasMargin` 재사용). **Monad는 한도로
  청구하므로 마진을 15% 초과 금지.** 목표 한도: claimFor ~215k, checkInFor ~167k.
- 수수료: `maxPriorityFeePerGas=2 gwei`, `maxFeePerGas=2×baseFee(=100 gwei 고정)+tip≈202 gwei`
  (실제 과금 102 gwei; cap일 뿐). `estimateFeesPerGas()` 후 cap.

### 상태 추적 / 재시도 / 레이트리밋 / 모니터링
- **`relays/{relayId}`** Firestore 문서: `{ kind:'claim'|'checkIn', account|tokenId, nonce?,
  status:'pending'|'sent'|'confirmed'|'failed', txHash?, error?, createdAt, updatedAt }`.
  콜러블: pending 생성 → 시뮬 → 브로드캐스트(sent+txHash) → 짧은 대기(≤3s)로 receipt →
  confirmed/failed. 타임아웃분은 기존 `reconcilePending` 류 스케줄러가 수습. 클라이언트는
  onSnapshot 구독(OpProgress 재사용).
- 재시도: 전송 실패는 1회(nonce-too-low 규약). 시뮬 revert는 결정적 거절 → 재시도 없음.
- 레이트리밋: 시뮬-우선이라 남용은 가스가 아니라 RPC 쿼터를 소모 → uid별 레이트리밋 +
  Firebase App Check. claim은 nonce+maxPerWallet가 자연 한도.
- **잔액 모니터링:** 스케줄드 함수(신규 인프라 없음; `dailyExport`/`reconcilePending` 패턴)로
  릴레이어 EOA 잔액을 N분마다 확인, 임계치(<3 MON) 시 기존 채널(로그 경보/`system/alerts`
  문서)로 알림.

### 릴레이어가 **할 수 없는 것**
서명된 필드를 못 바꾼다(eventId/tier/account/tokenId/nonce/deadline를 바꾸면 P-256 검증 실패
→ revert). 기기 키가 없어 claim/체크인을 위조 못 한다. 게이트 서명·관객 서명 없이는 입장
못 시킨다. 자기에게 티켓 민팅·신원 변경·paymaster 접근 불가. **가능한 것은 오직 (1) 이미
유효한 서명 승인서 제출, (2) 자기 EOA의 MON을 가스로 소모(그리핑)** 뿐.

---

## 6. Q5 — 대기(pending) 테이블: ~1초 창

### 형태
`admissions/{eventId}/tokens/{tokenId}` : `{ status:'passing'|'confirmed'|'failed', gateId,
relayId, ts, expiresAt }`. `relayCheckIn`이 수락 즉시(브로드캐스트 시점) `passing` 기록,
확정 시 `confirmed`, revert 시 `failed`(또는 삭제).

### 규칙·상호작용
- **교차 게이트 이중입장 차단(빠른 경로).** 둘째 게이트의 preflight가
  `admissions/.../{tokenId}`=passing/confirmed를 보면 릴레이어 호출 전에 로컬 DENY. 체인의
  1회 입장이 ~1초 뒤 닫을 창을 즉시 닫는다.
- **체인이 최종 권위.** 대기 문서는 **지연 최적화(보안 경계 아님)**. 문서가 없거나 낡아도
  둘째 `checkInFor`는 `AlreadyCheckedIn`으로 revert → 이중 민팅 불가. 두 게이트 동시 경합은
  첫 온체인 체크인이 이기고 둘째는 revert→DENY(느린 정합도 체인이 보장).
- **오프라인 큐.** 오프라인 게이트는 대기 테이블을 못 읽/쓴다 → 오프라인 창 내 이중입장은
  기존 설계처럼 체인이 큐 배수 시 `AlreadyCheckedIn`으로 정리(둘째=DENY/late 거절). 대기
  테이블은 온라인 게이트만 가속(명시).
- **인덱서 파생 상태와 분리.** 인덱서(Envio)는 지연이 있어 실시간 admit 판정에 쓰지 않는다
  (기존 `lib/auth.ts` "인덱서는 인가에 안 씀"과 일치). 게이트 판정은 대기 테이블(초 단위) +
  체인 읽기(권위), 인덱서는 목록/이력.
- TTL: 확정분은 짧은 유예 후 삭제(체인+인덱서가 영구 보관), 미확정분은 expiresAt로 정리.

---

## 7. Q6 — 클라이언트 변경

- **관객 claim(`apps/web/src/attendee/claim/**`).** `sendSponsoredOp`/`ops.ts` claim 경로 제거.
  신규 흐름: `claimNonce(account)` 체인 읽기 → `ClaimAuth` 구성(deadline=now+10분) → 기기 키로
  claim 다이제스트 서명(`buildClaimAuth`, `buildResponse.ts` 미러) → `relayClaim` 콜러블 →
  `relays/{id}` 구독 → OpProgress. **사전 차단(held+pending ≥ maxPerWallet)·승인 재폴링·
  precheck 백오프·품절 UX는 클라 읽기라 유지.** 승인제 이벤트: `mode:'request'` →
  requestClaimFor → ClaimRequested → 주최자 approveClaims(4337 무변경) → ClaimApproved 재폴링.
- **입장 흐름(`enter/**`).** **관객이 서명하는 체크인 다이제스트 무변경**(deviceDigest v2,
  `buildResponse.ts` 그대로). 새 도메인 태그 **불필요**(claim과 이미 구조로 분리). 바뀌는 것은
  **제출 주체**뿐 — 관객 폰은 지금처럼 NFC/QR로 응답을 스태프에 건넨다.
- **스태프 게이트(`staff/gate/checkInOp.ts`).** `sendCheckIn`(sendSponsoredOp) →
  `relayCheckIn` 콜러블로 교체. 게이트 스마트 계정/paymaster 불필요(`getGateSmartAccount`·
  UnknownSender 매핑 제거, 시뮬 기반 DENY 매핑으로 대체). **`gateCode.ts`·`gateKey.ts`
  무변경**(게이트 코드 서명 그대로). 스태프 폰은 (code+gateSig)+(response+deviceSig)를 POST.
- **카피(web3어 금지).** 신규 상태(릴레이/확정)는 기존 패턴 재사용, 사용자에겐 릴레이가
  비가시("확인 중"/"입장 완료"). 지갑/가스/체인/NFT/토큰 미사용.
- **오류 매핑.** 콜러블 오류 코드 → 기존 deny/limit 카피(`denyMap.ts`/claim 카피).
- **09-27 규칙 적용.** 단순화 계획의 **B1(claim 통일 상태머신)·OpProgress 저장→확인→완료·
  45초 캡·자동재전송(맹목 금지)·B5 용어집·web3어 grep 0**을 릴레이 claim/체크인 상태머신에
  그대로 이식(재발명 금지). 상태 소스만 op 핸들 → `relays/{id}` 구독으로 교체.

### 안드로이드(MONTI-staff) — 상위 수준만
웹 스태프와 동일: 체크인 제출을 `relayCheckIn` 콜러블로 교체. 게이트 키는 Android
Keystore/StrongBox 유지(`gateKey.ts` 무변경). 번들러/paymaster 연결 불필요(단순화). 확인 사항:
콜러블 엔드포인트가 웹뷰에서 도달(Functions/CORS), Capacitor 빌드 재생성.

---

## 8. Q7 — 비용 모델 (전환 후)

건당(한도 기준 청구, 102 gwei):

| 동작 | 경로 | 실행 gas | 총 est(=intrinsic+calldata+실행) | 한도(×1.075) | MON/건 |
|---|---|---|---|---|---|
| checkInFor | 릴레이 일반 | ~131k (실측 123,753 + 게이트P256 ~7k) | ~155k | ~167k | **0.0170** |
| claimFor | 릴레이 일반 | ~185k | ~200k | ~215k | **0.0219** |
| requestClaimFor | 릴레이 일반 | ~150k | ~165k | ~178k | **0.0181** |

100명 행사(만들기+공개+게이트1 + 100 받기 + 100 입장):

| 항목 | 건수 | 경로 | MON |
|---|---|---|---|
| createEvent | 1 | 4337 | 0.156 |
| publishEvent | 1 | 4337 | 0.118 |
| registerGate | 1 | 4337 | ~0.12 |
| openGate | 1 | 4337 | ~0.10 |
| claimFor | 100 | 릴레이 | 2.19 |
| checkInFor | 100 | 릴레이 | 1.70 |
| **합계** | | | **≈ 4.38 MON** (범위 4.2~4.7) |

- **지금(전부 4337) ≈ 30 MON → ≈ 4.4 MON(약 85% 절감), 목표 5 MON 이하 달성**(여유 ~0.6).
- 민감도: 신규 계정 다수의 첫 claim nonce 콜드 슬롯(+20k/건 → +0.002 MON/건) 최악 +0.2;
  create+publish 배치 시 -0.06. 여전히 5 이하.
- **예치금/in-flight 함의.** paymaster 예치(op당 PVG×maxFee ≈ **0.42 MON** 예약, 5 MON=동시
  ~11건)와 달리, 릴레이어는 in-flight당 `gasLimit×maxFee ≈ 215k×202gwei ≈ 0.043 MON`만
  예약(약 10배 효율, 동시 ~100건 여유). **릴레이어 EOA에 ~10 MON 충전**(소진 ~4.4 + 헤드룸).
  주최자 paymaster는 관객 op이 빠져 훨씬 오래 버팀(create/publish/gate/approve만).

---

## 9. Q8 — 보안 리뷰

- **도메인 분리.** 3개 다이제스트(게이트코드 4필드 / 체크인 7필드 / claim 8필드+태그) 전부
  sha256이나 프리이미지가 서로 다름 → 충돌 불가. 서명 키도 분리(게이트 키 vs 관객 기기 키).
  claim에는 명시 태그 `CLAIM_AUTH_TAG`. 한 서명의 타 경로 재사용 불가.
- **재생.** claim=계정별 nonce 소비 + deadline; 체크인=1회 입장 + 게이트코드 60초 신선도 +
  다이제스트 내 nonce.
- **deadline.** 미제출 claim 승인서 수명 제한.
- **기기 잠금/회전.** claimFor·checkInFor 모두 isMember + isLocked 확인. 회전은 옛 기기 잠금 +
  계정 교체; setActiveDevice가 잠금 해제 + 신규 키. claimNonce는 계정별(교체 시 신주소=0부터).
- **릴레이어 키 침해 반경.** 제출 전용 + 가스 그리핑뿐. 필드 변조·자기 민팅·임의 입장·신원/
  paymaster 접근 불가(확인). 완화: 잔액 ~10 MON 상한 + 알림 + 데모 후 로테이트(핫키).
- **릴레이어 DoS.** 인증(로그인 사용자) + uid 레이트리밋 + 시뮬-우선(revert=가스0) + App Check
  + 잔액 경보.
- **프론트러닝/그리핑.** permissionless 제출은 "사용자가 원한 동작"을 대신 낼 뿐, nonce/1회
  입장이 경합 정리, 제3자가 가스 부담.
- **오프라인 체크인.** 게이트 서명이 오프라인 권한 증명, 체인이 이중입장을 AlreadyCheckedIn로
  정리, 대기 테이블은 오프라인 미적용(명시).
- **인덱서/스냅샷이 신뢰해선 안 되는 것.** 인덱서=목록/이력 전용(인가 금지, 기존과 일치).
  오프라인 스냅샷(attester 서명)=오프라인 로컬 검증용, 체인이 제출 시 재검증. 대기 테이블=
  지연 미러(권위 아님, 체인 1회 입장이 권위).
- **09-27 위협표 유지/개선.** T2(태그복제)·T12(더블탭)·T13(두 게이트)·T14(가짜 게이트)·
  T15(단말 도난) 전부 기존 방어 유지, T14는 온체인 게이트 서명으로 강화. **신규: 릴레이어
  침해(제출+가스 그리핑, 상기 완화).**

---

## 10. Q9 — 마이그레이션 / 롤아웃

데이터 마이그레이션 없음(신규 재배포, 테스트 계정 리셋 — 창업자 룰). 순서(워크트리/브랜치):

1. **컨트랙트(mvp-01b):** Ticket.sol에 claimFor/requestClaimFor/checkInFor(+Late)/claimAuthDigest/
   claimNonce 추가; 직접 claim/requestClaim 제거; _admit의 msg.sender 게이트 검사 → 게이트
   서명 검증. Organizers/Identity 무변경. 테스트 이전(claimFor + vm.signP256), CheckInGas 상한
   재확인(checkInFor). 재배포 → `10143.json` 신주소 + `previous[]` append. `export-abi.sh`.
2. **shared(MONTI-web `packages/shared`):** `claimAuthPreimage/Hash` + `CLAIM_AUTH_TAG` 추가,
   ABI 동기화, `src/deployments/10143.json` 신주소. (게이트코드/deviceDigest 무변경.)
3. **백엔드(mvp-backend):** `relay.ts`(relayClaim/relayCheckIn) + `relayerLock.ts` + `RELAYER_PK`
   시크릿 + `relays`/`admissions` Firestore 규칙·인덱스 + 잔액 스케줄러; Functions 재배포;
   배포 사본 갱신(주소).
4. **웹/안드로이드(mvp-web / mvp-staff):** claim·체크인 제출을 콜러블로 교체, 해당 경로에서
   sendSponsoredOp 제거; Vercel env(신주소); 웹 배포; 안드로이드 재빌드.
5. **인덱서:** `indexer/scripts/gen-config.mjs`로 config 재생(신주소+ABI). **스키마 변경 없음**
   (Claimed/CheckedIn/CheckedInLate/ClaimRequested/ClaimApproved 동일). envio-release: **무료
   플랜이라 옛 배포 먼저 삭제** 후 신규 릴리스(안 그러면 stall).
6. **seed(`script/Seed.s.sol`):** claimFor/checkInFor를 테스트 P-256 서명으로 사용하게 갱신.
7. **문서:** abi-delta, device-day-runbook, 본 설계/계획 2문서.

병합 순서: mvp-01b → mvp-backend → mvp-web/mvp-staff → mvp-e2e → mvp(기존 merge-checklist 패턴).

**5 MON 목표 측정(페르소나 하니스):** `apps/web/e2e/`에 코스트 시나리오 추가 — Monad
테스트넷에 create + 100 claim + 100 check-in 실행, **릴레이어 EOA 잔액 before/after 차 +
주최자 paymaster 소진**을 합산해 **≤ 5 MON** 단언. E2E_* 플래그로 게이팅.

---

## 11. 착수 전 검증(verify-first)·미해결

1. **[1순위] Monad 테스트넷 P-256 precompile(0x100) 실측.** 라이브 RPC로 checkIn 1건 또는
   `P256.verifySignature` staticcall. 없으면 전 설계의 비용 전제가 붕괴(§1).
   **→ 확인 완료 (2026-09-28 18:40 KST, 오케스트레이터 직접 측정).** `eth_call`을
   `0x…0100`에 160바이트(hash‖r‖s‖x‖y) 입력으로 보내니 유효 서명은
   `0x…01`, 마지막 바이트를 훼손한 입력은 빈 결과를 돌려줬고 `eth_estimateGas`는
   **30,787**(intrinsic 21k + 정밀 검증 ~3.5k + calldata)이었다. RIP-7212가 살아 있으므로
   §8의 gas·비용 전제는 유효하다. 스크립트: 세션 scratchpad `p256probe.mjs`(WebCrypto
   P-256 키 생성 → SHA-256 → raw r‖s).
2. **claimFor 실측 gas.** 임시 ClaimGas 테스트(측정용)로 claim 실행 gas 확정 → 한도 확정.
3. `withGasMargin`=+7.5% 확인됨(constants.test.ts). 릴레이어 한도 마진 ≤15% 준수.
4. `relayCheckIn` 인증 강도 결정(로그인만 vs 게이트 운영자 한정) — 데모는 로그인+시뮬,
   운영자 한정은 데모 후 강화 권고.
5. 게이트코드 다이제스트 도메인 강화(chainId+태그)는 **선택적 방어심화**(짝인 관객
   deviceDigest가 이미 chainId 바인딩 → 필수 아님). 재배포 겸사 반영 여부는 팀 판단.

---

## 12. 확정 변경 — 슬림 저장 구조 (2026-09-28 저녁, 창업자 승인)

가스 바닥 스파이크(`.superpowers/sdd/2026-09-22-monti-01b-redeploy-bundle/spike-gasfloor-report.md`)
결과를 반영해 §3·§4의 저장 구조를 다음으로 **확정**한다. 함수 이름과 이벤트는 §3·§4 그대로.
목표 비용: 발급 ≈ 0.014 MON, 입장 ≈ 0.009 MON (한도 ×1.03, 102 gwei) → 100명 행사 ≈ 2.8 MON.

1. **발급(claimFor) = B2 압축 저장.**
   - tokenId 에 `eventId · tier · serial` 을 인코딩한다(예: `eventId << 96 | tier << 88 | serial`;
     비트 폭은 구현이 정하되 eventId ≥ 2^64, serial ≥ 2^32 를 보장). 토큰별 `eventOf/tierOf`
     **저장 슬롯을 두지 않고** id 에서 계산한다. `eventOf(tokenId)`·`tierOf(tokenId)` 뷰는 **이름·
     시그니처를 유지**하고 내부만 계산식으로 바꾼다(호출부 12곳: web 양도·입장 결과·Inbox,
     functions snapshot/transferInvites/tenderlyWebhook, MontiPaymaster ArgKind.TokenId).
   - (event, account) 당 슬롯 하나에 `claimNonce`(승인서 순번) + `heldCount`(1인 한도 카운트)
     를 패킹한다. `claimNonce[account]` 전역 매핑 대신 **(eventId, account) 키**로 두어 첫 발급
     때 콜드 슬롯 1개만 연다(설계 §2 의 "계정별 nonce" 를 (행사, 계정)별로 좁힌 것 — 승인서에
     eventId 가 이미 들어 있으므로 재생 방지 강도는 동일).
   - 티어 카운터(`minted/supply`)는 (event, tier) 슬롯 그대로. ERC-721 `ownerOf`·`balanceOf`·
     `Transfer` **표준 유지**(B3 비표준 변형은 채택하지 않음).
2. **입장(checkInFor) = 입장 시각 압축 저장(창업자 요구: 시각은 온체인 저장소에 남긴다).**
   - 티켓별 **`uint32 usedAt`(Unix 초)** 을 **한 슬롯에 8장씩 패킹**한다: 슬롯 = `serial / 8`,
     오프셋 = `(serial % 8) * 32 bit`. `usedAt == 0` 이 미사용, `!= 0` 이 사용됨(별도 비트맵 없음).
   - **8의 배수가 아니어도 동작해야 한다(창업자 명시 요구).** 마지막 부분 슬롯(예: 티켓 9장 →
     두 번째 슬롯에 1장)도 정상 기록·조회되어야 하며, 테스트는 1·7·8·9·255·257장 및 임의
     serial 로 확인한다. 같은 행사 안에서 티켓 순번이 띄엄띄엄(취소·환불) 있어도 상관없다.
   - 게이트 번호·코드 지문(nonceHash)·late/manual 플래그는 **저장하지 않고** 기존 이벤트
     `CheckedIn(tokenId, eventId, gateId, nonceHash, ts)` / `CheckedInLate` / `ManualOverride`
     로만 남긴다. 1회 입장 보장은 `usedAt != 0` 검사로 유지.
   - 뷰: `usedAt(tokenId) → uint32` 를 추가하고, 기존 `checkInOf(tokenId)` 는 **이름을 유지**하되
     `ts`(=usedAt) 와 `used` 만 채워 돌려준다(gateId·nonceHash 필드는 0). 호출부: web
     `enter/Result.tsx`, `transfer/precheck.ts`.
   - 다른 컨트랙트가 `usedAt` 을 읽어 "특정 시각 이전 입장자" 같은 온체인 로직을 만들 수
     있어야 한다(창업자가 원한 호환성).
3. **비용 근거(스파이크 실측, 102 gwei, 한도 ×1.03):** 입장 A3 비트맵 0.0088 / A2 티켓별 한 칸
   0.0105 → 8장 패킹 시각 저장은 (22.1k + 7×5k)/8 ≈ 7.1k/건의 저장 비용으로 **≈ 0.0090 MON**
   추정(A4 의 CheckInGas 로 확정). 발급 B2 0.0138 MON.
4. **테스트 요구:** 위 부분 슬롯 케이스, tokenId 인코딩 왕복(eventOf/tierOf/serial), 1인 한도·
   nonce 패킹 경계(오버플로 불가 확인), 기존 CheckIn/CheckInLate/Override/Transfer/Offer
   스위트 green, ContractSize 한도 유지, 가스 리포트(ClaimGas·CheckInGas) 로그.
