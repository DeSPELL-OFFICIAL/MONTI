# MONTI Implementation Plan · 01b 번들 재배포 (Bundled Redeploy)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Read `docs/superpowers/plans/2026-09-20-monti-00-master-plan.md` ("Shared Interfaces"), `docs/superpowers/plans/2026-09-20-monti-01-contracts.md` (이 플랜이 고치는 코드를 만든 플랜), 그리고 `.superpowers/sdd/2026-09-20-monti-01-contracts/final-review.md` (이 플랜의 근거 전부) 를 먼저 읽는다.

**Goal:** 플랜 01 최종 리뷰가 찾아낸 "개별 컨트랙트는 맞는데 시스템이 스펙 약속을 못 지키는" 결함 — C1(오프라인 큐가 체인에 절대 안 들어감), C3(어테스터 침해 시 티켓 절도), I1·I2·I3·I4·I8·I9 — 을 한 번의 묶음 재배포로 전부 닫고, 네 컨트랙트를 같이 새 주소에 올린 뒤 ABI·배포 파일·시드·인덱서 시작 블록까지 갱신한다.

**Architecture:** 부분 재배포는 존재하지 않는다. `Ticket`은 `Identity`·`Organizers`를 immutable로 잡고, `MontiPaymaster`는 셋 다를 잡으며, `Organizers.setTicket`은 일회성이다(`contracts/src/Organizers.sol:70-75`). 그래서 `Identity` 한 줄을 고쳐도 네 주소가 전부 바뀐다. 이 플랜은 그 사실을 받아들이고 **한 번에 다 고친다**: 입장 경로는 `checkIn`(현장, 60초)과 `checkInLate`(복구 후 기록, 행사 창)가 하나의 private `_admit`을 공유하고, 어테스터 침해는 `Identity`의 회전 타임락 + `cancelRotation()`으로 되돌릴 수 있게 되며, 양도 승인 서명은 EIP-712 도메인(chainId + verifyingContract)을 갖는다. 페이마스터는 셀렉터 허용 목록에 deployer 전용 setter를 얻어, 다음부터는 허용 목록 변경이 재배포를 요구하지 않는다.

**Tech Stack:** 플랜 01과 동일하다. Solidity 0.8.31 · Foundry ≥ 1.8 (`evm_version = "osaka"`, 로컬 EVM이 진짜 EIP-7951 P-256 프리컴파일을 가진다) · OpenZeppelin Contracts 5.x (ERC-721, ECDSA) · Solady 0.1.26 (`P256`, `LibString`, `Base64`, `JSONParserLib`) · eth-infinitism account-abstraction v0.6. **새 의존성은 하나도 추가하지 않는다.**

**Spec:** `docs/superpowers/specs/2026-09-20-monti-nfc-ticketing-design.md` (v2.5). 이 플랜이 직접 건드리는 절은 §5.5(분실·교체), §5.8(행사 취소), §6.3(위협 모델 T11·T14·T15), §7.2–7.3(입장 절차·파라미터), §9.3–9.4(기기 정책·권한), §10.2(컨트랙트 API), §12(오프라인 대응), §13(현장 스태프 화면)이다. **마지막 Task가 스펙 본문을 고친다 — 그 전에는 스펙 파일을 건드리지 않는다.**

---

## Global Constraints

플랜 01의 Global Constraints가 **전부 그대로 유효하다**. 아래는 그중 이 플랜에서 특히 자주 깨지는 것들과, 이 플랜에만 추가로 붙는 것들이다.

**플랜 01에서 그대로 내려오는 것 (전문은 `docs/superpowers/plans/2026-09-20-monti-01-contracts.md` "Global Constraints")**

- Monad testnet chain id **10143**, RPC `https://testnet-rpc.monad.xyz`. 로직에 체인 id를 하드코딩하지 않는다.
- **가스는 `gas_used`가 아니라 `gas_limit` 기준으로 과금된다.** 모든 `forge script` 브로드캐스트는 `--gas-limit`을 명시한다.
- P-256 프리컴파일 `0x0000000000000000000000000000000000000100` (EIP-7951, 6,900 gas). Solady `P256.verifySignature` — **low-s만 통과**시키는 쪽이며, 이는 의도된 더 엄격한 동작이다(C2).
- EntryPoint **v0.6** `0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789`. 번들러 Pimlico.
- Solidity **0.8.31**, `evm_version = "osaka"`, `bytecode_hash = "none"`.
- **PII는 절대 체인에 올리지 않는다.** `personId`는 난수 `bytes32`다.
- 한국어는 설명에만 쓴다. 식별자·주석·코드는 영어다. 예외: `tokenURI`가 만드는 JSON의 사람이 읽는 값(`입장 전`, `입장 완료`, `취소됨`)과 그 테스트 단언.
- 작업 디렉터리는 항상 `contracts/`다. 명령의 `cd contracts`를 생략하지 않는다.
- 초록 테스트마다 커밋한다. Conventional commits (`feat:`, `fix:`, `test:`, `chore:`, `docs:`).

**이 플랜에만 추가로 적용되는 제약**

- **바이트코드 무변경 규칙은 이 플랜에 한해 해제된다.** 플랜 01은 "배포된 런타임과 소스가 일치해야 한다"를 지켰지만, 01b는 정의상 그것을 깨는 플랜이다. 대신 **네 컨트랙트가 전부 같이 재배포된다** — `Identity`, `Organizers`, `Ticket`, `MontiPaymaster`. 셋만 올리는 선택지는 없다.
- **목표 시한: 2026-10-05.** 그 뒤에는 재시드·인덱서 재동기화·2차 엔드투엔드 실행에 남는 시간이 10/13 마감 버퍼를 먹는다. 일정이 밀려 하나만 넣어야 한다면 **C1**이다(리뷰의 판단, R-F1).
- **재배포 전제 조건(R-F1):** 02/03/04가 **현재 배포(`contracts/deployments/10143.json`, `ticket` `0xE968…1113`)에서 게이트 탭 한 번을 엔드투엔드로 성공**시킨 뒤에 이 플랜을 실행한다. 먼저 재배포하면 아직 검증 안 된 스택 위에서 디버깅하게 된다.
- **실행 워크트리는 `/Users/moomi/Downloads/z03.Vibe_Coding/MONTI/MONTI-01b`다** — `MONTI-prod`와 같은 저장소의 브랜치 `mvp-01b` 체크아웃이며 `f8e577d`(260 테스트 통과)에서 분기했다. 이 플랜이 `…/MONTI-prod/contracts/…`로 쓴 경로는 **그 워크트리 안의 같은 상대 경로**를 뜻하고, `git` 명령도 워크트리에서 돌린다. 소비자 저장소(`MONTI-backend`, `MONTI-web`, `MONTI-staff`)는 별개의 저장소라 언제나 전체 경로로 적는다.
- **코드 크기 한도는 EIP-170의 24,576 B가 아니라 Monad의 128 KB다.** `contracts/foundry.toml`에 `code_size_limit = 131072`를 넣는 것이 Task 1이고, 그 한 줄이 `forge build --sizes`·`forge test`·`forge script`의 revm 검사와 `.github-checks.sh`를 한꺼번에 푼다. 이후 어떤 Task도 바이트를 아끼려고 설계를 바꾸지 않는다. Task 12가 런타임·이니트코드 둘 다 131,072 B 미만임을 단언한다.
- **기존 스폰서 셀렉터는 하나도 바꾸지 않는다.** `checkIn(uint256,(uint256,uint256,uint64,bytes32),bytes)`를 비롯해 `_seedSelectors`에 이미 있는 **23개** 셀렉터(`MontiPaymaster.sol:343-377`)의 시그니처는 그대로 둔다. 새 기능은 **새 셀렉터로 추가**한다. 바뀌는 것은 "Interface delta" 절에 전부 적혀 있다.
- **`checkInOf`의 반환 구조체가 바뀐다** (`CheckIn`에 `bool late` 추가). 이것이 이 플랜에서 유일하게 기존 함수의 ABI를 바꾸는 항목이며, 02/03/04는 ABI 재내보내기(Task 13) 뒤 재빌드만 하면 된다.
- **`@monti/shared`는 네 벌이다** — `MONTI-prod`(ABI 드롭 전용), `MONTI-backend`(**정본**), `MONTI-web`, `MONTI-staff`. Task 13과 15는 네 곳을 전부 훑는다. 세 벌이라고 쓴 초안은 틀렸다.
- **스펙 파일은 Task 16에서만, 하위 플랜 문서(03·04)는 Task 17에서만 고친다.** 그전에는 읽기만 한다.
- 커밋은 하되 **푸시·PR·머지는 하지 않는다.** 오케스트레이터가 검토한다.

---

## Design

이 절은 "왜 이렇게 고치는가"다. 실행자는 Task로 바로 가도 되지만, **D1과 D2는 반드시 읽는다** — 둘 다 보안 성질을 직접 정한다.

### D1. C1 — 오프라인 큐: `checkInLate` 별도 함수, 게이트 공동서명 없음

**문제.** `contracts/src/Ticket.sol:350`이 `issuedAt + 60초 < block.timestamp`면 되돌린다. 스펙 §12는 단말기 인터넷이 끊기면 스냅샷으로 로컬 검증하고 "OFFLINE 승인"을 띄운 뒤 **트랜잭션을 큐에 쌓아 복구 후 전송**한다고 약속한다(§17 데모 10번 비트). 60초를 넘는 장애는 전부 `CodeExpired`로 되돌아간다. 게이트가 고칠 수도 없다: 다이제스트(`Ticket.sol:356`)가 `nonce`와 `issuedAt`을 묶고, 다시 서명할 수 있는 건 이미 공연장을 떠난 관객 폰뿐이다.

**채택: `checkInLate(uint256 tokenId, GateCode g, bytes deviceSig)` — `checkIn`과 인자가 같고, 시계 규칙만 다르며, 둘이 private `_admit`을 공유한다.**

- 코드 발급 하한: `issuedAt + LATE_WINDOW >= startsAt` (12시간). 행사 시작 12시간 전보다 더 옛날 코드는 안 받는다.
- 제출 상한: `block.timestamp <= endsAt + LATE_WINDOW`. 행사 종료 후 12시간까지 기록을 받는다.
- 미래 상한: `issuedAt <= block.timestamp + CLOCK_SKEW` — `checkIn`과 동일, 변경 없음.
- 게이트 권한: 이 행사의 **등록된, 폐기되지 않은** 게이트면 된다 — `open` 여부는 묻지 않는다.
- 나머지는 전부 `checkIn`과 동일: 1회 입장, 티켓 상태, 취소된 행사 거부, 관객 기기 서명 P-256 검증.
- 기록: `CheckIn.late = true`, 그리고 `CheckedIn` **에 더해** `CheckedInLate`를 추가로 emit 한다.

**왜 게이트 공동서명(`gateSig`)을 버렸는가 — 이게 이 설계의 핵심 판단이다.**

브리프가 제안한 후보는 게이트가 `sha256("MONTI_LATE", tokenId, gateId, eventId, nonce, issuedAt)`를 등록된 게이트 P-256 키(`Organizers.gateInfo.kx/ky`)로 공동서명하는 것이었다. **검토 결과 이 서명은 보안을 1비트도 더하지 않는다.**

1. **권한이 중복이다.** 게이트 계정(스마트 계정)은 스펙 §7.1 3번에 따라 **바로 그 게이트 키로부터** 만들어진다. `checkInLate`를 보내는 UserOp은 이미 그 키의 서명으로 검증된다. 같은 키의 두 번째 서명은 같은 사실을 두 번 말한다.
2. **무결성도 중복이다.** `issuedAt`과 `nonce`는 원래부터 게이트가 고르고 관객 기기 서명이 묶는 값이다. 게이트가 늦은 제출에 대해 거짓말을 할 수 있다면, 거짓말에 서명도 할 수 있다.
3. **권한 집합이 동일하다.** `checkInLate`를 부를 수 있는 건 `checkIn`을 부를 수 있는 바로 그 집합이다. 공동서명은 그 집합을 좁히지 않는다.
4. **시드가 깨진다.** `contracts/script/Seed.s.sol:155`는 게이트를 `keccak256("gate-kx")` 자리표시자 키로 등록한다(리뷰 Minor 4). 공동서명을 요구하면 **시드된 게이트는 큐를 영원히 못 흘린다** — 데모날 아침에 발견할 종류의 함정이다.
5. **정합성 위험이 새로 생긴다.** `registerGate(eventId, gateAccount, kx, ky)`는 `gateAccount`가 `(kx, ky)`의 소유 계정인지 **증명하지 않는다** — 두 인자는 독립이다. 공동서명을 요구하면 잘못 등록된(그러나 정당한) 게이트가 조용히 못 쓰게 된다.
6. **비용.** P-256 검증 1회 +6,900 gas, calldata +64 B. Monad는 한도 기준 과금이므로(§10.1) 탭마다 직접 새는 돈이다.

**왜 `checkIn`에 `gateSig` 인자를 붙여 하나의 셀렉터로 합치지 않았는가.** 브리프가 "페이마스터 허용 목록 셀렉터를 하나로 유지하려면"이라며 제시한 안인데, **전제가 틀렸다.** 인자를 하나 더하면 셀렉터가 `checkIn(uint256,(uint256,uint256,uint64,bytes32),bytes)` → `checkIn(uint256,(uint256,uint256,uint64,bytes32),bytes,bytes)`로 **바뀐다**. 즉 셀렉터를 유지하기는커녕 현장 경로의 셀렉터를 갈아치우고 03/04의 기존 호출과 허용 목록 항목을 동시에 깨뜨린다. 엄격히 더 나쁜 선택지라 기각했다.

**왜 리뷰의 최소안(`checkIn` 안에서 과거 한도만 넓히기)도 기각했는가.**

- §12는 오프라인 승인의 **사후 대사**를 요구한다("수용·기록·사후 대사"). 한 함수로 합치면 어떤 입장이 큐에서 왔는지 체인에 남지 않아 대사할 데이터가 없다.
- §7.3은 "**시간 초과로 소프트 승인 금지**"를 명시한다. 현장 경로에서 5분 지난 탭이 통과하면 그게 정확히 소프트 승인이다. 61초 지난 현장 탭은 앞으로도 `EXPIRED_CODE`("다시 대세요")여야 한다.
- 별도 셀렉터라야 나중에 이 경로만 스폰서에서 빼거나 제한할 수 있다(새 setter와 함께, D6).

**위협 분석 (T2 / T12–T15).**

| 위협 | 넓힌 창이 바꾸는 것 | 판정 |
|---|---|---|
| T2 태그 복제 | 없음. 복제본이 재생하려 해도 1회 입장(`Ticket.sol:343`)과 게이트 `msg.sender` 검사가 그대로다. 60초 창은 원래 T2의 방어선이 아니라 신선도 위생이었다 | 유지 |
| T12 더블 탭 | 없음. `AlreadyCheckedIn`은 경로와 무관하다. 큐 재전송이 `AlreadyCheckedIn`으로 되돌아오면 04는 **성공으로 처리**한다 | 유지 |
| T13 두 게이트 동시 | 없음. 원자성은 체인이 준다 | 유지 |
| T14 가짜 게이트 | 없음. 가짜 게이트는 allowlist에 없어 두 경로 다 막힌다. 오히려 I3·I4가 폐기 경로를 실제로 쓸 수 있게 만든다 | 개선 |
| T15 단말기 도난 후 큐 조작 | **관객 기기 서명이 여전히 필수다.** 단말기 혼자서는 큐 항목을 만들 수 없다 | 유지 |
| **신규 잔존 위험** | 등록된 게이트가 서명을 **미리 수확**해 두었다가 나중에 쓰는 것. 60초일 때는 즉시 태워야 해서 관객이 바로 알아챘다 | `issuedAt + LATE_WINDOW >= m.startsAt` 하한이 **며칠 전 수확**을 죽인다. 정확히 말하면: 하한은 *코드가 개장 대비 얼마나 옛것인가*만 묶고 *게이트가 얼마나 오래 쥐고 있을 수 있는가*는 묶지 않는다 — 6시간짜리 행사라면 탭한 순간부터 `endsAt + 12h`까지 최대 30시간을 쥘 수 있다. 재생 자체는 **1회 입장**이 막는다(`Ticket.sol:343`, `_admit`에 그대로 보존. nonce 레지스트리는 원래 없고 `nonceHash`는 기록일 뿐 가드가 아니다). 그러므로 남는 위험은 **한 번도 입장하지 않은 티켓**을 그 게이트가 뒤늦게 태우는 것뿐인데, 그 서명을 얻으려면 관객 폰이 물리적으로 그 단말기에 탭했어야 하고, 공격자가 얻는 것은 없으며(관객은 어차피 들어오려던 참이다) 남는 건 그리핑이다. 대응은 T14와 같은 `revokeGate`이고, I3·I4가 그것을 처음으로 실효 있고 가스리스하게 만든다 |

**단말기(04)가 큐에 넣는 것.** 현장 전송에 쓸 값 그대로다 — 새로 만드는 재료가 없다:

```
{ tokenId, gateId, eventId, issuedAt, nonce, deviceSig(64B),
  tappedAtLocal, snapshotEpoch, snapshotVerdict }
```

복구 후 `checkInLate(tokenId, {gateId, eventId, issuedAt, nonce}, deviceSig)`를 **게이트 계정으로, 페이마스터 스폰서로** 보낸다. 결과 처리: `AlreadyCheckedIn` → 성공으로 간주하고 큐에서 제거. `CodeExpired`/`EventEnded`/`EventCancelled` → 큐에서 빼되 "미기록" 목록으로 옮겨 주최자에게 보여준다(§12의 사후 대사). 그 밖 → 지수 백오프 재시도.

### D2. C3 — 어테스터 침해: 회전 타임락 + 되돌리기

**문제.** `Identity.rotateAccount`(`:80`)는 어테스터 전용이고 본인 동의가 없다. 등록 후 7일이 지난 사실상 모든 사람에 대해, 침해된 어테스터가 `rotateAccount(victimPersonId, thief)` → `Ticket.migrate(tokenId)` 두 번으로 미사용 티켓을 가져간다. `migrate`(`:446`)는 `_internalMove`를 세워 `transferable`·양도 마감·`maxTransfers`·`maxPerWallet`·`requireKyc`를 **의도적으로 전부 건너뛴다**. 스펙 §6.3 T11은 백엔드 침해를 "무력화"라고 쓴다 — **틀렸다**.

**기각한 후보**

- **본인(구 계정) 서명 요구.** 회전은 *폰을 잃어버려서* 하는 절차다(§5.5). 서명할 수 있으면 회전이 필요 없다. 복구 플로우와 정면으로 모순된다.
- **새 계정의 동의 요구.** `migrate`는 이미 새 계정만 부를 수 있다 — 그런데 도둑이 바로 그 새 계정이다. 구멍이 아니다.
- **`migrate`에 양도 규칙 복구.** `requireKyc`는 침해된 어테스터가 `setKycLevel`로 위조하므로 무의미하고, `maxPerWallet`은 티켓 2장 가진 정상 복구를 깬다.
- **어테스터 다중서명/KMS 온체인화.** MVP 범위 밖이다. R-F3: KMS 이전은 메인넷 전 요구사항으로 남고, 컨트랙트는 건드리지 않는다.

**채택: 회전 타임락 + 구 계정의 되돌리기.** 리뷰가 제안한 그것이고 R-F1이 승인한 범위다.

1. `Identity`가 이미 가진 `_rotatedAt[personId]`를 공개한다 — `rotatedAt(bytes32) returns (uint64)`.
2. `Ticket.migrate`는 `block.timestamp >= rotatedAt + MIGRATE_DELAY`(24시간)를 요구하고, 아니면 `RotationPending()`.
3. 새 매핑 `_rotatedFrom[personId]`에 **직전 계정 하나**를 기록하고, `Identity.cancelRotation()`은 **`msg.sender == _rotatedFrom[personId]`이면서 `block.timestamp < rotatedAt + MIGRATE_DELAY`일 때만** 통한다. 성공하면 계정 매핑을 되돌리고 닉네임을 되가져오고 `_rotatedFrom`을 비운다.
4. **취소는 기기 잠금을 풀지 않는다.** Task 4가 회전 때 건 잠금은 그대로 남고, 정상적인 기기 변경 경로(`setActiveDevice`)로만 풀린다.
5. **쿨다운 스탬프는 되감지 않는다.** 취소해도 `_rotatedAt`은 시도 시각 그대로라, 공격자는 다음 시도까지 `ROTATION_COOLDOWN` 7일을 꼬박 기다려야 한다.

**3번과 4번이 없으면 이 수정 자체가 취약점이다.** 초안은 "`_personOf[msg.sender]`가 있고 현재 계정이 아니면" 취소를 허용했는데, `_personOf`는 밀려난 계정에서 **영원히 지워지지 않는다**(`Identity.sol:79`가 그렇게 설계했다 — `migrate`가 옛 티켓에서 새 계정을 찾으려면 필요하다). 그래서 그 조건이 허가하는 집합은 **그 사람이 지금까지 가져본 모든 계정, 시간 제한 없이**였다. 두 가지가 터진다:

- A→B→C로 두 번 회전한 뒤에도 A와 B가 조건을 만족한다. 둘 중 아무나 몇 년 뒤에 `cancelRotation()`을 불러 `_accountOf`를 자기 것으로 되돌리고 `_personOf[C]`를 지운다. 그러면 C는 멤버가 아니게 되어 Task 3 이후 C가 든 티켓이 전부 얼고(`_update`가 `NotMember`), C는 `migrate`도 못 한다(`NotRotatedAccount`). **정상 복구가 영구히 되돌려질 수 있다.**
- 동기화된 패스키(§6.3 T6)나 도난당한 옛 폰이 정상 복구를 **즉시** 무효화할 수 있고, 초안의 마지막 블록이 자기 기기 잠금까지 풀어 Task 4가 방금 건 잠금을 되돌린다. 7일 쿨다운마다 반복하면 §5.5 복구 플로우가 영구 DoS다.

`_rotatedFrom` 한 칸과 24시간 상한이 둘 다 닫는다. A→B→C 뒤 `_rotatedFrom`은 **B**뿐이고, 창은 B→C 회전 시각부터 24시간뿐이다.

**`migrate` 성공 시 `_rotatedFrom`을 지우지 않는다 — 필요가 없기 때문이다.** `migrate`는 `now >= rotatedAt + MIGRATE_DELAY`를, `cancelRotation`은 `now < rotatedAt + MIGRATE_DELAY`를 요구하므로 두 창은 **상호 배타**다. 지우려면 `Identity`가 `Ticket`을 신뢰해야 하는데, 지금 그런 연결선은 `Organizers.setTicket` 하나뿐이고 새로 만들 값이 없다.

**왜 24시간인가.** 회전 자체가 이미 7일 쿨다운 뒤에만 가능하므로(`Identity.sol:85`) 정상 복구에 추가되는 체감 지연은 미미하다. 반대로 피해자 쪽에서는 `AccountRotated` 푸시를 자는 동안 놓쳐도 하루가 남는다. 6시간은 야간 공격에 진다. §17 데모 대본은 복구를 실연하지 않으므로 데모 영향도 없다.

**`cancelRotation`은 페이마스터가 스폰서해야 한다.** 피해자가 가스 없이 눌러야 하는 버튼이다 — 허용 목록에 `ArgKind.Platform`으로 추가한다.

**남는 잔존 위험 두 가지 — 스펙 §6.3 T11에 그대로 적는다.**

① **침해된 어테스터.** 여전히 `setKycLevel`로 KYC 등급을 위조하고, 임의 신원을 등록하고, 아무 계정이나 `lockDevice`로 잠가 현장 대량 DENY를 내고, **24시간 안에 취소하지 않은 사람의 미사용 티켓을 가져간다.** 못 하는 것: 티켓 발행, 티켓 취소, 입장 처리, 행사 생성, 이미 입장했거나 취소된 티켓 이동. 근본 해결은 §10.3이 이미 요구하는 Cloud KMS 이전이며 메인넷 전 필수다.

② **도난·동기화된 옛 패스키.** 정당한 회전 한 번을 그 24시간 창 안에서 되돌릴 수 있다 — 복구가 다음 7일 쿨다운으로 밀린다. 그러나 **신원을 빼앗지는 못한다**: 취소해도 회전이 건 기기 잠금이 그대로 남아, 되살아난 옛 계정은 문 앞에서 막히고(I2) 티켓도 못 보낸다(I1). 잠금을 풀려면 `setActiveDevice`라는 정상 경로를 타야 하는데, 그건 §6.3 T6이 이미 동기화 패스키의 잔존 위험으로 받아들인 권한이지 `cancelRotation`이 새로 준 권한이 아니다. 즉 이 기능이 더한 것은 "복구 지연"이지 "탈취"가 아니다.

**되돌리기의 두 가지 흔적.** (a) 닉네임: 회전 뒤 새 계정이 이름을 바꾼 상태에서 취소하면 옛 계정은 **그 시점의 핸들**을 돌려받는다. 원래 핸들은 풀려 있으므로 `setNickname`을 한 번 더 누르면 된다. (b) 기기 잠금: 취소 직후 본인은 잠긴 상태다. `setActiveDevice`로 자기 기기 키를 다시 등록하면 풀리는데, 마지막 기기 변경으로부터 7일이 지나지 않았다면 그만큼 기다려야 한다. 드문 안전판에 상태를 더 쌓지 않으려는 의도적 선택이고, 둘 다 03의 복구 화면이 문구로 안내한다.

### D3. I8 — 양도 승인 다이제스트에 도메인 분리

**문제.** `Ticket.sol:318`의 `keccak256(abi.encode(tokenId, o.recipientCommitment, msg.sender))`에는 chainId도, 검증 컨트랙트 주소도, EIP-191/712 접두도 없다. 같은 서명이 테스트넷·메인넷·모든 `Ticket` 재배포본에서 유효하다. **이번 재배포가 바로 그 "모든 재배포본"의 실례다** — 지금 고치지 않으면 옛 주소용 서명이 새 주소에서 그대로 먹힌다.

**채택: OpenZeppelin `EIP712`를 상속한다.** `contract Ticket is ERC721, EIP712, ITicket` + 생성자 기반 호출 `EIP712("MONTI Ticket", "1")`, 그리고 `_hashTypedDataV4(structHash)`로 `TransferApproval(uint256 tokenId,bytes32 recipientCommitment,address recipient)`의 다이제스트를 만든다. 공개 뷰 `offerDigest(uint256,bytes32,address)`로 노출한다.

크기 제약이 사라졌으므로(D5) 원칙 6(검증된 라이브러리)을 그대로 따르는 것이 맞다. 손수 쓴 도메인 대비 실익 세 가지: ① OZ가 `block.chainid`가 캐시된 값과 다르면 분리자를 **다시 계산**하므로 포크 안전성이 동일하고, ② ERC-5267 `eip712Domain()`이 공짜로 붙어 02가 도메인을 하드코딩하지 않고 체인에서 읽을 수 있으며, ③ `EIP712("MONTI Ticket","1")`은 **생성자 인자가 아니라 기반 생성자 호출**이라 `Deploy.s.sol:90-102`가 한 글자도 바뀌지 않는다(Task 14의 "`Deploy.s.sol`은 고칠 것이 없다"가 그대로 성립한다).

다이제스트 값은 손수 쓴 버전과 **바이트 단위로 같다** — `_hashTypedDataV4`가 만드는 것이 정확히 `keccak256(\x19\x01 ‖ domainSeparator ‖ structHash)`이기 때문이다. 그래서 Task 9의 세 테스트(정의대로 계산한 값과 일치 / 다른 배포본에서 불일치 / 다른 체인에서 불일치)가 그대로 통과한다.

**deadline/nonce는 넣지 않는다.** 어테스터가 서명하는 사실은 "이 계정이 그 핸들의 주인이다"이고, 그건 지속되는 사실이다. 오퍼 만료는 이미 온체인 `Offer.expiresAt`가 강제한다(`Ticket.sol:316`). 같은 `(tokenId, commitment, recipient)`에 대한 재사용은 같은 사람에게만 유효하므로 피해가 없다. YAGNI.

**오프체인 절반이 이미 존재한다 — 이게 이 항목에서 제일 잘 터지는 곳이다.** 초안은 "02에 마이그레이션할 서명자가 없다"고 적었는데 **틀렸다**: `packages/shared/src/encoding.ts`의 `offerDigest()`가 지금 바로 그 **재배포 전 원시 keccak 모양**을 구현하고 있고(`uint256,bytes32,address`), `encoding.hash.test.ts`에 고정 벡터 `0x90244cd7…ed0a`까지 박혀 있다. 그 파일은 `MONTI-backend`·`MONTI-web`·`MONTI-staff` 세 곳에 있다. **컨트랙트와 같은 Task에서 함께 바꾸지 않으면 어테스터가 옛 다이제스트에 서명하고 모든 `acceptOffer`가 런타임에 `BadAttesterSig`로 되돌아간다 — 빌드는 초록인 채로.** 그래서 Task 9가 컨트랙트와 `encoding.ts`와 고정 벡터를 **한 커밋에** 담는다.

### D4. I9 — 취소된 행사의 티켓

**문제.** `tokenURI`(`:483-488`)는 `_revoked`와 `_checkIns`만 본다. `cancelEvent` 후에도 NFT는 **입장 전**이라고 읽힌다. §5.8은 "행사 취소 시 티켓 일괄 취소(체인)"를 약속한다.

**채택: 일괄 revoke는 하지 않는다. 파생을 고친다.** 티켓 N장을 도는 루프는 가스 한도가 불명확한 무한 확장이라 애초에 선택지가 아니다. `cancelEvent`는 지금처럼 행사만 표시하고, `tokenURI`가 `eventStatus(eventId) == Cancelled`를 **취소됨**으로 읽는다. 우선순위는 `_revoked` → 행사 `Cancelled` → 입장 완료 → 입장 전. 행사 단위 무효가 티켓 단위 상태를 덮는다. 03은 뱃지를 `isRevoked`가 아니라 `eventStatus`에서 파생해야 한다. 스펙 §5.8 문장도 Task 16에서 이 의미로 고친다.

### D5. 코드 크기 — 한도는 24,576 B가 아니라 128 KB다

2026-09-21 실측(`forge build --sizes`, HEAD `f8e577d`):

| 컨트랙트 | 런타임 | 이니트코드 |
|---|---|---|
| Ticket | 22,673 B | 23,429 B |
| MontiPaymaster | 8,539 B | 11,103 B |
| Identity | 4,068 B | 4,312 B |
| Organizers | 3,975 B | 4,034 B |

EIP-170의 24,576 B는 **체인의 한도가 아니었다.** Monad는 128 KB를 받는다. 24,576 B를 강제하고 있던 것은 세 군데의 툴체인뿐이다 — `forge build --sizes`의 보고(그리고 `.github-checks.sh`가 그걸 돌린다), `forge test`·`forge script`가 쓰는 revm의 EIP-170 검사, 그리고 revm이 그 값에서 유도하는 EIP-3860 이니트코드 상한. **`contracts/foundry.toml`의 `code_size_limit = 131072` 한 줄이 셋을 동시에 푼다**(`[profile.ci]`는 상속한다). 그게 Task 1이고, 그 뒤로는 어떤 Task도 바이트를 아끼려고 설계를 바꾸지 않는다.

그래서 이 플랜에는 **크기 탈출구가 없다.** `tokenURI`를 외부 라이브러리로 쪼개거나 `optimizer_runs`를 낮추는 우회는 전부 뺐다. OZ `EIP712`도 그래서 그냥 쓴다(D3). `checkIn`/`checkInLate`가 private `_admit`을 공유하는 것은 여전히 그대로인데, 그건 크기 때문이 아니라 **두 경로의 검사 순서가 한 글자도 갈라지면 안 되기 때문**이다.

**세 가지는 재배포 전에 실증해야 한다**(Task 15 Step 0). 128 KB라는 숫자, 그보다 먼저 걸리는 **이니트코드 상한**(`Ticket`의 생성 코드가 23,429 B로 런타임보다 먼저 24,576 B를 넘는다 — Foundry는 `code_size_limit`에서 유도하니 괜찮지만 Monad 노드의 `max_initcode_size`는 별개다), 그리고 **번들러 경로**(Pimlico가 유일한 설정이고 Alto는 노드의 `eth_call`/`debug_traceCall`로 시뮬레이션하므로 노드 한도가 지배한다. 번들러 거부는 온체인 흔적을 남기지 않는다 — 리뷰의 I6 경고와 같은 실패 양식이다). Envio는 로그만 읽으므로 무관하다.

### D6. 그 밖에 넣은 것 / 뺀 것

**넣는다 (사소하고 싸고 실제 위험이 있는 것):**

- **I1** `_update`의 from-쪽 가드. 잠긴 계정(§5.5 패닉 버튼)이 지금은 티켓을 그대로 전송할 수 있다. `_internalMove` 분기 **밖이 아니라 안**에 넣어야 한다 — 밖에 넣으면 `migrate` 자체가 죽는다(migrate는 잠기고 탈퇴한 계정에서 빼오는 동작이다).
- **I2** `rotateAccount`가 구 기기를 잠근다 + `checkIn`이 보유자 멤버십을 다시 본다. 잃어버린 폰이 `migrate` 전까지 계속 입장하던 구멍.
- **I3** `revokeGate`가 `_gateOf`를 지운다. 지금은 폐기된 게이트가 영원히 스폰서를 받고(플랫폼 예치금을 태울 수 있고), 그 주소는 영구히 재등록 불가다.
- **I4** 허용 목록에 `revokeGate`/`revoke`/`createOrganizer`/`transferOwner` 추가 + **deployer 전용 `setAllowed`**. 세터가 없어서 허용 목록 한 줄 바꾸는 데 전체 재배포가 필요했다(R-PM6의 구조적 귀결).
- **Minor 2** `registerGate`의 반쪽 0 키 허용(`kx == 0 && ky == 0`) → `||`. T14 방어 ①(관객 폰의 게이트 서명 검증)이 반쪽 키에서 깨진다. `Identity`와 일관.
- **Minor 5** `requestOverride`에 행사 상태 검사. 취소되거나 끝난 행사에 결재 요청이 올라간다.
- **C2 고-s 거부 테스트.** 컨트랙트 변경 없음. 22개 뮤테이션 중 유일하게 살아남은 M6를 죽인다.

**뺀다 (이유와 함께):**

- **Minor 6** `manualOverride`가 폐기된 게이트 id를 받는 것 — 리뷰가 "cosmetic, 기록되는 건 승인자"라고 판정. DENY 표면을 건드릴 값이 없다.
- **Minor 7** `deployer` immutable 회전 경로 없음 — 세 컨트랙트에 권한 표면을 새로 여는 일이고 "싸다"에 해당하지 않는다. 운영 문서로 남긴다(deployer 키 분실 = 어테스터 회전·스테이크·플랫폼 출금 영구 동결).
- **Minor 8** `maxPerWallet`이 티어별 선언인데 행사 전체 잔고로 강제되는 것 — 티어별 잔고 추적이 필요한 동작 변경이다. `claim`과 `_update`가 서로 일관하므로 지금은 버그가 아니다. 03의 사전 검사가 체인과 같은 규칙을 쓰면 된다.
- **Minor 9** 신규 계정의 7일 쿨타임을 "언제부터 가능" 으로 렌더하는 것 — **03의 UI 항목**이지 컨트랙트 변경이 아니다. 01b는 `rotatedAt`과 `rotatedFrom`을 뷰로 노출해 그 화면이 날짜와 취소 가능 여부를 계산할 재료를 준다(Task 5).
- **Minor 10** `checkIn`이 게이트 권한보다 티켓 상태를 먼저 드러내는 것 — 리뷰 자신이 "옳은 선택"이라고 판정했다(`checkInOf`·`isRevoked`는 어차피 공개 뷰다). `_admit`은 그 순서를 **한 글자도 바꾸지 않고** 옮긴다.
- **I5** 조직 오너도 Identity 멤버여야 스폰서를 받는 것 — 컨트랙트 버그가 아니라 03의 가입 순서 제약이다(R-F4).
- **I6** 스테이크 1 MON — `addStake`는 재호출 가능하므로 재배포와 무관하다. Pimlico가 거부할 때만 올린다(R-F5).
- **I7** 송신자·조직별 레이트 리밋 — post-MVP(R-F5). 대신 `setAllowed`가 **즉시 정지 스위치**를 준다: 어떤 셀렉터가 남용되면 재배포 없이 한 트랜잭션으로 스폰서에서 뺀다. 이게 `createOrganizer`를 스폰서하는 것(그 함수는 인증이 없다)을 감당 가능하게 만드는 근거다.
- **I10** 실 UserOp 가스 4필드 측정 — 04 T21(R-F5).

---

## Interface delta

02·03·04가 **그대로 적용**할 수 있는 변경 목록이다. Task 13이 `packages/shared/src/abi/*.json`을 다시 내보내면 타입은 따라오지만, 아래 동작 변화는 코드를 고쳐야 한다.

### Ticket

**새 함수**

| 시그니처 | 설명 |
|---|---|
| `checkInLate(uint256 tokenId, (uint256,uint256,uint64,bytes32) g, bytes deviceSig)` | 복구 후 큐 기록. `checkIn`과 인자 동일. 스폰서됨(`ArgKind.TokenId`, word 0) |
| `offerDigest(uint256 tokenId, bytes32 recipientCommitment, address recipient) view returns (bytes32)` | `acceptOffer`가 검증하는 EIP-712 다이제스트. 02가 자기 서명을 교차검증할 때 쓴다 |
| `eip712Domain() view returns (bytes1,string,string,uint256,address,bytes32,uint256[])` | ERC-5267. OZ `EIP712` 상속으로 공짜로 붙는다. 02·03이 도메인을 하드코딩하지 않고 체인에서 읽을 수 있다 |
| `LATE_WINDOW() view returns (uint256)` | 43200 (12시간) |
| `MIGRATE_DELAY() view returns (uint256)` | 86400 (24시간) |

**바뀐 함수**

| 이름 | 변경 | 소비자가 할 일 |
|---|---|---|
| `checkInOf(uint256)` | 반환 구조체 `CheckIn`에 **`bool late`** 추가 (`{gateId, ts, nonceHash, manual, late}`) | ABI 재빌드. 구조체를 위치로 디코드하는 코드가 있으면 필드 추가 확인 |
| `acceptOffer(uint256,bytes)` | **셀렉터 불변.** 다이제스트가 EIP-712로 바뀜 | **02의 서명 코드 교체 — 아래 참조** |
| `tokenURI(uint256)` | 취소된 행사의 티켓이 `취소됨`으로 읽힘 | 03은 뱃지를 `eventStatus(eventId) == 2`에서 파생 |
| `checkIn(...)` | 보유자가 멤버가 아니면 `NotMember()` | 04의 DENY 맵에 `NotMember` → `TX_FAILED` 추가(§13에 대응 코드 없음) |
| `migrate(uint256)` | 회전 후 24시간 전이면 `RotationPending()` | 03은 "N시간 후 사용 가능"으로 렌더 |
| `transferFrom`/`safeTransferFrom` | 보내는 쪽이 잠겼으면 `DeviceLocked()`, 멤버가 아니면 `NotMember()` | 03의 사전 검사에 추가 |
| `requestOverride(...)` | 끝난/취소된 행사면 `EventEnded()`/`EventCancelled()` | 04의 결재 요청 화면 |

**새 이벤트 / 에러**

- `event CheckedInLate(uint256 indexed tokenId, uint256 indexed gateId, uint64 issuedAt, uint64 ts)` — `CheckedIn`과 **같은 트랜잭션에서 함께** emit 된다(`manualOverride`가 `ManualOverride` + `CheckedIn`을 함께 내는 것과 같은 패턴). 인덱서는 `CheckedIn`으로 입장을 세고, `CheckedInLate`로 오프라인 비율을 센다.
- `error RotationPending()`

**02의 서명 코드 교체 (viem)**

```ts
// 이전 — 원시 keccak, 접두 없음
const digest = keccak256(encodeAbiParameters(
  [{ type: 'uint256' }, { type: 'bytes32' }, { type: 'address' }],
  [tokenId, recipientCommitment, recipient],
))
const signature = await attester.sign({ hash: digest })

// 이후 — EIP-712
const signature = await attester.signTypedData({
  domain: {
    name: 'MONTI Ticket',
    version: '1',
    chainId,                       // 10143 / 143, 환경변수에서
    verifyingContract: ticketAddress,
  },
  types: {
    TransferApproval: [
      { name: 'tokenId', type: 'uint256' },
      { name: 'recipientCommitment', type: 'bytes32' },
      { name: 'recipient', type: 'address' },
    ],
  },
  primaryType: 'TransferApproval',
  message: { tokenId, recipientCommitment, recipient },
})
```

교차검증(권장): `await ticket.read.offerDigest([tokenId, recipientCommitment, recipient])`가 viem의 `hashTypedData(...)`와 같은지 통합 테스트에서 한 번 단언한다.

### Identity

**새 함수**

| 시그니처 | 설명 |
|---|---|
| `cancelRotation()` | **직전에 밀려난 계정만**(`rotatedFrom(personId) == msg.sender`), **회전 후 `ROTATION_UNDO_WINDOW`(= `MIGRATE_DELAY`) 안에만**. 기기 잠금은 **풀지 않는다**. 스폰서됨(`ArgKind.Platform`) |
| `rotatedAt(bytes32 personId) view returns (uint64)` | 마지막 등록/회전 시각. `Ticket.migrate`의 타임락 기준이자 취소 창의 시작점. `IIdentity`에도 추가 |
| `rotatedFrom(bytes32 personId) view returns (address)` | 직전 회전에서 밀려난 계정. 취소 뒤에는 `address(0)`. 03의 복구 화면이 "지금 되돌릴 수 있는가"를 이것과 `rotatedAt`으로 계산한다 |
| `ROTATION_UNDO_WINDOW() view returns (uint256)` | 86400 (24시간). **`Ticket.MIGRATE_DELAY()`와 같은 값이어야 한다** — 어긋나면 되돌릴 수도 없는데 티켓은 아직 안 넘어간 구간이 생긴다. 컨트랙트 테스트가 단언한다 |

**바뀐 동작**

| 이름 | 변경 |
|---|---|
| `rotateAccount(bytes32,address)` | 구 계정의 기기를 잠근다 — `DeviceLocked(oldAccount, true)`를 추가로 emit. `_rotatedFrom[personId]`에 구 계정을 기록한다 |

**새 이벤트 / 에러**

- `event RotationCancelled(bytes32 indexed personId, address indexed account)`
- `cancelRotation`은 `AccountRotated(personId, 새계정, 옛계정)`**도** emit 한다 — 인덱서의 "현재 계정" 로직은 그대로 두고 `RotationCancelled`만 감사 로그로 추가하면 된다.
- `cancelRotation`은 **`DeviceLocked`를 emit 하지 않는다.** 회전이 건 잠금은 취소해도 유지되고, 정상적인 `setActiveDevice` 경로로만 풀린다(설계 D2). 잠금 상태를 `DeviceLocked`로 추적하는 인덱서는 이 지점에서 아무것도 바꾸지 않아도 맞다.
- `error NoRotationToCancel()` — 취소 자격이 없거나(직전 계정이 아님) 24시간 창이 지났을 때 둘 다 이 에러다. 두 경우를 구분해 알려주면 어느 계정이 언제 회전했는지 흘리게 되므로 일부러 하나로 둔다.

### Organizers

| 이름 | 변경 |
|---|---|
| `revokeGate(uint256)` | `_gateOf[account]`를 지운다. 이후 `gateOf(account) == 0`, 그 주소는 **재등록 가능**, 페이마스터는 더는 스폰서하지 않는다. 스폰서됨(`ArgKind.Platform`) |
| `registerGate(uint256,address,bytes32,bytes32)` | `kx == 0 \|\| ky == 0`이면 `InvalidGateKey()` (이전: 둘 다 0일 때만) |

### MontiPaymaster

**새 함수**

| 시그니처 | 설명 |
|---|---|
| `setAllowed(bytes4 selector, uint8 kind, uint8 word)` | deployer 전용. `kind`는 `ArgKind` 열거형(0=None, 1=Platform, 2=EventId, 3=TokenId, 4=OrgId). `kind = 0`이 제거다 |
| `argWordOf(bytes4) view returns (uint8)` | 어떤 32바이트 워드가 id를 담는지 |

**새 이벤트**: `event SelectorAllowed(bytes4 indexed selector, uint8 kind, uint8 word)`

**허용 목록 추가 (ABI 변화는 아니지만 03/04가 알아야 하는 동작 변화)**

| 셀렉터 | ArgKind | word | 근거 |
|---|---|---|---|
| `checkInLate(uint256,(uint256,uint256,uint64,bytes32),bytes)` | TokenId | 0 | C1 |
| `cancelRotation()` | Platform | – | C3 |
| `revokeGate(uint256)` | Platform | – | I4 / T14 |
| `revoke(uint256,uint8)` | TokenId | 0 | I4 / §5.5 |
| `createOrganizer(address)` | Platform | – | I4 / §5.8 "주최자 되기" |
| `transferOwner(uint256,address)` | OrgId | 0 | I4 |

→ **03은 "이 네 개는 MON이 필요하다"는 제약(03 T30, R-F4)을 지운다.** 01b 이후 전부 가스리스다.

### 바뀌지 않는 것

`checkIn`, `claim`, `createOffer`, `cancelOffer`, `createEvent`, `updateEventMeta`, `publishEvent`, `cancelEvent`, `registerGate`, `openGate`, `closeGate`, `setAdmin`, `setManager`, `setActiveDevice`, `lockDevice`, `setNickname`, `manualOverride`, `transferFrom`/`safeTransferFrom`, `migrate` — **셀렉터 전부 동일**. `CheckedIn`, `Claimed`, `ManualOverride`, `Revoked`, `Migrated`, `OfferCreated`/`OfferCancelled`/`OfferAccepted`, `EventCreated`/`EventStatusChanged`/`EventMetaUpdated`, `Registered`/`AccountRotated`/`DeviceChanged`/`DeviceLocked`/`NicknameSet`/`KycLevelSet`, `GateRegistered`/`GateRevoked`/`GateOpened`/`GateClosed` — **topic0 전부 동일**.

### `@monti/shared` — 오프체인 절반 (컨트랙트만큼 중요하다)

**바뀐 함수**

| 파일 | 이전 | 이후 |
|---|---|---|
| `packages/shared/src/encoding.ts` | `offerDigest({ tokenId, recipientCommitment, recipientAccount })` → 원시 `keccak256(abi.encode(uint256,bytes32,address))` | `offerDigest({ chainId, ticket, tokenId, recipientCommitment, recipientAccount })` → viem `hashTypedData`로 만든 EIP-712 다이제스트. **인자 두 개가 늘어난다** |
| `packages/shared/src/encoding.hash.test.ts` | 고정 벡터 `0x90244cd7dea2e76fcbe10bb1f52ca2fe9bf143d9f9943bc8f792e664d052ed0a` | `ticket.offerDigest(...)`에서 새로 뽑은 벡터. 같은 `(tokenId, commitment, recipient)`라도 `chainId`·`ticket` 때문에 값이 달라진다 |

이 두 파일은 `MONTI-backend`·`MONTI-web`·`MONTI-staff` **세 곳에 사본이 있다**(`MONTI-prod`의 `packages/shared`에는 `abi/`만 있다). **컨트랙트와 같은 커밋에서 바꾸지 않으면 빌드는 초록인 채로 어테스터가 옛 다이제스트에 서명하고, 모든 `acceptOffer`가 런타임에 `BadAttesterSig`로 되돌아간다.** 그래서 Task 9가 셋 다 들고 간다.

**바뀌지 않는 것**: `recipientCommitment(hmacPhoneHex)`는 그대로다(`Ticket.createOffer`의 커밋먼트 모양은 손대지 않았다). `functions/src/functions/resolveRecipient.ts:61`의 호출도 **고치지 않는다.**

**새 상수** (`packages/shared/src/constants.ts`, `CODE_WINDOW_SECONDS = 60` 옆)

- `LATE_WINDOW_SECONDS = 43_200` ↔ `Ticket.LATE_WINDOW`
- `MIGRATE_DELAY_SECONDS = 86_400` ↔ `Ticket.MIGRATE_DELAY`

**ABI 이름 목록** (`packages/shared/src/abi.test.ts`): 이 테스트가 `arrayContaining`으로 정확한 집합을 단언하므로, 새 이름을 넣지 않으면 **빠져도 아무도 못 잡는다.** Ticket에 `checkInLate`·`offerDigest`·`eip712Domain`·`LATE_WINDOW`·`MIGRATE_DELAY`와 이벤트 `CheckedInLate`, Identity에 `cancelRotation`·`rotatedAt`·`rotatedFrom`과 이벤트 `RotationCancelled`, MontiPaymaster에 `setAllowed`·`argWordOf`와 이벤트 `SelectorAllowed`.

**인덱서 스키마** (`indexer/schema.graphql`, 세 저장소): `CheckIn` 엔티티(`id, gateId, ts, nonceHash, manual, txHash, block`)에 **`late: Boolean!`**을 더한다. 핸들러는 아직 하나도 없으므로 구현은 **02 T36으로 넘기는 항목**이고, 스키마 한 줄과 그 커밋된 테스트는 01b가 같이 옮긴다(Task 17).

**시드 입력** (`contracts/script/Seed.s.sol`): `seed(...)`가 `gateKx_`·`gateKy_` 두 인자를 더 받고, `run()`이 환경변수 **`SEED_GATE_KX`·`SEED_GATE_KY`**에서 읽는다. `MEMBER_FUND_WEI` 기본값은 0.02 → **0.1 MON**(Monad는 `gas_limit × 100 gwei`로 물리므로 0.02로는 데모 멤버의 `claim`이 안 나간다 — 2026-09-22 시드에서 실제로 `cast`로 손수 마무리해야 했다).

### 소비자별 적용 체크리스트 (실측 조사 결과)

**중요한 사실 하나: `packages/shared`는 하나가 아니라 넷이다.** 네 저장소가 각자 `contracts/`와 `packages/shared`를 들고 있고, 런타임에 공유되는 것은 없다.

| 저장소 | `packages/shared` 역할 | `abi.ts`·`encoding.ts` | `deployments/` |
|---|---|---|---|
| `MONTI-prod` | ABI 드롭 전용(이 플랜의 `export-abi.sh` 출력지). `package.json`도 `abi.ts`도 없고 `src/`에 `abi/`만 있다 | 없음 | 없음 |
| `MONTI-backend` | 완성된 `@monti/shared`. **정본(canonical)** — 다른 둘은 여기서 받아 간다 | 있음 | 있음 |
| `MONTI-web` | 완성된 `@monti/shared` (관객·주최자 웹) | 있음 | 있음 |
| `MONTI-staff` | 완성된 `@monti/shared` (플랜 04 스태프 단말기). `MONTI-web`의 완전한 동격이고, `checkInLate` 소비자가 여기 산다 | 있음 | 있음 |

→ **Task 13과 Task 15는 네 저장소를 전부 훑는다.** 한 곳만 하면 나머지가 옛 ABI·옛 주소로 남는다.

**그리고 `MONTI-backend/contracts`·`MONTI-web/contracts`·`MONTI-staff/contracts`는 prod의 서브모듈이 아니라 독립된 전체 사본이며, 오늘 이미 어긋나 있다** — `diff -rq`가 `Identity.sol`·`Ticket.sol`·`interfaces/ITicket.sol`·`libs/AttesterRole.sol`을 차이로 보고한다. 그 안에서 `export-abi.sh`를 돌리면 **옛 소스가 다시 내보내진다.** Task 13은 그래서 각 저장소에서 스크립트를 돌리지 않고 **prod가 만든 JSON 네 개를 복사**한다.

**02 (backend) — `MONTI-backend`**

1. `packages/shared/src/abi/*.json`을 **prod가 만든 네 개로 교체한다**(자기 `contracts/`에서 `export-abi.sh`를 돌리면 안 된다 — 그 사본은 오늘 이미 prod와 어긋나 있어 옛 소스를 다시 내보낸다).
2. **`packages/shared/src/abi.test.ts`의 함수·이벤트 이름 목록을 고친다.** 목록은 위 "`@monti/shared`" 절에 있다. 넣지 않으면 테스트는 통과하지만 **빠뜨린 걸 아무도 못 잡는다.**
3. `packages/shared/scripts/sync-deployments.mjs`로 새 `deployments/10143.json`을 가져온다. `packages/shared/src/constants.ts`의 `loadDeployment(chainId)`가 그대로 새 주소를 준다 — 코드 변경 없음.
4. `packages/shared/src/constants.ts:39`에 `CODE_WINDOW_SECONDS = 60` 옆으로 **`LATE_WINDOW_SECONDS = 43_200`**, `MIGRATE_DELAY_SECONDS = 86_400`을 추가한다.
5. **오퍼 다이제스트는 이미 구현돼 있고 반드시 같이 바뀌어야 한다.** `packages/shared/src/encoding.ts`의 `offerDigest()`가 지금 바로 재배포 전 원시 keccak 모양이고, `encoding.hash.test.ts`에 고정 벡터 `0x90244cd7…ed0a`가 박혀 있다. 새 시그니처는 `offerDigest({ chainId, ticket, tokenId, recipientCommitment, recipientAccount })`이고 본문은 viem `hashTypedData`다. **서명 프리미티브는 바뀌지 않는다**: `functions/src/lib/attester.ts`의 `signKeccak(digest, expectedAddress)`(KMS `EC_SIGN_SECP256K1_SHA256`)도 `getAttesterAccount().sign({ hash })`도 32바이트 다이제스트 하나를 받으므로, 새 다이제스트를 그대로 넘기면 KMS 경로·EOA 경로 모두 무수정으로 돈다. 아직 프로덕션 호출자는 없으므로 **서명 함수 자체는 처음부터 새 모양으로 짓는다.** `recipientCommitment()`와 그 호출부(`functions/src/functions/resolveRecipient.ts:61`)는 **고치지 않는다.**
6. 인덱서 핸들러는 **아직 하나도 구현돼 있지 않다**(`MONTI-backend/indexer/`에 `schema.graphql`과 그 테스트만 있다). 01b는 `schema.graphql`의 `CheckIn` 엔티티에 `late: Boolean!` 한 줄과 그 주석("`CheckedInLate`가 같은 트랜잭션에 오면 `late=true`")만 옮긴다(Task 17). 새 이벤트 `CheckedInLate`·`RotationCancelled`·`SelectorAllowed`의 핸들러는 **02 T36 인계 항목**이다.
7. 백엔드가 부르는 컨트랙트 함수 중 **시그니처가 바뀌는 것은 하나도 없다.** 읽기 18개: `eventOrg`, `ownerOf`(organizers), `managerOf`, `hasPermission`, `isOpenGate`, `gateOf`, `gateInfo`, `personOf`, `isMember`, `isLocked`, `kycLevelOf`, `deviceUpdatedAt`, `activeDevice`, `nicknameOwner`(`functions/src/functions/resolveRecipient.ts:83`), `eventMeta`, `tiers`, `eventOf`, `ownerOf`(ticket), `getAddress`. 쓰기 5개: `lockDevice`, `register`, `setKycLevel`, 그리고 `setAdmin`·`setManager`(`functions/src/functions/invites.ts:207,212`에서 calldata로 인코딩해 클라이언트에 넘긴다). ABI 재빌드만 하면 된다.

**03 (attendee/organizer web) — `MONTI-web`**

1. `packages/shared`는 02와 동일한 3단계(ABI 재생성 · `abi.test.ts` 목록 · `sync-deployments.mjs`).
2. **웹 런타임의 주소는 `loadDeployment`를 거치지 않는다.** `apps/web/src/shared/config.ts`가 `VITE_ADDR_IDENTITY`·`VITE_ADDR_ORGANIZERS`·`VITE_ADDR_TICKET`·`VITE_ADDR_PAYMASTER`를 `requiredEnv`로 읽는다 — **네 환경변수를 전부 새 주소로 갈아야 한다**(로컬 `.env`, 배포 환경 둘 다). 이걸 빠뜨리면 앱이 옛 컨트랙트를 조용히 계속 쓴다.
3. `apps/web/src/shared/chain/ops.ts`는 `functionName`을 그대로 통과시키는 제네릭 래퍼라(`ticketOp`/`identityOp`/`organizersOp`) **코드 변경이 없다**. 단 이 파일이 import 하는 `apps/web/src/shared/chain/abis.ts`는 아직 **빈 자리표시자**(`[] as const satisfies Abi`)이므로, 03 Task 9이 `@monti/shared`의 진짜 ABI로 교체할 때 01b 판본을 쓰면 된다.
4. `tokenURI`를 읽는 코드는 **웹에도 백엔드에도 하나도 없다** — I9의 소비자 영향은 0이다. 취소 뱃지는 `eventStatus`/Envio `Event.status`에서 파생하면 된다(03 Task 20).
5. **`createOrganizer`·`transferOwner`·`revokeGate`·`Ticket.revoke` 넷이 이제 전부 스폰서된다 — 주최자 플로우에 MON이 필요 없다.** 초안은 "03 T30의 제약을 삭제한다"고 적었는데 **그 제약은 애초에 03 플랜에 없다**(플랜 03에 `createOrganizer`·`transferOwner`·`revokeGate`·`R-F4` 검색 결과가 0이다). 지울 것이 없다는 뜻이자, **03이 그 제약을 들어본 적도 없다**는 뜻이므로, 제거가 아니라 **사실로 적어 넣는다**(Task 17).
6. `migrate`를 부르는 화면은 `RotationPending()`을 "N시간 후 사용 가능"으로 렌더한다. 남은 시간은 `identity.rotatedAt(personId) + MIGRATE_DELAY - now`.
7. 복구 화면은 `rotatedFrom(personId) == 내 주소 && now < rotatedAt + MIGRATE_DELAY`일 때만 "이 계정 교체를 되돌리기" 버튼을 띄운다. 되돌린 뒤에도 **기기 잠금은 남아 있으므로**, 이어서 "새 기기 등록"(`setActiveDevice`)을 안내해야 한다 — 마지막 기기 변경으로부터 7일이 안 지났으면 그 날짜까지 비활성으로 렌더한다(리뷰 Minor 9).

**04 (staff Android) — `MONTI-staff/apps/web/src/staff`**

경로 주의: 스태프 단말기 코드는 `MONTI-web`이 아니라 **`MONTI-staff`** 저장소에 산다(`MONTI-web`의 `apps/web/src/staff`에는 `Console.tsx` 스텁만 있다). 아래 파일은 전부 아직 존재하지 않는 04 산출물이므로, **고치는 대상은 코드가 아니라 플랜 04 문서다**(Task 17).

1. **T21** `apps/web/src/staff/gate/checkInOp.ts`: `encodeCheckInCall`/`sendCheckIn` 옆에 **`encodeCheckInLateCall`/`sendCheckInLate`**를 같은 모양으로 추가한다. 인자가 완전히 같으므로 `functionName`만 `'checkInLate'`로 바꾼 복제본이다. 현장 경로는 계속 `'checkIn'`을 쓴다.
2. **T28** `staff/queue/opQueue.ts`의 `drainQueue`가 부르는 것을 `sendCheckIn` → **`sendCheckInLate`**로 바꾼다. 이게 C1의 전부다 — 이 한 줄이 바뀌지 않으면 큐는 계속 `CodeExpired`로 되돌아온다.
3. **T29** `staff/queue/reconcile.ts`: `checkInOf` 반환에 `late` 필드가 생긴다(위치 디코드면 확인). `ReconcileReport`에 `late: number`를 더해 §12의 사후 대사 수치를 화면에 띄운다. `ALREADY_USED`를 충돌로 기록하는 로직은 그대로 맞다.
4. **T24** `staff/gate/verdict.ts`는 **바꿀 게 없다.** `checkInLate`도 `CheckedIn(uint256,uint256,uint256,bytes32,uint64)`을 똑같이 emit 하므로 topic0과 인덱스 토픽이 동일하다. 원하면 `CheckedInLate(uint256,uint256,uint64,uint64)` 구독을 더해 큐 흘림을 화면에 표시한다.
5. **T22** revert→DENY 맵에 추가: `NotMember` → `TX_FAILED`(§13에 대응 코드 없음), `RotationPending` → `TX_FAILED`. `checkInLate`가 내는 `CodeExpired`는 "다시 대세요"가 아니라 **"기록 창 만료 — 미기록"**으로 문구가 달라야 한다(현장이 아니라 대사 화면이다).
6. **T12** 게이트 키 WebAuthn 서명은 **low-s 정규화를 반드시 한다**(R-F2). 01b는 컨트랙트 쪽에 그 요구를 고정하는 테스트를 넣을 뿐, 클라이언트 정규화를 대신해 주지 않는다.
7. `packages/shared/src/constants.ts`의 `CODE_WINDOW_SECONDS`와 Solidity `CODE_WINDOW`는 이름이 다르다(04 플랜 5820행이 이미 지적). 새로 더하는 `LATE_WINDOW_SECONDS` ↔ `LATE_WINDOW`도 같은 관계다 — 값이 어긋나면 큐가 조용히 만료된다.

### 주소와 시작 블록

네 주소가 전부 바뀐다. `contracts/deployments/10143.json`이 단일 진실 원천이고 Task 15가 갱신한다. 인덱서의 시작 블록은 그 파일의 **`.block`** 필드다(`packages/shared/src/constants.ts:86`의 `Deployment.block` 주석: "01의 Deploy.s.sol 이 기록한 배포 블록. 인덱서의 start_block 이 된다"). 재배포 후 **반드시 새 값으로 올린다** — 옛 블록에서 시작하면 인덱서가 수만 블록을 헛돈다.

**지금 시점의 사실:** Envio `config.yaml`은 **아직 존재하지 않는다**(두 저장소 전수 검색 결과 0건). `start_block: ${deployment.block}`을 생성하는 `gen-config` 단계는 플랜 02 문서(7512·7526행)에만 있고 구현되지 않았다. 따라서 01b가 할 일은 **`deployments/10143.json`의 `.block`을 새 값으로 쓰고 세 저장소에 동기화하는 것까지**이며, 플랜 02가 나중에 `gen-config`를 쓸 때 자동으로 옳은 값을 읽게 된다. 이미 인덱싱을 시작한 상태라면 Envio 데이터베이스를 비우고(`envio stop && envio start --reset` 또는 상응하는 초기화) 새 블록부터 다시 돌린다.

---

## File Structure

실행 워크트리 `MONTI-01b` 안에서:

```
contracts/
  foundry.toml            code_size_limit = 131072  (Task 1)
  src/
    Ticket.sol              _admit 공유, checkInLate, OZ EIP712 상속 + offerDigest,
                            _update from-가드, tokenURI 취소 분기, migrate 타임락,
                            requestOverride 상태 검사
    Identity.sol            rotatedAt·rotatedFrom 뷰, ROTATION_UNDO_WINDOW, cancelRotation,
                            rotateAccount가 구 기기 잠금 + _rotatedFrom 기록
    Organizers.sol          revokeGate가 _gateOf 삭제, registerGate 키 검증 ||
    MontiPaymaster.sol      _seedSelectors 6개 추가, setAllowed/argWordOf/SelectorAllowed
    interfaces/IIdentity.sol  rotatedAt·rotatedFrom 추가
  test/
    TicketCheckIn.t.sol     고-s 거부(C2), NotMember 거부(I2)
    TicketCheckInLate.t.sol 신규 — C1 전체 + 늦은 경로 가스
    TicketTransfer.t.sol    잠긴/탈퇴 계정의 전송 거부(I1)
    TicketOffer.t.sol       EIP-712 다이제스트, 도메인 교차 거부(I8)
    TicketMigrate.t.sol     회전 타임락(C3), 취소 뒤에도 잠금 유지, 두 창 길이 일치
    TicketURI.t.sol         취소된 행사(I9)
    Identity.t.sol          rotateAccount 잠금(I2), cancelRotation 전체(C3)
    OrganizersGates.t.sol   revokeGate가 gateOf 해제(I3), 반쪽 0 키 거부(Minor 2)
    TicketOverride.t.sol    requestOverride 상태 검사(Minor 5)
    Paymaster.t.sol         새 셀렉터 6개, setAllowed 권한·제거·재허용
    ContractSize.t.sol      신규 — 런타임·이니트코드 131,072 B 미만 단언
  script/
    Deploy.s.sol            변경 없음(생성자 인자 불변) — 테스트만 갱신
    Seed.s.sol              게이트 키를 환경변수에서, MEMBER_FUND_WEI 0.1 MON, 데모 키 경고
    SizeProbe.s.sol         Task 15 Step 0 전용 폐기 프로브 — 커밋하지 않는다
  deployments/10143.json    Task 15가 새 주소와 새 block으로 덮어쓴다
packages/shared/src/abi/*.json   Task 13이 재생성
docs/superpowers/specs/2026-09-20-monti-nfc-ticketing-design.md   Task 16만 건드린다
docs/superpowers/plans/2026-09-20-monti-0{3,4}-*.md               Task 17만 건드린다
```

세 소비자 저장소(`MONTI-backend`·`MONTI-web`·`MONTI-staff`)에서:

```
packages/shared/src/abi/*.json         Task 13이 복사해 넣는다
packages/shared/src/abi.test.ts        Task 13 — 새 함수·이벤트 이름
packages/shared/src/constants.ts       Task 13 — LATE_WINDOW_SECONDS, MIGRATE_DELAY_SECONDS
packages/shared/src/encoding.ts        Task 9 — offerDigest가 EIP-712로
packages/shared/src/encoding.hash.test.ts  Task 9 — 새 고정 벡터
packages/shared/src/deployments/*.json Task 15 — sync-deployments.mjs
indexer/schema.graphql                 Task 17 — CheckIn.late
apps/web/.env (web·staff)              Task 15 — VITE_ADDR_* 네 개
```

---

## Task 1: 코드 크기 한도를 Monad의 것으로 맞춘다

**Files:**
- Modify: `contracts/foundry.toml` (`[profile.default]`)
- Test: `contracts/test/ContractSize.t.sol`은 Task 12에서 만든다. 이 Task의 검증은 아래 Step 3의 빌드다.

**Interfaces:**
- Consumes: 없음 (첫 태스크)
- Produces: `forge build`·`forge test`·`forge script`가 **131,072 B**를 한도로 쓴다. 이후 어떤 Task도 바이트를 아끼려고 설계를 바꾸지 않는다.

설계 D5를 읽고 시작한다. 요약: EIP-170의 24,576 B는 **체인의 한도가 아니다** — Monad는 128 KB를 받는다. 그 숫자를 강제하고 있던 것은 `forge build --sizes`의 보고(그리고 그것을 돌리는 `.github-checks.sh`), `forge test`/`forge script`가 쓰는 revm의 EIP-170 검사, 그리고 revm이 같은 값에서 유도하는 EIP-3860 이니트코드 상한, 셋뿐이다. 한 줄이 셋을 동시에 푼다.

- [ ] **Step 1: 지금 크기를 기록한다**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/MONTI-01b/contracts
forge build --sizes 2>&1 | grep -E "^\| (Ticket|MontiPaymaster|Organizers|Identity) "
```

기대(HEAD `f8e577d` 실측): `Ticket` 런타임 22,673 B / 이니트코드 23,429 B, `MontiPaymaster` 8,539 / 11,103, `Organizers` 3,975 / 4,034, `Identity` 4,068 / 4,312. 숫자가 다르면 브랜치가 `mvp-01b`(= `f8e577d`)가 아니다 — 멈추고 확인한다.

- [ ] **Step 2: `foundry.toml`에 한도를 명시한다**

`contracts/foundry.toml`의 `[profile.default]` 안, `bytecode_hash = "none"` 아래에 넣는다:

```toml
# Monad 는 런타임 128 KB 를 받는다. EIP-170 의 24,576 B 는 체인의 한도가 아니라 revm 기본값이고,
# forge build --sizes 의 여유 계산과 forge test/script 의 배포 검사, 그리고 거기서 유도되는
# EIP-3860 이니트코드 상한까지 그 하나의 값이 지배한다. 여기서 한 번 올려 셋을 같이 푼다.
# 이 값을 올린 대가로 Ticket 은 EIP-170 체인에는 배포할 수 없게 될 수 있다 — 의도한 선택이다.
code_size_limit = 131072
```

`[profile.ci]`는 `[profile.default]`를 상속하므로 따로 적지 않는다.

- [ ] **Step 3: 한도가 실제로 올라갔는지 확인한다**

```bash
forge config | grep -i code_size_limit
forge build --force --sizes 2>&1 | grep -E "^\| Ticket "
forge test
```

Expected: `code_size_limit = 131072`. `--sizes` 표의 `Runtime Margin`이 EIP-170 기준의 1,903 B가 아니라 **108,399 B**(131,072 − 22,673)로 바뀐다 — 그 숫자가 바뀌지 않으면 키가 먹지 않은 것이므로 Foundry 버전을 확인한다(≥ 1.8). `forge test`는 **260 passed**.

- [ ] **Step 4: 커밋**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/MONTI-01b
git add contracts/foundry.toml
git commit -m "chore(contracts): raise code_size_limit to Monad's 128 KB

EIP-170's 24,576 B was never the chain's limit; it was revm's default, and it
governed forge --sizes, the deploy check in test/script, and the EIP-3860
initcode bound derived from it. One key lifts all three, so nothing in 01b has
to trade design for bytes."
```

---

## Task 2: I9 — 취소된 행사의 티켓은 `취소됨`으로 읽힌다

**Files:**
- Modify: `contracts/src/Ticket.sol:483-488` (`tokenURI`의 status 파생)
- Test: `contracts/test/TicketURI.t.sol`

**Interfaces:**
- Consumes: Task 1의 `tokenURI`
- Produces: `tokenURI`가 `eventStatus(eventId) == EventStatus.Cancelled`를 **취소됨**으로 읽는다. 03은 뱃지를 `isRevoked`가 아니라 `eventStatus`에서 파생한다.

- [ ] **Step 1: 실패하는 테스트 세 개를 쓴다**

`contracts/test/TicketURI.t.sol`의 `test_isRevokedTracksTheVoidFlag` 바로 아래에 넣는다:

```solidity
    /// @dev 5.8 "행사 취소 시 티켓 일괄 취소". 일괄 revoke 트랜잭션 없이, 행사 상태에서 파생한다.
    function test_uriShowsCancelledAfterTheEventIsCancelled() public {
        assertEq(_statusOf(tokenId), NOT_ENTERED);
        vm.prank(ORG_OWNER);
        ticket.cancelEvent(eventId);
        assertEq(_statusOf(tokenId), CANCELLED);
    }

    /// @dev 행사 단위 무효가 티켓 단위 상태를 덮는다. 이미 들어간 티켓도 취소됨으로 읽힌다.
    function test_cancelledEventOutranksAnEnteredTicket() public {
        _tap();
        assertEq(_statusOf(tokenId), ENTERED);
        vm.prank(ORG_OWNER);
        ticket.cancelEvent(eventId);
        assertEq(_statusOf(tokenId), CANCELLED);
    }

    /// @dev 끝난 행사는 취소가 아니다. Ended 는 시간이 만든 상태이고, 취소는 주최자가 만든 상태다.
    function test_endedEventDoesNotReadAsCancelled() public {
        vm.warp(T0 + 3 days);
        assertEq(_statusOf(tokenId), NOT_ENTERED);
    }
```

- [ ] **Step 2: 실패를 확인한다**

Run: `forge test --match-path test/TicketURI.t.sol -vv`
Expected: `test_uriShowsCancelledAfterTheEventIsCancelled`와 `test_cancelledEventOutranksAnEnteredTicket`이 FAIL (`입장 전`/`입장 완료`가 나온다). `test_endedEventDoesNotReadAsCancelled`는 이미 PASS — 회귀 방지용이다.

- [ ] **Step 3: 최소 구현**

`contracts/src/Ticket.sol`의 `tokenURI` 안, 483~488행을 이렇게 바꾼다:

```solidity
        // 5.8: 행사가 취소되면 그 행사의 티켓은 전부 취소됨이다. 일괄 revoke 루프는 티켓 수만큼
        // 가스가 드는 무한 확장이라 애초에 선택지가 아니므로, 상태를 만들지 않고 파생한다.
        // 우선순위는 무효(티켓 단위) -> 취소(행사 단위) -> 입장 완료 -> 입장 전이다.
        string memory status = unicode"입장 전";
        if (_revoked[tokenId] || eventStatus(eventId) == EventStatus.Cancelled) {
            status = unicode"취소됨";
        } else if (_checkIns[tokenId].ts != 0) {
            status = unicode"입장 완료";
        }
```

- [ ] **Step 4: 통과를 확인한다**

Run: `forge test --match-path test/TicketURI.t.sol -vv`
Expected: PASS 전부.

- [ ] **Step 5: 전체 회귀와 크기**

```bash
forge test
```

Expected: **263 passed**, 0 failed.

- [ ] **Step 6: 커밋**

```bash
git add contracts/src/Ticket.sol contracts/test/TicketURI.t.sol
git commit -m "fix(contracts): a cancelled event's ticket reads 취소됨 (I9)"
```

---

## Task 3: I1 — 보내는 쪽 가드: 잠기거나 회전으로 밀려난 계정은 티켓을 못 보낸다

**Files:**
- Modify: `contracts/src/Ticket.sol:532-564` (`_update`)
- Test: `contracts/test/TicketTransfer.t.sol`

**Interfaces:**
- Consumes: `IIdentity.isMember`, `IIdentity.isLocked` (변경 없음)
- Produces: `transferFrom`/`safeTransferFrom`/`acceptOffer`가 보내는 쪽이 멤버가 아니면 `NotMember()`, 잠겼으면 `DeviceLocked()`로 되돌린다. **`migrate`는 영향받지 않는다.**

리뷰 I1: `_update`(`Ticket.sol:536-557`)는 `isMember(to)`와 `requireKyc(to)`만 보고 `from`은 한 번도 안 본다. PoC: ALICE가 §5.5 패닉 버튼 `identity.lockDevice(ALICE)`를 누르고도 `ticket.transferFrom(ALICE, BOB, tokenId)`에 성공한다. "내 기기 잠금"이 입장은 막고 자산은 안 막는다.

**가장 중요한 배치 규칙:** 이 가드는 반드시 `if (!_internalMove) { … }` **안**에 들어간다. `migrate`는 바로 그 "잠기고 탈퇴한 계정"에서 빼오는 동작이므로, 밖에 두면 복구 경로 자체가 죽는다.

**검사 순서도 고정한다:** `isMember` 먼저, `isLocked` 나중. 회전으로 밀려난 계정은 Task 4 이후 잠기기도 하므로, 순서를 뒤집으면 같은 상황이 Task 3에서는 `NotMember`, Task 4 뒤에는 `DeviceLocked`가 되어 테스트가 흔들린다. "너는 아직 너인가"를 "네 키가 얼었는가"보다 먼저 묻는다.

- [ ] **Step 1: 실패하는 테스트 세 개를 쓴다**

`contracts/test/TicketTransfer.t.sol` 끝에 넣는다:

```solidity
    /// @dev 5.5 패닉 버튼. 기기 잠금은 입장만이 아니라 자산도 얼린다.
    function test_lockedSenderCannotTransferOut() public {
        vm.prank(ALICE);
        identity.lockDevice(ALICE);

        vm.prank(ALICE);
        vm.expectRevert(Ticket.DeviceLocked.selector);
        ticket.transferFrom(ALICE, BOB, tokenId);
    }

    /// @dev 회전으로 밀려난 계정은 더 이상 멤버가 아니다. 새 계정이 migrate 하기 전에
    ///      옛 계정이 티켓을 빼돌릴 수 없어야 한다.
    function test_rotatedAwaySenderCannotTransferOut() public {
        vm.warp(T0 + 7 days);
        vm.prank(attester);
        identity.rotateAccount(bytes32(uint256(0xA1A1)), CAROL);

        vm.prank(ALICE);
        vm.expectRevert(Ticket.NotMember.selector);
        ticket.transferFrom(ALICE, BOB, tokenId);
    }

    /// @dev 잠금이 풀리면 보내는 쪽 가드를 통과한다. 그 뒤에 걸리는 것은 양도 마감이지
    ///      잠금이 아니다 — 가드가 마감 검사보다 앞에 놓인다는 사실까지 이 한 줄이 고정한다.
    ///      (새 기기 등록에 7일 쿨타임이 필요해 시계를 감으므로, 이 시점엔 마감이 이미 지났다.)
    function test_transferWorksAgainAfterTheLockIsCleared() public {
        vm.prank(ALICE);
        identity.lockDevice(ALICE);
        vm.warp(T0 + 7 days);
        vm.prank(ALICE);
        identity.setActiveDevice(DEV_X, DEV_Y);

        vm.prank(ALICE);
        vm.expectRevert(Ticket.TransferCutoffPassed.selector);
        ticket.transferFrom(ALICE, BOB, tokenId);
    }
```

**두 테스트가 `T0 + 7 days`로 감는 것이 배치를 결정한다.** 회전에는 7일 쿨타임이 필요한데, 그때쯤이면 이 픽스처의 양도 마감(`startsAt = T0 + 1 day`)은 이미 지나 있다. 그래서 보내는 쪽 가드는 **마감 검사보다 앞**에 놓는다 — 보내는 사람의 자격은 시점 문제가 아니라 신분 문제이므로 순서상으로도 그게 맞다.

- [ ] **Step 2: 실패를 확인한다**

Run: `forge test --match-path test/TicketTransfer.t.sol -vv`
Expected: `test_lockedSenderCannotTransferOut` FAIL(전송이 그냥 성공한다), `test_rotatedAwaySenderCannotTransferOut` FAIL(`NotMember` 대신 `TransferCutoffPassed`가 난다). 세 번째는 아직 통과해도 된다 — 가드가 생긴 뒤에도 같은 에러로 통과해야 한다는 회귀 고정이 그 역할이다.

- [ ] **Step 3: 최소 구현**

`contracts/src/Ticket.sol`의 `_update`, `if (!_internalMove) {` 바로 다음 줄에 두 줄을 넣는다:

```solidity
            if (!_internalMove) {
                // 보내는 쪽부터 본다. "내 기기 잠금"(5.5)은 입장만이 아니라 자산도 얼려야 하고,
                // 회전으로 밀려난 계정은 migrate 전에 티켓을 빼돌릴 수 없어야 한다(I1).
                // 이 두 줄이 _internalMove 분기 '안'에 있는 것이 중요하다: migrate 자신이
                // 바로 그 잠기고 탈퇴한 계정에서 빼오는 동작이므로, 밖에 두면 복구가 죽는다.
                // isMember 를 isLocked 보다 먼저 묻는다 — 회전은 둘 다 참으로 만들고,
                // 그때 알려줄 사실은 "계정이 바뀌었다"이지 "키가 얼었다"가 아니다.
                if (!identity.isMember(from)) revert NotMember();
                if (identity.isLocked(from)) revert DeviceLocked();

                EventMeta storage m = _events[eventId];
                if (_revoked[tokenId]) revert TicketRevoked();
```

(나머지 줄은 그대로 둔다.)

- [ ] **Step 4: 통과를 확인한다**

Run: `forge test --match-path test/TicketTransfer.t.sol -vv`
Expected: PASS 전부.

- [ ] **Step 5: 전체 회귀 — `migrate`가 안 깨졌는지가 핵심이다**

```bash
forge test
forge test --match-path test/TicketMigrate.t.sol -vv
```

Expected: **266 passed**, 0 failed. `TicketMigrate.t.sol` 전부 초록이어야 한다. 여기가 빨개지면 가드를 `_internalMove` 분기 밖에 넣은 것이다.

- [ ] **Step 6: 커밋**

```bash
git add contracts/src/Ticket.sol contracts/test/TicketTransfer.t.sol
git commit -m "fix(contracts): _update guards the sender too — locked or rotated-away cannot transfer out (I1)"
```

---

## Task 4: I2 — 회전이 옛 기기를 잠그고, `checkIn`이 보유자의 멤버십을 다시 본다

**Files:**
- Modify: `contracts/src/Identity.sol:80-99` (`rotateAccount`)
- Modify: `contracts/src/Ticket.sol:352` (`checkIn`의 보유자 검사)
- Test: `contracts/test/Identity.t.sol`, `contracts/test/TicketCheckIn.t.sol`

**Interfaces:**
- Consumes: 없음
- Produces: `rotateAccount`가 `DeviceLocked(oldAccount, true)`를 추가로 emit 한다. `checkIn`이 보유자가 멤버가 아니면 `NotMember()`로 되돌린다. Task 5의 `cancelRotation`이 이 잠금을 되돌린다.

리뷰 I2: `Ticket.sol:352-353`은 `identity.activeDevice(holder)`를 조건 없이 읽고, `Identity.sol:80-99`는 `_devices[oldAccount]`를 건드리지 않는다. 회전은 *폰을 잃어버려서* 하는 절차인데, 새 계정이 `migrate`를 부르기 전까지 **잃어버린 폰이 계속 입장한다**.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`contracts/test/Identity.t.sol`의 `test_rotateAccountTransfersNickname` 아래:

```solidity
    /// @dev 회전은 폰을 잃어버려서 하는 절차다(5.5). 잃어버린 폰은 그 순간부터 문에서 막힌다.
    function test_rotateAccountLocksTheOldDevice() public {
        vm.prank(ATTESTER);
        identity.register(PERSON_A, ALICE, DEV_X, DEV_Y, 1);
        assertFalse(identity.isLocked(ALICE));
        vm.warp(block.timestamp + 7 days);

        vm.prank(ATTESTER);
        identity.rotateAccount(PERSON_A, BOB);

        assertTrue(identity.isLocked(ALICE), "the lost phone is locked at rotation, not at migrate");
        assertFalse(identity.isLocked(BOB), "the new account is not locked");
    }

    /// @dev 이미 잠겨 있었으면 중복 이벤트를 내지 않는다.
    function test_rotateDoesNotRelockAnAlreadyLockedDevice() public {
        vm.prank(ATTESTER);
        identity.register(PERSON_A, ALICE, DEV_X, DEV_Y, 1);
        vm.prank(ALICE);
        identity.lockDevice(ALICE);
        vm.warp(block.timestamp + 7 days);

        vm.recordLogs();
        vm.prank(ATTESTER);
        identity.rotateAccount(PERSON_A, BOB);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 locks;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == keccak256("DeviceLocked(address,bool)")) ++locks;
        }
        assertEq(locks, 0, "already locked: no second DeviceLocked");
        assertTrue(identity.isLocked(ALICE));
    }
```

`Vm.Log`를 쓰므로 파일 상단 import를 `import {Test} from "forge-std/Test.sol";` 다음 줄에 추가한다:

```solidity
import {Vm} from "forge-std/Vm.sol";
```

`contracts/test/TicketCheckIn.t.sol`의 `test_T6_wrongDeviceKeyRejected` 위에:

```solidity
    /// @dev 회전 뒤 티켓은 잠시 옛 계정에 남아 있다(새 계정이 migrate 하기 전까지).
    ///      그 사이에 옛 폰이 걸어 들어오면 안 된다.
    function test_rotatedAwayHolderCannotCheckIn() public {
        vm.warp(P256Vectors.ISSUED_AT + 7 days);
        vm.prank(attester);
        identity.rotateAccount(bytes32(uint256(0xA1A1)), CAROL);
        vm.warp(P256Vectors.ISSUED_AT + 5);

        vm.prank(GATE_A);
        vm.expectRevert(Ticket.NotMember.selector);
        ticket.checkIn(tokenId, _code(gateAId), _sigA());
    }
```

(회전에 7일 쿨다운이 필요하므로 앞으로 감았다가, 코드 신선도 창을 맞추려고 다시 `ISSUED_AT + 5`로 되돌린다. `vm.warp`는 뒤로도 간다.)

- [ ] **Step 2: 실패를 확인한다**

Run: `forge test --match-path test/Identity.t.sol --match-test rotate -vv && forge test --match-path test/TicketCheckIn.t.sol --match-test rotatedAway -vv`
Expected: `test_rotateAccountLocksTheOldDevice` FAIL(`isLocked(ALICE)`가 false), `test_rotatedAwayHolderCannotCheckIn` FAIL(`DeviceLocked`가 나거나 그냥 통과한다).

- [ ] **Step 3: `Identity.rotateAccount` 최소 구현**

`contracts/src/Identity.sol`의 `emit AccountRotated(personId, oldAccount, newAccount);` **아래**에 붙인다(위가 아니다 — 기존 `vm.expectEmit` 테스트가 `AccountRotated`를 먼저 보기 때문이다):

```solidity
        emit AccountRotated(personId, oldAccount, newAccount);

        // 회전은 폰을 잃어버려서 하는 절차다(5.5). 잃어버린 폰이 Ticket.migrate 전까지 계속
        // 입장하던 구멍을 여기서 닫는다(I2). cancelRotation 이 이 잠금을 되돌린다.
        Device storage lost = _devices[oldAccount];
        if (!lost.locked) {
            lost.locked = true;
            emit DeviceLocked(oldAccount, true);
        }
```

- [ ] **Step 4: `Ticket.checkIn` 최소 구현**

`contracts/src/Ticket.sol`의 `if (identity.isLocked(holder)) revert DeviceLocked();` **바로 위**에 한 줄:

```solidity
        // 회전된 계정이 티켓을 아직 들고 있을 수 있다. 잠금만으로도 막히지만(I2가 회전 시
        // 잠그므로) 두 컨트랙트의 불변식을 서로에게 기대지 않도록 여기서도 직접 묻는다.
        if (!identity.isMember(holder)) revert NotMember();
        if (identity.isLocked(holder)) revert DeviceLocked();
```

- [ ] **Step 5: 통과와 전체 회귀**

```bash
forge test
```

Expected: **269 passed**, 0 failed. `checkIn` 가스가 조금 오르므로 `CheckInGasTest`의 로그 숫자도 확인한다(200k 한도에는 한참 못 미친다).

- [ ] **Step 6: 커밋**

```bash
git add contracts/src/Identity.sol contracts/src/Ticket.sol contracts/test/Identity.t.sol contracts/test/TicketCheckIn.t.sol
git commit -m "fix(contracts): rotation locks the lost phone and checkIn rechecks membership (I2)"
```

---

## Task 5: C3 — 회전 타임락과 `cancelRotation`

**Files:**
- Modify: `contracts/src/Identity.sol` (`rotatedAt` 뷰, `cancelRotation`, 새 이벤트·에러)
- Modify: `contracts/src/interfaces/IIdentity.sol` (`rotatedAt` 추가)
- Modify: `contracts/src/Ticket.sol:446-468` (`migrate` 타임락, `MIGRATE_DELAY`, `RotationPending`)
- Test: `contracts/test/Identity.t.sol`, `contracts/test/TicketMigrate.t.sol`

**Interfaces:**
- Consumes: Task 4의 회전 잠금
- Produces: `Identity.rotatedAt(bytes32) view returns (uint64)`, `Identity.cancelRotation()`, `Identity.RotationCancelled(bytes32,address)`, `Identity.NoRotationToCancel()`, `Ticket.MIGRATE_DELAY() = 1 days`, `Ticket.RotationPending()`. Task 11이 `cancelRotation`을 스폰서 목록에 넣는다.

설계 D2를 읽고 시작한다. 요약: 침해된 어테스터가 `rotateAccount` → `migrate` 두 번으로 미사용 티켓을 가져간다(리뷰 C3, PoC 7건 통과). 본인 서명을 요구할 수는 없다 — 회전은 폰을 잃어버려서 하는 절차다. 그래서 **조용한 즉시 절도를 눈에 보이고 되돌릴 수 있는 절도로 바꾼다.**

- [ ] **Step 1: `Identity` 쪽 실패 테스트를 쓴다**

`contracts/test/Identity.t.sol` 끝(`test_rotateAccountLocksTheOldDevice` 계열 아래)에:

```solidity
    function test_rotatedAtStampsRegistrationAndRotation() public {
        uint64 registeredAt = uint64(block.timestamp);
        vm.prank(ATTESTER);
        identity.register(PERSON_A, ALICE, DEV_X, DEV_Y, 1);
        assertEq(identity.rotatedAt(PERSON_A), registeredAt);

        vm.warp(block.timestamp + 7 days);
        uint64 rotatedAt = uint64(block.timestamp);
        vm.prank(ATTESTER);
        identity.rotateAccount(PERSON_A, BOB);
        assertEq(identity.rotatedAt(PERSON_A), rotatedAt);
    }

    /// @dev 6.3 T11. 어테스터가 털려도 직전 계정 본인이 하루 안에 되돌릴 수 있다.
    function test_cancelRotationRestoresTheOldAccount() public {
        vm.prank(ATTESTER);
        identity.register(PERSON_A, ALICE, DEV_X, DEV_Y, 1);
        vm.warp(block.timestamp + 7 days);
        vm.prank(ATTESTER);
        identity.rotateAccount(PERSON_A, BOB);
        assertTrue(identity.isMember(BOB));
        assertEq(identity.rotatedFrom(PERSON_A), ALICE, "the rotation records who it pushed aside");

        vm.expectEmit(true, true, true, false);
        emit AccountRotated(PERSON_A, BOB, ALICE);
        vm.expectEmit(true, true, false, false);
        emit RotationCancelled(PERSON_A, ALICE);
        vm.prank(ALICE);
        identity.cancelRotation();

        assertEq(identity.accountOf(PERSON_A), ALICE);
        assertTrue(identity.isMember(ALICE));
        assertFalse(identity.isMember(BOB));
        assertEq(identity.personOf(BOB), bytes32(0), "the other address is freed, not burned");
        assertEq(identity.rotatedFrom(PERSON_A), address(0), "one undo per rotation");
    }

    /// @dev 취소는 잠금을 풀지 않는다. 되살아난 계정은 정상적인 기기 변경 경로로만 다시 열린다 —
    ///      동기화된 패스키가 취소만으로 문을 열 수 있으면 T6 의 잔존 위험이 커진다.
    function test_cancelRotationLeavesTheRotationLockInPlace() public {
        vm.prank(ATTESTER);
        identity.register(PERSON_A, ALICE, DEV_X, DEV_Y, 1);
        vm.warp(block.timestamp + 7 days);
        vm.prank(ATTESTER);
        identity.rotateAccount(PERSON_A, BOB);
        assertTrue(identity.isLocked(ALICE));

        vm.prank(ALICE);
        identity.cancelRotation();
        assertTrue(identity.isLocked(ALICE), "the lock survives the undo");

        // 정상 경로로만 풀린다. 마지막 기기 변경이 7일 넘게 지났으므로 지금 바로 된다.
        vm.prank(ALICE);
        identity.setActiveDevice(DEV_X, DEV_Y);
        assertFalse(identity.isLocked(ALICE));
    }

    /// @dev 창이 닫히면 끝이다. 이게 없으면 _personOf 가 영원히 남는 성질 때문에
    ///      "그 사람이 지금까지 가져본 모든 계정"이 시한 없이 되돌릴 수 있게 된다.
    function test_cancelRotationClosesAfterTheUndoWindow() public {
        vm.prank(ATTESTER);
        identity.register(PERSON_A, ALICE, DEV_X, DEV_Y, 1);
        vm.warp(block.timestamp + 7 days);
        vm.prank(ATTESTER);
        identity.rotateAccount(PERSON_A, BOB);

        vm.warp(block.timestamp + identity.ROTATION_UNDO_WINDOW());
        vm.prank(ALICE);
        vm.expectRevert(Identity.NoRotationToCancel.selector);
        identity.cancelRotation();

        assertEq(identity.accountOf(PERSON_A), BOB, "the recovery stands");
    }

    /// @dev 두 번 회전한 뒤 가장 오래된 계정은 아무 권한도 없다. A 가 몇 년 뒤에 C 를 쫓아내
    ///      C 의 티켓을 얼려버리는 경로가 바로 이것이었다.
    function test_anOlderAccountCannotCancelALaterRotation() public {
        vm.prank(ATTESTER);
        identity.register(PERSON_A, ALICE, DEV_X, DEV_Y, 1);
        vm.warp(block.timestamp + 7 days);
        vm.prank(ATTESTER);
        identity.rotateAccount(PERSON_A, BOB);
        vm.warp(block.timestamp + 7 days);
        vm.prank(ATTESTER);
        identity.rotateAccount(PERSON_A, CAROL);

        assertEq(identity.rotatedFrom(PERSON_A), BOB, "only the immediately previous account");
        vm.prank(ALICE);
        vm.expectRevert(Identity.NoRotationToCancel.selector);
        identity.cancelRotation();
        assertEq(identity.accountOf(PERSON_A), CAROL);
    }

    /// @dev 취소해도 쿨다운 스탬프는 되감지 않는다. 공격자는 다음 시도까지 7일을 꼬박 기다린다.
    function test_cancelRotationDoesNotRewindTheCooldown() public {
        vm.prank(ATTESTER);
        identity.register(PERSON_A, ALICE, DEV_X, DEV_Y, 1);
        vm.warp(block.timestamp + 7 days);
        uint64 attemptedAt = uint64(block.timestamp);
        vm.prank(ATTESTER);
        identity.rotateAccount(PERSON_A, BOB);
        vm.prank(ALICE);
        identity.cancelRotation();

        assertEq(identity.rotatedAt(PERSON_A), attemptedAt);
        vm.prank(ATTESTER);
        vm.expectRevert(Identity.CooldownActive.selector);
        identity.rotateAccount(PERSON_A, BOB);
    }

    function test_cancelRotationTakesTheNicknameBack() public {
        vm.prank(ATTESTER);
        identity.register(PERSON_A, ALICE, DEV_X, DEV_Y, 1);
        bytes32 nick = keccak256(bytes("alice_01"));
        vm.prank(ALICE);
        identity.setNickname(nick, "alice_01");
        vm.warp(block.timestamp + 7 days);
        vm.prank(ATTESTER);
        identity.rotateAccount(PERSON_A, BOB);

        vm.prank(ALICE);
        identity.cancelRotation();

        assertEq(identity.nicknameOf(ALICE), nick);
        assertEq(identity.nicknameOwner(nick), ALICE);
        assertEq(identity.nicknameOf(BOB), bytes32(0));
    }

    function test_cancelRotationRejectsTheCurrentAccountAndStrangers() public {
        vm.prank(ATTESTER);
        identity.register(PERSON_A, ALICE, DEV_X, DEV_Y, 1);

        // 회전한 적이 없으므로 되돌릴 것도 없다.
        vm.prank(ALICE);
        vm.expectRevert(Identity.NoRotationToCancel.selector);
        identity.cancelRotation();

        vm.prank(BOB);
        vm.expectRevert(Identity.NotRegistered.selector);
        identity.cancelRotation();
    }

    /// @dev 회전으로 들어온 새 계정은 자기 회전을 스스로 되돌릴 수 없다.
    function test_theNewAccountCannotCancelItsOwnRotation() public {
        vm.prank(ATTESTER);
        identity.register(PERSON_A, ALICE, DEV_X, DEV_Y, 1);
        vm.warp(block.timestamp + 7 days);
        vm.prank(ATTESTER);
        identity.rotateAccount(PERSON_A, BOB);

        vm.prank(BOB);
        vm.expectRevert(Identity.NoRotationToCancel.selector);
        identity.cancelRotation();
    }
```

`CAROL`이 그 파일에 없으면 상단 상수 목록에 한 줄 추가한다: `address internal constant CAROL = address(0xCA);`

파일 상단 이벤트 선언 옆에 한 줄 추가:

```solidity
    event RotationCancelled(bytes32 indexed personId, address indexed account);
```

- [ ] **Step 2: 실패를 확인한다**

Run: `forge test --match-path test/Identity.t.sol -vv`
Expected: 컴파일 실패 — `rotatedAt`·`cancelRotation`·`NoRotationToCancel`이 없다. 그게 이 단계의 FAIL이다.

- [ ] **Step 3: `Identity` 최소 구현**

에러 목록에 한 줄 추가(`NicknameHashMismatch();` 아래):

```solidity
    error NoRotationToCancel();
```

이벤트 목록에 한 줄 추가(`event KycLevelSet(...)` 아래):

```solidity
    event RotationCancelled(bytes32 indexed personId, address indexed account);
```

상수와 매핑을 더한다(`DEVICE_COOLDOWN` 아래, `_rotatedAt` 옆):

```solidity
    /// @notice 회전을 되돌릴 수 있는 시간(6.3 T11). Ticket.MIGRATE_DELAY 와 같은 값이어야 한다 —
    ///         두 창이 어긋나면 되돌릴 수도 없는데 티켓은 아직 안 넘어간 구간이 생기거나, 반대로
    ///         티켓이 넘어간 뒤에도 되돌릴 수 있는 구간이 생긴다. TicketMigrate.t.sol 이 단언한다.
    uint256 public constant ROTATION_UNDO_WINDOW = 1 days;
```

```solidity
    mapping(bytes32 => uint64) private _rotatedAt;
    /// @dev 직전 회전에서 밀려난 계정 하나. cancelRotation 의 유일한 자격 조건이다.
    mapping(bytes32 => address) private _rotatedFrom;
```

`kycLevelOf` 아래에 뷰 두 개를 추가한다:

```solidity
    /// @notice 마지막 등록 또는 회전 시각. Ticket.migrate 의 타임락 기준이자 되돌리기 창의
    ///         시작점이며, 취소해도 되감기지 않아 어테스터가 7일 쿨다운을 다시 기다리게 만든다.
    function rotatedAt(bytes32 personId) external view returns (uint64) {
        return _rotatedAt[personId];
    }

    /// @notice 직전 회전에서 밀려난 계정. 되돌린 뒤에는 0이다. 03 의 복구 화면이 이것과
    ///         rotatedAt 으로 "지금 되돌릴 수 있는가"를 계산한다.
    function rotatedFrom(bytes32 personId) external view returns (address) {
        return _rotatedFrom[personId];
    }
```

`rotateAccount` 안, `_rotatedAt[personId] = uint64(block.timestamp);` 바로 아래에 한 줄:

```solidity
        _rotatedAt[personId] = uint64(block.timestamp);
        _rotatedFrom[personId] = oldAccount;
```

`rotateAccount` 아래에 `cancelRotation`을 추가한다:

```solidity
    /// @notice 6.3 T11: 어테스터 키가 털리면 본인 동의 없이 계정이 바뀔 수 있다. 밀려난 계정이 —
    ///         도둑이 가지고 있지 않은 바로 그 계정이 — ROTATION_UNDO_WINDOW 안에 직접 되돌린다.
    ///         폰을 정말 잃어버린 정상 복구에서는 아무도 이걸 부르지 않으므로, 창이 닫히면 새
    ///         계정이 예정대로 티켓을 가져간다.
    /// @dev    자격을 _personOf 로 판정하면 안 된다. 그 매핑은 밀려난 계정에서 영원히 지워지지
    ///         않으므로(:79 가 그렇게 설계했다 — migrate 가 옛 티켓에서 새 계정을 찾아야 한다),
    ///         "지금까지 가져본 모든 계정"이 시한 없이 되돌릴 수 있게 된다. A→B→C 뒤 A 가 C 를
    ///         쫓아내면 C 의 티켓은 전부 얼고(_update 의 NotMember) C 는 migrate 도 못 한다.
    ///         그래서 자격은 _rotatedFrom 한 칸(직전 계정)이고 창은 24시간이다.
    ///
    ///         쿨다운 스탬프(_rotatedAt)는 일부러 되감지 않는다: 거절된 회전도 어테스터에게
    ///         ROTATION_COOLDOWN 을 통째로 물리므로, 취소는 공격자가 따라잡을 루프가 아니다.
    ///
    ///         잠금도 일부러 풀지 않는다. 회전이 건 잠금(I2)이 그대로 남아야, 동기화된 패스키가
    ///         취소 하나로 문까지 여는 일이 없다. 본인은 setActiveDevice 라는 정상 경로로 푼다.
    ///
    ///         migrate 성공 시 _rotatedFrom 을 비울 필요는 없다: migrate 는 창이 닫힌 뒤에만,
    ///         cancelRotation 은 창이 열린 동안에만 통하므로 두 경로는 상호 배타다.
    ///
    ///         닉네임은 '지금 그 계정이 들고 있는 핸들'을 되가져온다. 새 계정이 그사이 이름을
    ///         바꿨다면 원래 핸들은 풀려 있으니 setNickname 을 한 번 더 누르면 된다.
    function cancelRotation() external {
        bytes32 personId = _personOf[msg.sender];
        if (personId == bytes32(0)) revert NotRegistered();
        // 자격 없음과 창 만료를 같은 에러로 둔다: 구분해 알려주면 어느 계정이 언제 회전했는지
        // 모르는 사람에게 흘리게 된다.
        if (_rotatedFrom[personId] != msg.sender) revert NoRotationToCancel();
        if (block.timestamp >= uint256(_rotatedAt[personId]) + ROTATION_UNDO_WINDOW) revert NoRotationToCancel();

        address current = _accountOf[personId];
        _accountOf[personId] = msg.sender;
        delete _personOf[current];
        delete _rotatedFrom[personId];

        bytes32 nick = _nicknameOf[current];
        if (nick != bytes32(0)) {
            delete _nicknameOf[current];
            _nicknameOf[msg.sender] = nick;
            _nicknameOwner[nick] = msg.sender;
        }

        emit AccountRotated(personId, current, msg.sender);
        emit RotationCancelled(personId, msg.sender);
    }
```

`contracts/src/interfaces/IIdentity.sol`에 두 줄 추가(`personOf` 아래):

```solidity
    function rotatedAt(bytes32 personId) external view returns (uint64);
    function rotatedFrom(bytes32 personId) external view returns (address);
```

- [ ] **Step 4: `Identity` 테스트 통과를 확인한다**

Run: `forge test --match-path test/Identity.t.sol -vv`
Expected: PASS 전부.

- [ ] **Step 5: `migrate` 타임락 테스트를 쓴다**

`contracts/test/TicketMigrate.t.sol`의 `_rotateAliceTo` 헬퍼를 고친다 — 기존 테스트 전부가 이걸 쓰므로 여기 한 곳만 고치면 된다:

```solidity
    /// @dev 회전에는 7일 쿨다운이, migrate 에는 그 뒤로 MIGRATE_DELAY(24시간)가 더 걸린다(C3).
    ///      타임락 자체를 보는 테스트는 아래 _rotateAliceToWithoutWaiting 을 쓴다.
    function _rotateAliceTo(address newAccount) internal {
        _rotateAliceToWithoutWaiting(newAccount);
        vm.warp(block.timestamp + ticket.MIGRATE_DELAY());
    }

    function _rotateAliceToWithoutWaiting(address newAccount) internal {
        vm.warp(T0 + 7 days);
        vm.prank(attester);
        identity.rotateAccount(bytes32(uint256(0xA1A1)), newAccount);
    }
```

그리고 새 테스트 세 개를 파일 끝에 넣는다:

```solidity
    /// @dev 6.3 T11: 침해된 어테스터가 계정을 바꿔도 티켓은 하루 동안 따라가지 않는다.
    function test_migrateBlockedUntilTheRotationTimelockPasses() public {
        _rotateAliceToWithoutWaiting(BOB);

        vm.prank(BOB);
        vm.expectRevert(Ticket.RotationPending.selector);
        ticket.migrate(tokenId);

        vm.warp(block.timestamp + ticket.MIGRATE_DELAY() - 1);
        vm.prank(BOB);
        vm.expectRevert(Ticket.RotationPending.selector);
        ticket.migrate(tokenId);

        vm.warp(block.timestamp + 1);
        vm.prank(BOB);
        ticket.migrate(tokenId);
        assertEq(ticket.ownerOf(tokenId), BOB);
    }

    /// @dev 되돌리면 절도가 끝난다. 도둑은 더 이상 그 personId 의 계정이 아니다.
    function test_cancelledRotationStopsTheMigrationForGood() public {
        _rotateAliceToWithoutWaiting(BOB);
        vm.prank(ALICE);
        identity.cancelRotation();
        vm.warp(block.timestamp + ticket.MIGRATE_DELAY());

        vm.prank(BOB);
        vm.expectRevert(Ticket.NotRotatedAccount.selector);
        ticket.migrate(tokenId);
        assertEq(ticket.ownerOf(tokenId), ALICE);
    }

    /// @dev 되돌리면 멤버십은 돌아오지만 잠금은 남는다. 그래서 되살아난 계정은 문에서도(I2)
    ///      양도에서도(I1) 여전히 막혀 있고, setActiveDevice 라는 정상 경로를 타야 풀린다.
    ///      "취소는 복구를 늦출 뿐 신원을 빼앗지 못한다"가 이 두 줄이다.
    function test_cancelledRotationRestoresMembershipButNotTheDevice() public {
        _rotateAliceToWithoutWaiting(BOB);
        vm.prank(ALICE);
        identity.cancelRotation();

        assertTrue(identity.isMember(ALICE));
        assertTrue(identity.isLocked(ALICE), "the rotation lock survives the undo");

        vm.prank(ALICE);
        vm.expectRevert(Ticket.DeviceLocked.selector);
        ticket.transferFrom(ALICE, BOB, tokenId);
    }

    /// @dev 두 창은 같은 길이여야 한다. 어긋나면 되돌릴 수도 없는데 티켓은 아직 안 넘어간
    ///      구간이 생기거나, 티켓이 넘어간 뒤에도 되돌릴 수 있는 구간이 생긴다.
    function test_theUndoWindowAndTheMigrateTimelockAreTheSameLength() public view {
        assertEq(ticket.MIGRATE_DELAY(), identity.ROTATION_UNDO_WINDOW());
    }
```

- [ ] **Step 6: 실패를 확인한다**

Run: `forge test --match-path test/TicketMigrate.t.sol -vv`
Expected: 컴파일 실패 — `ticket.MIGRATE_DELAY()`와 `Ticket.RotationPending`이 없다.

- [ ] **Step 7: `Ticket.migrate` 최소 구현**

상수 선언에 한 줄(`CLOCK_SKEW` 아래):

```solidity
    /// @notice 6.3 T11: 어테스터가 계정을 바꾼 뒤 티켓이 따라가기까지 본인에게 주는 유예.
    ///         본인은 Identity.cancelRotation() 으로 그 안에 되돌릴 수 있다.
    uint256 public constant MIGRATE_DELAY = 1 days;
```

에러 목록에 한 줄(`NothingToMigrate();` 아래):

```solidity
    error RotationPending();
```

`migrate` 안, `if (current == holder) revert NothingToMigrate();` 바로 아래:

```solidity
        if (current == holder) revert NothingToMigrate();
        // 침해된 어테스터의 조용한 즉시 절도를, 눈에 보이고 되돌릴 수 있는 절도로 바꾼다(C3).
        if (block.timestamp < uint256(identity.rotatedAt(personId)) + MIGRATE_DELAY) revert RotationPending();
```

- [ ] **Step 8: 전체 회귀**

```bash
forge test
```

Expected: 280 passed 내외, 0 failed.

- [ ] **Step 9: 커밋**

```bash
git add contracts/src/Identity.sol contracts/src/interfaces/IIdentity.sol contracts/src/Ticket.sol contracts/test/Identity.t.sol contracts/test/TicketMigrate.t.sol
git commit -m "feat(contracts): 24h rotation timelock and cancelRotation (C3)

A compromised attester can still rotate an account, but the tickets do not
follow for a day and the old account can undo it. Residual stated in the spec
patch: forged kycLevel, arbitrary registrations, mass device locks."
```

---

## Task 6: I3 — `revokeGate`가 게이트 주소를 놓아준다 (+ Minor 2 게이트 키 검증)

**Files:**
- Modify: `contracts/src/Organizers.sol:118-136` (`registerGate` 키 검증), `contracts/src/Organizers.sol:162-167` (`revokeGate`)
- Test: `contracts/test/OrganizersGates.t.sol`

**Interfaces:**
- Consumes: 없음
- Produces: `revokeGate` 뒤 `gateOf(account) == 0` — 페이마스터가 더는 그 계정을 스폰서하지 않고, 그 주소를 새 게이트로 다시 등록할 수 있다. `registerGate`가 반쪽 0 키를 거부한다.

리뷰 I3: `Organizers.sol:162-167`은 `revoked`/`open`만 세우고 `_gateOf[gateAccount]`를 남긴다. (a) `MontiPaymaster.sol:209`가 폐기된 계정을 영원히 스폰서된 송신자로 받아 — 도난당한 단말기가 되돌아가는 op 로 플랫폼 예치금을 계속 태울 수 있고, (b) `Organizers.sol:125`의 `GateAccountInUse` 때문에 그 주소는 **영구히 재등록 불가**다. 한 번 실수하면 스태프 단말기의 키를 새로 만들어야 한다. 둘 다 T14("관리자가 allowlist에서 빼면 끝")의 실효성을 깎는다.

리뷰 Minor 2: `Organizers.sol:124`는 `kx == 0 && ky == 0`만 막는다. 반쪽 0 키가 등록되면 §7.2 3단계의 관객 폰 게이트 서명 검증(T14 방어 ①)이 깨진다. `Identity.sol:62`는 둘 다 0이 아님을 요구한다 — 맞춘다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`contracts/test/OrganizersGates.t.sol` 끝에:

```solidity
    /// @dev T14 의 대응 수단은 revokeGate 다. 폐기된 게이트 계정은 페이마스터가 더 이상
    ///      스폰서하지 않아야 하고(gateOf == 0), 그 주소를 새 단말기로 다시 쓸 수 있어야 한다.
    function test_revokeGateReleasesTheAccount() public {
        uint256 gateId = _registerGate(GATE_A);
        assertEq(organizers.gateOf(GATE_A), gateId);

        vm.prank(ORG_OWNER);
        organizers.revokeGate(gateId);

        assertEq(organizers.gateOf(GATE_A), 0, "a revoked gate is no longer a sponsored sender");
        (,,,, bool open, bool revoked) = organizers.gateInfo(gateId);
        assertFalse(open);
        assertTrue(revoked, "the record survives; only the live mapping goes");
    }

    function test_aRevokedAccountCanBeRegisteredAgain() public {
        uint256 first = _registerGate(GATE_A);
        vm.prank(ORG_OWNER);
        organizers.revokeGate(first);

        uint256 second = _registerGate(GATE_A);
        assertGt(second, first, "a fresh gate id, not the old one");
        assertEq(organizers.gateOf(GATE_A), second);
        assertFalse(organizers.isOpenGate(eventId, GATE_A), "a fresh gate starts closed");
    }

    function test_theOldGateIdStaysRevokedAfterReRegistration() public {
        uint256 first = _registerGate(GATE_A);
        vm.prank(ORG_OWNER);
        organizers.revokeGate(first);
        _registerGate(GATE_A);

        vm.prank(ORG_OWNER);
        vm.expectRevert(Organizers.GateIsRevoked.selector);
        organizers.openGate(first);
    }

    /// @dev Minor 2. 반쪽 0 키는 관객 폰의 게이트 서명 검증(T14 방어 1)을 깬다. Identity 와 맞춘다.
    function test_registerGateRejectsAHalfZeroKey() public {
        vm.startPrank(ORG_OWNER);
        vm.expectRevert(Organizers.InvalidGateKey.selector);
        organizers.registerGate(eventId, GATE_A, bytes32(0), bytes32(uint256(0x6A02)));
        vm.expectRevert(Organizers.InvalidGateKey.selector);
        organizers.registerGate(eventId, GATE_A, bytes32(uint256(0x6A01)), bytes32(0));
        vm.stopPrank();
    }
```

`_registerGate(address)` 헬퍼가 그 파일에 없다면 파일 안 기존 등록 패턴을 그대로 쓰는 헬퍼를 하나 추가한다:

```solidity
    function _registerGate(address account) internal returns (uint256 gateId) {
        vm.prank(ORG_OWNER);
        gateId = organizers.registerGate(eventId, account, bytes32(uint256(0x6A01)), bytes32(uint256(0x6A02)));
    }
```

(기존 `setUp`의 `eventId`/`ORG_OWNER` 이름을 그대로 쓴다. 이름이 다르면 그 파일의 것을 따른다.)

- [ ] **Step 2: 실패를 확인한다**

Run: `forge test --match-path test/OrganizersGates.t.sol -vv`
Expected: `test_revokeGateReleasesTheAccount` FAIL(`gateOf`가 옛 id를 그대로 돌려준다), `test_aRevokedAccountCanBeRegisteredAgain` FAIL(`GateAccountInUse`), `test_registerGateRejectsAHalfZeroKey` FAIL(등록이 성공한다).

- [ ] **Step 3: 최소 구현**

`contracts/src/Organizers.sol` 124행:

```solidity
        if (kx == 0 || ky == 0) revert InvalidGateKey();
```

162~167행 `revokeGate`:

```solidity
    /// @notice T14 의 대응 수단. 도난당한 단말기를 여기서 끊는다.
    /// @dev    _gateOf 를 지우는 것이 핵심이다(I3): 남겨두면 (a) MontiPaymaster 가 폐기된 계정을
    ///         영원히 스폰서된 송신자로 받아 되돌아가는 op 로 예치금을 태울 수 있고, (b) 그 주소를
    ///         두 번 다시 게이트로 등록할 수 없다. 게이트 기록 자체(gateInfo)는 남으므로 지난
    ///         입장 기록의 gateId 는 계속 해석된다.
    function revokeGate(uint256 gateId) external {
        Gate storage g = _mutateGate(gateId);
        g.revoked = true;
        g.open = false;
        delete _gateOf[g.account];
        emit GateRevoked(gateId);
    }
```

- [ ] **Step 4: 통과와 전체 회귀**

```bash
forge test
```

Expected: 281 passed 내외, 0 failed. `TicketCheckIn.t.sol`의 `test_revokedGateRejected`가 여전히 초록이어야 한다(이제 `gateOf`가 0이라 `isOpenGate`가 false로 떨어지는 경로로 같은 `GateNotOpen`이 난다).

- [ ] **Step 5: 커밋**

```bash
git add contracts/src/Organizers.sol contracts/test/OrganizersGates.t.sol
git commit -m "fix(contracts): revokeGate releases the gate account; registerGate rejects half-zero keys (I3, Minor 2)"
```

---

## Task 7: C2 — 고-`s` 서명이 거부된다는 사실을 테스트로 못박는다

**Files:**
- Modify: `contracts/test/TicketCheckIn.t.sol`
- Test: 같은 파일 (컨트랙트 변경 **없음**)

**Interfaces:**
- Consumes: 없음
- Produces: 없음(ABI 불변). 이 Task의 산출물은 **불변식 하나가 고정되는 것**이다: `checkIn`은 low-`s` 서명만 받는다.

리뷰 C2: Solady의 `verifySignature`는 `s > N/2`를 거부한다(`lib/solady/src/utils/P256.sol:107`). Secure Enclave·Android Keystore·WebCrypto는 `s`를 균등하게 내므로 **정상 탭의 약 절반이 고-`s`**이고, 클라이언트가 정규화하지 않으면 그 절반이 `BadDeviceSignature` → 스태프 화면 DENY `DEVICE_MISMATCH`로 간다. 데모가 깨지는 가장 유력한 경로다.

테스트 스위트는 구조적으로 이걸 못 본다: `contracts/script/gen-p256-vectors.mjs:32`가 모든 벡터를 `{lowS: true}`로 만들어 `P256Vectors.sol` 전체가 low-`s`다. 그래서 22개 뮤테이션 중 M6(`verifySignature` → `verifySignatureAllowMalleability`)만 유일하게 살아남았다.

**벡터를 새로 만들 필요는 없다.** 유효한 `(r, s)`에 대해 `(r, N − s)`는 같은 메시지·같은 공개키에 대해 **암호학적으로 유효한** 서명이다(ECDSA malleability). 로컬 `osaka` EVM의 진짜 0x100 프리컴파일은 그것에 1을 돌려준다. 그래도 `checkIn`이 거부한다면 그 거부는 오직 Solady의 low-`s` 검사가 한 것이고, 그 검사를 지우면 이 테스트가 빨개진다 — **뮤테이션에 견디는 테스트**다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`contracts/test/TicketCheckIn.t.sol` 상단 import에 한 줄 추가:

```solidity
import {P256} from "solady/utils/P256.sol";
```

`test_T6_wrongDeviceKeyRejected` 위에 두 개를 넣는다:

```solidity
    /// @dev C2. (r, N - s) 는 같은 메시지·같은 키에 대해 암호학적으로 유효한 서명이라 0x100 은
    ///      1을 돌려준다. 그런데도 거절된다면 그 거절은 Solady 의 low-s 검사가 한 것이다 —
    ///      그 검사를 지우는 뮤테이션(M6)이 바로 이 테스트를 깨뜨린다.
    ///      이 요구는 클라이언트에도 그대로 간다: 03/04 는 서명 직후 s > N/2 면 s = N - s 로
    ///      정규화해야 한다. 안 하면 정상 탭의 절반이 DENY DEVICE_MISMATCH 로 떨어진다.
    function test_C2_highSSignatureRejected() public {
        uint256 highS = P256.N - uint256(P256Vectors.GATE1_S);
        assertGt(highS, P256.N / 2, "the counterpart of a low-s signature is high-s");

        vm.prank(GATE_A);
        vm.expectRevert(Ticket.BadDeviceSignature.selector);
        ticket.checkIn(tokenId, _code(gateAId), abi.encode(P256Vectors.GATE1_R, bytes32(highS)));
    }

    /// @dev 같은 벡터의 low-s 쪽은 통과한다. 위 테스트가 '서명이 틀려서'가 아니라 '고-s 라서'
    ///      거절됐음을 이 한 쌍이 함께 증명한다.
    function test_C2_theLowSCounterpartOfTheSameSignatureIsAccepted() public {
        assertLt(uint256(P256Vectors.GATE1_S), P256.N / 2, "the generated vectors are low-s by construction");
        vm.prank(GATE_A);
        ticket.checkIn(tokenId, _code(gateAId), _sigA());
        assertEq(ticket.checkInOf(tokenId).gateId, gateAId);
    }
```

- [ ] **Step 2: 뮤테이션으로 테스트가 진짜인지 확인한다 (이 Task의 핵심 단계)**

`contracts/src/Ticket.sol:358`을 **일시적으로** 바꾼다:

```solidity
        if (!P256.verifySignatureAllowMalleability(h, r, s, x, y)) revert BadDeviceSignature();
```

Run: `forge test --match-test test_C2_highSSignatureRejected -vv`
Expected: **FAIL** — 고-`s` 서명이 통과해 버린다. 이게 확인되어야 테스트가 형식이 아니라 실질이다.

그다음 **반드시 되돌린다**:

```solidity
        if (!P256.verifySignature(h, r, s, x, y)) revert BadDeviceSignature();
```

Run: `forge test --match-test test_C2 -vv`
Expected: PASS 둘 다.

- [ ] **Step 3: 전체 회귀**

Run: `forge test`
Expected: 283 passed 내외, 0 failed. `git diff contracts/src/Ticket.sol`에 뮤테이션 흔적이 없어야 한다.

- [ ] **Step 4: 커밋**

```bash
git add contracts/test/TicketCheckIn.t.sol
git commit -m "test(contracts): pin the low-s requirement that mutation M6 survived (C2)

(r, N - s) is a cryptographically valid signature the 0x100 precompile accepts;
checkIn must still refuse it. 03/04 normalise s before writing the NFC payload."
```

---

## Task 8: C1 — `checkInLate`, 오프라인 큐가 실제로 체인에 들어간다

**Files:**
- Modify: `contracts/src/Ticket.sol` (`CheckIn` 구조체, `LATE_WINDOW`, `CheckedInLate`, `checkIn`/`checkInLate`/`_admit`, `manualOverride`의 구조체 리터럴)
- Create: `contracts/test/TicketCheckInLate.t.sol`
- Test: 위 파일 + 기존 `contracts/test/TicketCheckIn.t.sol` 회귀

**Interfaces:**
- Consumes: Task 4의 `isMember(holder)` 검사, Task 6의 `revokeGate` 동작
- Produces: `Ticket.checkInLate(uint256,(uint256,uint256,uint64,bytes32),bytes)`, `Ticket.LATE_WINDOW() = 12 hours`, `Ticket.CheckedInLate(uint256,uint256,uint64,uint64)`, `CheckIn.late`. Task 11이 셀렉터를 스폰서 목록에 넣고, 04 T21/T28이 `sendCheckInLate`로 부른다.

**설계 D1을 먼저 읽는다.** 요약: 게이트 공동서명은 같은 키가 같은 사실을 두 번 말하는 것이라 기각했고, `checkIn`에 인자를 더하는 안은 현장 셀렉터를 갈아치우므로 기각했다. 남은 것이 "인자가 같고 시계만 다른 두 번째 함수"다.

- [ ] **Step 1: 실패하는 테스트 파일을 만든다**

`contracts/test/TicketCheckInLate.t.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {MontiTest} from "./Base.t.sol";
import {Ticket} from "../src/Ticket.sol";
import {P256} from "solady/utils/P256.sol";
import {P256Vectors} from "./utils/P256Vectors.sol";

/// @notice 스펙 12 의 오프라인 큐. 벡터가 event 1 / token 1 / gate 1 에 묶여 있으므로 각 시나리오는
///         자기 배포 위에서 그 세 id 를 처음부터 만든다. 행사 일정만 바꿔 가며 창의 양 끝을 본다.
abstract contract CheckInLateBase is MontiTest {
    uint256 internal orgId;
    uint256 internal eventId;
    uint256 internal tokenId;
    uint256 internal gateId;

    uint64 internal constant ISSUED = uint64(P256Vectors.ISSUED_AT);

    event CheckedIn(
        uint256 indexed tokenId, uint256 indexed eventId, uint256 indexed gateId, bytes32 nonceHash, uint64 ts
    );
    event CheckedInLate(uint256 indexed tokenId, uint256 indexed gateId, uint64 issuedAt, uint64 ts);

    /// @dev `_deployMonti` 가 시계를 T0 == P256Vectors.ISSUED_AT 으로 맞추므로, 여기서 만드는 것은
    ///      전부 코드가 발급된 바로 그 순간에 존재한다.
    function _setUpLate(uint64 startsAt, uint64 endsAt) internal {
        _deployMonti();
        _memberWithDeviceKey(ALICE, 0xA1A1);
        orgId = _org();

        Ticket.EventMeta memory m = Ticket.EventMeta({
            orgId: orgId,
            titleHash: keccak256("MONTI Late Night"),
            descHash: keccak256("an event the gate queued taps for"),
            imageCid: "bafyTestCid",
            startsAt: startsAt,
            endsAt: endsAt,
            venueHash: keccak256("Seoul"),
            saleStart: ISSUED - 1 days,
            saleEnd: ISSUED + 1 hours,
            transferable: true,
            transferCutoffSeconds: 600,
            maxTransfers: 1,
            approvalRequired: false,
            category: 0,
            regionCode: keccak256("KR-11"),
            requireKyc: false
        });
        Ticket.Tier[] memory t = new Ticket.Tier[](1);
        t[0] = Ticket.Tier({name: "General", priceUsdCents: 0, supply: 100, minted: 0, maxPerWallet: 1, seated: false});

        vm.startPrank(ORG_OWNER);
        eventId = ticket.createEvent(m, t);
        ticket.publishEvent(eventId);
        vm.stopPrank();

        vm.prank(ALICE);
        tokenId = ticket.claim(eventId, 0, "");

        vm.startPrank(ORG_OWNER);
        gateId = organizers.registerGate(eventId, GATE_A, bytes32(uint256(0x6A01)), bytes32(uint256(0x6A02)));
        organizers.openGate(gateId);
        vm.stopPrank();

        assertEq(eventId, P256Vectors.EVENT_ID, "vectors were generated for event 1");
        assertEq(tokenId, P256Vectors.TOKEN_ID, "vectors were generated for token 1");
        assertEq(gateId, P256Vectors.GATE1_ID, "vectors were generated for gate 1");
    }

    function _code() internal pure returns (Ticket.GateCode memory) {
        return Ticket.GateCode({
            gateId: P256Vectors.GATE1_ID,
            eventId: P256Vectors.EVENT_ID,
            issuedAt: P256Vectors.ISSUED_AT,
            nonce: P256Vectors.NONCE
        });
    }

    function _sig() internal pure returns (bytes memory) {
        return abi.encode(P256Vectors.GATE1_R, P256Vectors.GATE1_S);
    }
}

/// @notice 문이 코드 발급과 동시에 열린 행사. 창의 오른쪽 끝(제출 기한)을 본다.
contract TicketCheckInLateTest is CheckInLateBase {
    function setUp() public {
        _setUpLate(ISSUED, ISSUED + 6 hours);
    }

    /// @dev C1 의 핵심 회귀. 같은 코드·같은 서명이 현장 경로에서는 만료되고 큐 경로에서는 들어온다.
    function test_C1_aQueuedTapLandsAnHourLater() public {
        vm.warp(ISSUED + 1 hours);

        vm.prank(GATE_A);
        vm.expectRevert(Ticket.CodeExpired.selector);
        ticket.checkIn(tokenId, _code(), _sig());

        vm.expectEmit(true, true, false, true);
        emit CheckedInLate(tokenId, gateId, ISSUED, ISSUED + 1 hours);
        vm.expectEmit(true, true, true, true);
        emit CheckedIn(tokenId, eventId, gateId, keccak256(abi.encode(P256Vectors.NONCE)), ISSUED + 1 hours);
        vm.prank(GATE_A);
        ticket.checkInLate(tokenId, _code(), _sig());

        Ticket.CheckIn memory c = ticket.checkInOf(tokenId);
        assertEq(c.gateId, gateId);
        assertEq(c.ts, ISSUED + 1 hours);
        assertEq(c.nonceHash, keccak256(abi.encode(P256Vectors.NONCE)));
        assertFalse(c.manual, "a queued tap is not a manual override");
        assertTrue(c.late, "the record says the queue flushed it");
    }

    function test_theQueueStillFlushesAfterTheEventEnds() public {
        vm.warp(ISSUED + 6 hours + 11 hours);
        vm.prank(GATE_A);
        ticket.checkInLate(tokenId, _code(), _sig());
        assertTrue(ticket.checkInOf(tokenId).late);
    }

    function test_theFlushDeadlineIsExactlyLateWindowAfterTheEventEnds() public {
        vm.warp(ISSUED + 6 hours + 12 hours);
        vm.prank(GATE_A);
        ticket.checkInLate(tokenId, _code(), _sig());
        assertTrue(ticket.checkInOf(tokenId).late);
    }

    function test_oneSecondPastTheFlushDeadlineIsRejected() public {
        vm.warp(ISSUED + 6 hours + 12 hours + 1);
        vm.prank(GATE_A);
        vm.expectRevert(Ticket.EventEnded.selector);
        ticket.checkInLate(tokenId, _code(), _sig());
    }

    /// @dev 현장 경로는 폐장 순간 그대로 닫힌다. 넓어진 것은 기록 경로뿐이다.
    function test_theLiveDoorStillClosesAtEndsAt() public {
        vm.warp(ISSUED + 6 hours + 1);
        vm.prank(GATE_A);
        vm.expectRevert(Ticket.EventEnded.selector);
        ticket.checkIn(tokenId, _code(), _sig());
    }

    /// @dev 열림은 문을 여닫는 스위치이지 권한이 아니다. 닫힌 게이트도 자기 장부는 정리한다.
    function test_aClosedGateCanStillFlushItsQueue() public {
        vm.prank(ORG_OWNER);
        organizers.closeGate(gateId);
        vm.warp(ISSUED + 2 hours);

        vm.prank(GATE_A);
        vm.expectRevert(Ticket.GateNotOpen.selector);
        ticket.checkIn(tokenId, _code(), _sig());

        vm.prank(GATE_A);
        ticket.checkInLate(tokenId, _code(), _sig());
        assertTrue(ticket.checkInOf(tokenId).late);
    }

    /// @dev T14: 도난당한 단말기는 폐기하면 큐도 못 흘린다.
    function test_T14_aRevokedGateCannotFlush() public {
        vm.prank(ORG_OWNER);
        organizers.revokeGate(gateId);
        vm.warp(ISSUED + 2 hours);

        vm.prank(GATE_A);
        vm.expectRevert(Ticket.GateNotOpen.selector);
        ticket.checkInLate(tokenId, _code(), _sig());
    }

    /// @dev 게이트 id 는 다이제스트에 묶여 있다. 다른 게이트의 큐를 대신 흘릴 수 없다.
    function test_T13_aGateCannotFlushAnotherGatesQueue() public {
        vm.startPrank(ORG_OWNER);
        uint256 gateBId = organizers.registerGate(eventId, GATE_B, bytes32(uint256(0x6B01)), bytes32(uint256(0x6B02)));
        organizers.openGate(gateBId);
        vm.stopPrank();
        vm.warp(ISSUED + 2 hours);

        vm.prank(GATE_B);
        vm.expectRevert(Ticket.GateMismatch.selector);
        ticket.checkInLate(tokenId, _code(), _sig());
    }

    /// @dev T12: 04 의 큐는 이 revert 를 '이미 기록됨 = 성공'으로 처리한다.
    function test_T12_flushingAnAlreadyAdmittedTicketReverts() public {
        vm.warp(ISSUED + 5);
        vm.prank(GATE_A);
        ticket.checkIn(tokenId, _code(), _sig());

        vm.warp(ISSUED + 2 hours);
        vm.prank(GATE_A);
        vm.expectRevert(Ticket.AlreadyCheckedIn.selector);
        ticket.checkInLate(tokenId, _code(), _sig());
        assertFalse(ticket.checkInOf(tokenId).late, "the live record stands");
    }

    /// @dev T15: 단말기 혼자서는 큐 항목을 만들 수 없다. 관객 기기 서명이 여전히 필수다.
    function test_T15_theQueueStillNeedsTheAttendeeSignature() public {
        vm.warp(ISSUED + 2 hours);
        vm.prank(GATE_A);
        vm.expectRevert(Ticket.BadDeviceSignature.selector);
        ticket.checkInLate(tokenId, _code(), abi.encode(P256Vectors.OTHER_R, P256Vectors.OTHER_S));
    }

    /// @dev C2 의 요구는 늦은 경로에도 그대로 붙는다.
    function test_C2_highSRejectedOnTheLatePathToo() public {
        vm.warp(ISSUED + 2 hours);
        vm.prank(GATE_A);
        vm.expectRevert(Ticket.BadDeviceSignature.selector);
        ticket.checkInLate(
            tokenId, _code(), abi.encode(P256Vectors.GATE1_R, bytes32(P256.N - uint256(P256Vectors.GATE1_S)))
        );
    }

    function test_aCancelledEventRejectsTheQueueToo() public {
        vm.prank(ORG_OWNER);
        ticket.cancelEvent(eventId);
        vm.warp(ISSUED + 2 hours);

        vm.prank(GATE_A);
        vm.expectRevert(Ticket.EventCancelled.selector);
        ticket.checkInLate(tokenId, _code(), _sig());
    }

    /// @dev 앞선 시계는 두 경로 모두에서 위조다. CLOCK_SKEW 는 넓히지 않았다.
    function test_aFutureCodeIsStillAForgeryOnTheLatePath() public {
        vm.warp(ISSUED - 6);
        vm.prank(GATE_A);
        vm.expectRevert(Ticket.CodeExpired.selector);
        ticket.checkInLate(tokenId, _code(), _sig());
    }

    /// @dev 잠긴 기기는 두 경로 모두에서 막힌다(I1/I2 와 짝).
    function test_aLockedHolderIsRejectedOnTheLatePathToo() public {
        vm.prank(ALICE);
        identity.lockDevice(ALICE);
        vm.warp(ISSUED + 2 hours);

        vm.prank(GATE_A);
        vm.expectRevert(Ticket.DeviceLocked.selector);
        ticket.checkInLate(tokenId, _code(), _sig());
    }
}

/// @notice 문이 코드 발급보다 13시간 늦게 열리는 행사 — 즉 코드가 창이 열리기 전에 발급됐다.
///         넓은 창이 만드는 유일한 새 위험(게이트의 서명 사전 수확)을 issuedAt 하한이 막는다.
contract TicketCheckInLatePreHarvestTest is CheckInLateBase {
    function setUp() public {
        _setUpLate(ISSUED + 13 hours, ISSUED + 20 hours);
    }

    function test_aCodeIssuedBeforeTheWindowOpensIsRejected() public {
        vm.warp(ISSUED + 14 hours);
        vm.prank(GATE_A);
        vm.expectRevert(Ticket.CodeExpired.selector);
        ticket.checkInLate(tokenId, _code(), _sig());
    }
}

/// @notice 하한이 '<' 이지 '<=' 가 아님을 고정한다: 정확히 LATE_WINDOW 만큼 이른 코드는 받는다.
contract TicketCheckInLateBoundaryTest is CheckInLateBase {
    function setUp() public {
        _setUpLate(ISSUED + 12 hours, ISSUED + 20 hours);
    }

    function test_aCodeIssuedExactlyLateWindowBeforeDoorsIsAccepted() public {
        vm.warp(ISSUED + 13 hours);
        vm.prank(GATE_A);
        ticket.checkInLate(tokenId, _code(), _sig());
        assertTrue(ticket.checkInOf(tokenId).late);
    }
}
```

- [ ] **Step 2: 실패를 확인한다**

Run: `forge test --match-path test/TicketCheckInLate.t.sol -vv`
Expected: 컴파일 실패 — `checkInLate`, `CheckedInLate`, `CheckIn.late`가 없다.

- [ ] **Step 3: `Ticket` 구조체와 상수, 이벤트를 더한다**

`CheckIn` 구조체(55~60행)에 한 필드:

```solidity
    struct CheckIn {
        uint256 gateId;
        uint64 ts;
        bytes32 nonceHash;
        bool manual;
        /// @dev 스펙 12 의 오프라인 큐가 복구 후에 밀어 넣은 기록이다. manual 과 같은 슬롯에
        ///      들어가므로 저장 비용은 0이다.
        bool late;
    }
```

상수(75~76행 옆):

```solidity
    uint256 public constant CODE_WINDOW = 60;
    uint256 public constant CLOCK_SKEW = 5;
    /// @notice 스펙 12 의 오프라인 큐가 살 수 있는 시간. 큐에 담긴 코드는 개장 이 시간 전부터
    ///         유효하고, 큐는 폐장 이 시간 뒤까지 흘릴 수 있다. 현장 창(CODE_WINDOW)과 무관하다.
    uint256 public constant LATE_WINDOW = 12 hours;
```

이벤트(`event CheckedIn(...)` 아래):

```solidity
    /// @notice 큐에서 흘러들어온 입장. 같은 트랜잭션에서 CheckedIn 도 함께 나가므로, 입장 수를
    ///         세는 쪽은 CheckedIn 하나만 보면 되고 오프라인 비율을 세는 쪽만 이걸 본다(스펙 12).
    event CheckedInLate(uint256 indexed tokenId, uint256 indexed gateId, uint64 issuedAt, uint64 ts);
```

- [ ] **Step 4: `checkIn`을 `_admit`으로 쪼개고 `checkInLate`를 더한다**

`contracts/src/Ticket.sol`의 `checkIn` 전체(326~369행)를 이것으로 바꾼다:

```solidity
    /// @notice 스펙 7.2 6단계. 검사 순서: 티켓이 있고, 이 행사 것이고, 행사가 살아 있고, 티켓이
    ///         쓸 수 있고, 부르는 쪽이 이 행사의 열린 게이트이고, 코드가 신선하고, 기기 서명이
    ///         맞는가. 스태프 단말기가 이 에러들을 화면의 DENY 코드로 옮기므로(04) 이름이 ABI 다.
    function checkIn(uint256 tokenId, GateCode calldata g, bytes calldata deviceSig) external {
        _admit(tokenId, g, deviceSig, false);
    }

    /// @notice 스펙 12: 단말기가 인터넷을 잃으면 서명된 스냅샷으로 로컬 검증하고 "OFFLINE 승인"을
    ///         띄운 뒤 트랜잭션을 큐에 쌓아 복구 후 보낸다. 큐에 담긴 코드의 issuedAt 은 탭한
    ///         그때 그대로라 60초 창으로는 영영 들어올 수 없다(C1). 증명은 똑같다 — 관객 기기 키
    ///         서명이 여전히 필수이므로 단말기 혼자서는 만들 수 없다(T15). 다른 것은 시계뿐이다:
    ///         코드는 개장 LATE_WINDOW 전부터 유효하고, 제출은 폐장 LATE_WINDOW 후까지 받는다.
    ///         게이트가 '열려' 있을 필요는 없다 — 열림은 문을 여닫는 스위치이고, 늦은 제출은
    ///         문이 아니라 장부다. 폐기된 게이트는 여전히 어느 경로로도 못 쓴다(T14).
    /// @dev    이 경로는 현장 경로보다 느슨하므로 등록된 게이트는 60초 규칙을 피해 갈 수 있다.
    ///         얻을 것은 없고(관객은 어차피 들어오려던 참이다) 남는 것은 그리핑이며, 대응은 T14 와
    ///         같은 revokeGate 다. 며칠 전에 서명을 수확해 두는 공격은 issuedAt 하한이 막는다.
    function checkInLate(uint256 tokenId, GateCode calldata g, bytes calldata deviceSig) external {
        _admit(tokenId, g, deviceSig, true);
    }

    /// @dev 두 입장 경로의 공통 본문. 복사본을 두지 않는 이유는 크기가 아니라 안전이다:
    ///      두 경로의 검사 순서가 한 글자라도 갈라지면 한쪽에만 있는 구멍이 생긴다.
    function _admit(uint256 tokenId, GateCode calldata g, bytes calldata deviceSig, bool late) private {
        address holder = _ownerOf(tokenId);
        if (holder == address(0)) revert NoSuchTicket();

        uint256 eventId = _eventOf[tokenId];
        if (g.eventId != eventId) revert WrongEvent();

        EventMeta storage m = _events[eventId];
        // 살아 있는 토큰의 행사는 Published 이거나 Cancelled 뿐이다(claim 이 Published 만 받고
        // 상태는 Draft 로 되돌아가지 않는다). 그래서 eventStatus() 대신 두 가지만 직접 본다.
        if (_status[eventId] == EventStatus.Cancelled) revert EventCancelled();
        if (block.timestamp > uint256(m.endsAt) + (late ? LATE_WINDOW : 0)) revert EventEnded();
        if (_revoked[tokenId]) revert TicketRevoked();
        if (_checkIns[tokenId].ts != 0) revert AlreadyCheckedIn();

        if (late) {
            // 열려 있는지는 묻지 않는다. 폐기 여부는 묻는다(T14).
            (uint256 gateEventId,,,,, bool gateRevoked) = organizers.gateInfo(g.gateId);
            if (gateEventId != eventId || gateRevoked) revert GateNotOpen();
        } else if (!organizers.isOpenGate(eventId, msg.sender)) {
            revert GateNotOpen();
        }
        if (organizers.gateOf(msg.sender) != g.gateId) revert GateMismatch();

        // 게이트 폰의 시계는 체인보다 CLOCK_SKEW 초까지 앞설 수 있다. 그 너머는 위조다.
        if (g.issuedAt > block.timestamp + CLOCK_SKEW) revert CodeExpired();
        if (late) {
            // 개장 LATE_WINDOW 전보다 옛 코드는 받지 않는다. 넓은 창이 만드는 단 하나의 새 위험이
            // 게이트의 서명 사전 수확이고, 이 줄이 그것을 죽인다.
            if (uint256(g.issuedAt) + LATE_WINDOW < m.startsAt) revert CodeExpired();
        } else if (uint256(g.issuedAt) + CODE_WINDOW < block.timestamp) {
            revert CodeExpired();
        }

        if (!identity.isMember(holder)) revert NotMember();
        if (identity.isLocked(holder)) revert DeviceLocked();
        (bytes32 x, bytes32 y) = identity.activeDevice(holder);

        if (deviceSig.length != 64) revert BadDeviceSignature();
        bytes32 h = sha256(abi.encode(tokenId, g.gateId, g.eventId, g.nonce, g.issuedAt));
        (bytes32 r, bytes32 s) = abi.decode(deviceSig, (bytes32, bytes32));
        if (!P256.verifySignature(h, r, s, x, y)) revert BadDeviceSignature();

        bytes32 nonceHash = keccak256(abi.encode(g.nonce));
        _checkIns[tokenId] =
            CheckIn({gateId: g.gateId, ts: uint64(block.timestamp), nonceHash: nonceHash, manual: false, late: late});
        if (_offers[tokenId].from != address(0)) {
            delete _offers[tokenId];
            emit OfferCancelled(tokenId);
        }

        if (late) emit CheckedInLate(tokenId, g.gateId, g.issuedAt, uint64(block.timestamp));
        emit CheckedIn(tokenId, eventId, g.gateId, nonceHash, uint64(block.timestamp));
    }
```

`manualOverride`의 구조체 리터럴(420행)에 필드를 더한다:

```solidity
        _checkIns[tokenId] = CheckIn({
            gateId: gateId,
            ts: uint64(block.timestamp),
            nonceHash: bytes32(0),
            manual: true,
            late: false
        });
```

- [ ] **Step 5: 통과를 확인한다**

```bash
forge test --match-path test/TicketCheckInLate.t.sol -vv
forge test --match-path test/TicketCheckIn.t.sol -vv
```

Expected: 둘 다 PASS 전부. 기존 `TicketCheckIn.t.sol`의 22개 거부 경로가 하나도 안 깨져야 한다 — `_admit`으로 옮기면서 순서를 바꾸지 않았다는 증거다.

- [ ] **Step 6: 전체 회귀와 크기**

```bash
forge test
```

Expected: 299 passed 내외, 0 failed.

- [ ] **Step 7: 커밋**

```bash
git add contracts/src/Ticket.sol contracts/test/TicketCheckInLate.t.sol
git commit -m "feat(contracts): checkInLate so the offline queue can actually land (C1)

Same proof, wider clock: the code may be issued from LATE_WINDOW before doors,
and the flush may land up to LATE_WINDOW after the event ends. No gate
co-signature — the gate account is already that key. Records CheckIn.late and
emits CheckedInLate for spec 12's reconciliation."
```

---

## Task 9: I8 — 양도 승인 다이제스트에 EIP-712 도메인

**Files:**
- Modify: `contracts/src/Ticket.sol` (`EIP712` 상속, 타입해시 상수, `offerDigest`, `acceptOffer`)
- Modify: `MONTI-backend/packages/shared/src/encoding.ts`, `…/encoding.hash.test.ts`
- Modify: `MONTI-web/packages/shared/src/encoding.ts`, `…/encoding.hash.test.ts`
- Modify: `MONTI-staff/packages/shared/src/encoding.ts`, `…/encoding.hash.test.ts`
- Test: `contracts/test/TicketOffer.t.sol`, `contracts/test/TicketMigrate.t.sol` (서명 헬퍼 둘 다 갱신)

**Interfaces:**
- Consumes: 없음
- Produces: `Ticket.offerDigest(uint256,bytes32,address) view returns (bytes32)`와 ERC-5267 `eip712Domain()`. `acceptOffer`의 셀렉터는 그대로. 오프체인 `offerDigest({chainId, ticket, tokenId, recipientCommitment, recipientAccount})`가 같은 값을 낸다.

**온체인과 오프체인이 반드시 한 커밋에 들어간다.** `packages/shared/src/encoding.ts`가 이미 재배포 전 원시 keccak 모양을 구현하고 있고 `encoding.hash.test.ts`에 고정 벡터가 박혀 있다. 따로 고치면 **빌드는 초록인 채로** 어테스터가 옛 다이제스트에 서명하고 모든 `acceptOffer`가 런타임에 `BadAttesterSig`로 되돌아간다.

리뷰 I8: `Ticket.sol:318`의 다이제스트에는 chain id도, 검증 컨트랙트 주소도, EIP-191/712 접두도, 독립 만료도 없다. **같은 서명이 테스트넷·메인넷·모든 `Ticket` 재배포본에서 유효하다.** 이번 재배포가 정확히 그 "재배포본"이다. 어테스터는 오프라인 스냅샷용 원시 keccak 다이제스트에도 서명하므로, 접두 없는 메시지 계열이 두 개인 상태이기도 하다(현재 충돌은 구성 불가로 확인됨).

설계 D3: 크기 제약이 사라졌으므로(D5) OpenZeppelin `EIP712`를 그대로 상속한다. `EIP712("MONTI Ticket","1")`은 **생성자 인자가 아니라 기반 생성자 호출**이라 `Deploy.s.sol:90-102`가 한 글자도 바뀌지 않는다.

**오프체인 구현은 이미 있다.** `packages/shared/src/encoding.ts`의 `offerDigest()`가 바로 그 재배포 전 원시 keccak 모양이고, `encoding.hash.test.ts`에 고정 벡터 `0x90244cd7…ed0a`가 박혀 있다(`MONTI-backend`·`MONTI-web`·`MONTI-staff` 세 곳). 프로덕션 **호출자**는 아직 없으므로 서명 함수 자체는 처음부터 새 모양으로 지으면 되고, 서명 프리미티브(`lib/attester.ts`의 `signKeccak(digest, expectedAddress)`, `getAttesterAccount().sign({hash})`)는 32바이트 다이제스트 하나를 받으므로 **KMS 경로도 EOA 경로도 무수정이다.** 바꿀 것은 다이제스트를 만드는 그 함수와 벡터뿐이며, Step 3c·3d가 한 커밋 안에서 한다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`contracts/test/TicketOffer.t.sol`의 서명 헬퍼(28~32행 `_sig`)를 바꾼다:

```solidity
    function _sig(uint256 tokenId_, bytes32 commitment, address to) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ATTESTER_PK, ticket.offerDigest(tokenId_, commitment, to));
        return abi.encodePacked(r, s, v);
    }
```

(`pure` → `view`로 바뀐다. 파일 안에서 `_sig`를 부르는 곳은 그대로 둔다. 58행처럼 다이제스트를 직접 만드는 곳이 있으면 `ticket.offerDigest(...)`로 바꾼다.)

같은 변경을 `contracts/test/TicketMigrate.t.sol`의 `_attesterSig`(39~43행)에도 한다:

```solidity
    function _attesterSig(uint256 tokenId_, bytes32 commitment, address to) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ATTESTER_PK, ticket.offerDigest(tokenId_, commitment, to));
        return abi.encodePacked(r, s, v);
    }
```

그리고 `contracts/test/TicketOffer.t.sol` 끝에 도메인 분리 자체를 보는 테스트 세 개를 넣는다:

```solidity
    /// @dev I8. 다이제스트가 chain id 와 검증 컨트랙트 주소를 묶는지, EIP-712 정의대로 계산한
    ///      값과 한 바이트도 다르지 않은지 본다. 여기 쓰인 문자열이 곧 02 의 domain/types 다.
    function test_offerDigestIsTheEip712TypedDataHash() public view {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("MONTI Ticket"),
                keccak256("1"),
                block.chainid,
                address(ticket)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("TransferApproval(uint256 tokenId,bytes32 recipientCommitment,address recipient)"),
                tokenId,
                COMMITMENT,
                BOB
            )
        );
        assertEq(
            ticket.offerDigest(tokenId, COMMITMENT, BOB), keccak256(abi.encodePacked(hex"1901", domain, structHash))
        );
    }

    /// @dev 같은 (tokenId, commitment, recipient) 에 대한 서명이 다른 Ticket 배포본에서는 안 먹힌다.
    ///      재배포할 때마다 옛 서명이 죽는다는 것이 이 줄의 뜻이다.
    function test_aSignatureDoesNotCrossToAnotherTicketDeployment() public {
        Ticket other = new Ticket(address(identity), address(organizers));
        assertTrue(
            ticket.offerDigest(tokenId, COMMITMENT, BOB) != other.offerDigest(tokenId, COMMITMENT, BOB),
            "verifyingContract must be in the domain"
        );
    }

    /// @dev 체인이 다르면 다이제스트도 다르다. 테스트넷 서명이 메인넷에서 못 쓰인다.
    function test_aSignatureDoesNotCrossChains() public {
        bytes32 here = ticket.offerDigest(tokenId, COMMITMENT, BOB);
        vm.chainId(143);
        assertTrue(here != ticket.offerDigest(tokenId, COMMITMENT, BOB), "chainId must be in the domain");
    }
```

(`COMMITMENT`와 `tokenId`는 그 파일의 기존 이름이다 — 58행이 이미 쓰고 있다. 다르면 그 파일의 것을 따른다.)

- [ ] **Step 2: 실패를 확인한다**

Run: `forge test --match-path test/TicketOffer.t.sol -vv`
Expected: 컴파일 실패 — `offerDigest`가 없다.

- [ ] **Step 3: 최소 구현**

상속 목록과 생성자에 `EIP712`를 붙인다. `contracts/src/Ticket.sol` 상단 import에 한 줄:

```solidity
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
```

선언과 생성자:

```solidity
contract Ticket is ERC721, EIP712, ITicket {
```

```solidity
    constructor(address identity_, address organizers_)
        ERC721("MONTI Ticket", "MONTI")
        EIP712("MONTI Ticket", "1")
    {
        identity = IIdentity(identity_);
        organizers = IOrganizers(organizers_);
    }
```

`EIP712("MONTI Ticket","1")`은 **생성자 인자가 아니라 기반 생성자 호출**이므로 `Deploy.s.sol`의 `new Ticket(address(identity), address(organizers))`는 그대로다.

상수 옆(`LATE_WINDOW` 아래)에 타입해시 하나:

```solidity
    /// @dev I8: 양도 승인 서명에 도메인을 묶는다. 이게 없으면 같은 서명이 테스트넷·메인넷·모든
    ///      재배포본에서 유효하고, 어테스터가 접두 없는 메시지 계열 두 개(이것과 오프라인
    ///      스냅샷)에 서명하는 상태가 된다. 도메인 분리자는 OZ EIP712 가 들고 있고, chainid 가
    ///      캐시와 다르면 스스로 다시 계산하므로 포크에서도 맞다.
    bytes32 private constant _TRANSFER_APPROVAL_TYPEHASH =
        keccak256("TransferApproval(uint256 tokenId,bytes32 recipientCommitment,address recipient)");
```

`offerOf` 뷰 아래에 다이제스트 뷰를 추가한다:

```solidity
    /// @notice acceptOffer 가 검증하는 그 값. 어테스터(02)가 자기 서명을 교차검증하는 데 쓴다.
    /// @dev    만료나 nonce 를 넣지 않는다: 어테스터가 서명하는 사실은 "이 계정이 그 핸들의
    ///         주인이다"이고 그건 지속되는 사실이며, 오퍼의 만료는 이미 온체인 Offer.expiresAt
    ///         이 강제한다. 같은 세 값에 대한 재사용은 같은 사람에게만 유효하므로 피해가 없다.
    function offerDigest(uint256 tokenId, bytes32 recipientCommitment, address recipient)
        public
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(
            keccak256(abi.encode(_TRANSFER_APPROVAL_TYPEHASH, tokenId, recipientCommitment, recipient))
        );
    }
```

`acceptOffer`의 318~319행을 바꾼다:

```solidity
        bytes32 digest = offerDigest(tokenId, o.recipientCommitment, msg.sender);
        if (ECDSA.recover(digest, attesterSig) != identity.attester()) revert BadAttesterSig();
```

- [ ] **Step 3b: 새 고정 벡터를 뽑는다**

세 저장소의 오프체인 구현이 맞춰야 할 값을 컨트랙트에서 직접 읽는다. `contracts/test/TicketOffer.t.sol`에 임시 로그 테스트를 넣고 한 번 돌린 뒤 지운다:

```solidity
    function test_printTheVectorForEncodingTs() public view {
        emit log_named_bytes32(
            "offerDigest(7, 0x11*32, 0x..01)",
            ticket.offerDigest(7, bytes32(uint256(0x1111111111111111111111111111111111111111111111111111111111111111)), address(0x1))
        );
        emit log_named_uint("chainId", block.chainid);
        emit log_named_address("ticket", address(ticket));
    }
```

Run: `forge test --match-test test_printTheVectorForEncodingTs -vv`

세 값을 받아 적는다. 이 벡터는 **`chainId`와 `ticket` 주소에 묶이므로**, 테스트용으로는 그 둘을 고정값(체인 31337, 테스트가 찍어준 주소)으로 박아 두면 된다 — 재배포해도 이 단위 테스트는 흔들리지 않는다.

- [ ] **Step 3c: 세 저장소의 `encoding.ts`를 같은 모양으로 바꾼다**

`MONTI-backend`, `MONTI-web`, `MONTI-staff` 각각의 `packages/shared/src/encoding.ts`에서 `offerDigest`를 교체한다(`MONTI-prod`의 `packages/shared`에는 `abi/`만 있으므로 해당 없음):

```ts
/**
 * 어테스터가 acceptOffer 용으로 서명하는 다이제스트.
 * EIP-712 다. 도메인이 chainId 와 Ticket 주소를 묶으므로, 테스트넷 서명은 메인넷에서,
 * 옛 배포본의 서명은 새 배포본에서 쓸 수 없다. Ticket.offerDigest(...) 와 같은 값이어야 한다.
 */
export function offerDigest(input: {
  chainId: number;
  ticket: Hex;
  tokenId: bigint;
  recipientCommitment: Hex;
  recipientAccount: Hex;
}): Hex {
  assertBytes32(input.recipientCommitment, 'BAD_COMMITMENT');
  if (!/^0x[0-9a-fA-F]{40}$/.test(input.recipientAccount)) throw new Error('BAD_ACCOUNT');
  if (!/^0x[0-9a-fA-F]{40}$/.test(input.ticket)) throw new Error('BAD_TICKET');
  return hashTypedData({
    domain: {
      name: 'MONTI Ticket',
      version: '1',
      chainId: input.chainId,
      verifyingContract: input.ticket,
    },
    types: {
      TransferApproval: [
        { name: 'tokenId', type: 'uint256' },
        { name: 'recipientCommitment', type: 'bytes32' },
        { name: 'recipient', type: 'address' },
      ],
    },
    primaryType: 'TransferApproval',
    message: {
      tokenId: input.tokenId,
      recipientCommitment: input.recipientCommitment,
      recipient: input.recipientAccount,
    },
  });
}
```

`viem`에서 `hashTypedData`를 import 하고, 더 이상 쓰지 않으면 `encodeAbiParameters`/`parseAbiParameters` import를 정리한다(같은 파일의 다른 함수가 쓰고 있으면 그대로 둔다).

`recipientCommitment()`와 그 호출부(`functions/src/functions/resolveRecipient.ts:61`)는 **고치지 않는다.**

- [ ] **Step 3d: 세 저장소의 고정 벡터를 새 값으로 바꾼다**

각 `packages/shared/src/encoding.hash.test.ts`의 `describe('offerDigest')` 블록을 바꾼다:

```ts
describe('offerDigest', () => {
  // Ticket.offerDigest(...) 가 내는 바로 그 값. Step 3b 에서 컨트랙트로부터 뽑았다.
  const DOMAIN = { chainId: 31337, ticket: '0x<Step 3b 가 찍어준 주소>' as Hex };

  it('matches the fixed vector the attester signs for acceptOffer', () => {
    expect(
      offerDigest({
        ...DOMAIN,
        tokenId: 7n,
        recipientCommitment: ('0x' + '11'.repeat(32)) as Hex,
        recipientAccount: '0x0000000000000000000000000000000000000001' as Hex,
      }),
    ).toBe('0x<Step 3b 가 찍어준 다이제스트>');
  });

  it('changes when the chain changes', () => {
    const args = {
      ...DOMAIN,
      tokenId: 7n,
      recipientCommitment: ('0x' + '11'.repeat(32)) as Hex,
      recipientAccount: '0x0000000000000000000000000000000000000001' as Hex,
    };
    expect(offerDigest(args)).not.toBe(offerDigest({ ...args, chainId: 10143 }));
  });

  it('changes when the verifying contract changes', () => {
    const args = {
      ...DOMAIN,
      tokenId: 7n,
      recipientCommitment: ('0x' + '11'.repeat(32)) as Hex,
      recipientAccount: '0x0000000000000000000000000000000000000001' as Hex,
    };
    expect(offerDigest(args)).not.toBe(
      offerDigest({ ...args, ticket: '0x000000000000000000000000000000000000dEaD' as Hex }),
    );
  });
```

기존의 "changes when the recipient account changes" 등 나머지 케이스는 인자에 `...DOMAIN`만 더해 그대로 둔다.

Run(각 저장소에서): `npm test -w packages/shared`
Expected: PASS.

- [ ] **Step 4: 통과와 전체 회귀 — 네 곳 전부**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/MONTI-01b/contracts && forge test
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/MONTI-backend && npm test -w packages/shared
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/MONTI-web     && npm test -w packages/shared
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/MONTI-staff   && npm test -w packages/shared
```

Expected: Foundry 302 passed 내외, 0 failed — `TicketOffer.t.sol`의 기존 "잘못된 서명은 거부" 테스트들이 그대로 초록이어야 한다. 세 저장소의 `packages/shared` 테스트도 전부 초록.

Step 3b의 임시 로그 테스트(`test_printTheVectorForEncodingTs`)를 지웠는지 확인한다.

- [ ] **Step 5: 커밋 (저장소마다)**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/MONTI-01b
git add contracts/src/Ticket.sol contracts/test/TicketOffer.t.sol contracts/test/TicketMigrate.t.sol
git commit -m "feat(contracts): EIP-712 domain on the offer-acceptance digest (I8)

TransferApproval(uint256 tokenId,bytes32 recipientCommitment,address recipient)
under OZ EIP712 domain (MONTI Ticket, 1, chainId, verifyingContract). The
off-chain half moves in the same change set: packages/shared/src/encoding.ts
offerDigest() now takes chainId + ticket and hashes typed data, with a golden
vector regenerated from Ticket.offerDigest()."
```

세 소비자 저장소에서도 각각:

```bash
git add packages/shared/src/encoding.ts packages/shared/src/encoding.hash.test.ts
git commit -m "feat(shared): offerDigest is EIP-712 and binds chainId + ticket (01b I8)"
```

---

## Task 10: Minor 5 — `requestOverride`도 행사 상태를 본다

**Files:**
- Modify: `contracts/src/Ticket.sol:377-389` (`requestOverride`)
- Test: `contracts/test/TicketOverride.t.sol`

**Interfaces:**
- Consumes: 없음
- Produces: `requestOverride`가 끝났거나 취소된 행사에 대해 `EventEnded()`/`EventCancelled()`로 되돌린다. 04의 결재 요청 화면이 그 두 에러를 받는다.

리뷰 Minor 5: `manualOverride`(`:414-416`)는 행사 상태를 보는데 `requestOverride`(`:377`)는 안 본다. 취소되거나 끝난 행사에 결재 요청이 올라가고, 결재자는 승인할 수 없는 요청을 받는다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`contracts/test/TicketOverride.t.sol` 끝에:

```solidity
    /// @dev Minor 5. 승인할 수 없는 요청은 애초에 올라가지 않는다 — manualOverride 와 같은 기준이다.
    function test_requestOverrideRejectsAnEndedEvent() public {
        vm.warp(T0 + 3 days);
        vm.prank(MANAGER);
        vm.expectRevert(Ticket.EventEnded.selector);
        ticket.requestOverride(tokenId, gateId, 1);
    }

    function test_requestOverrideRejectsACancelledEvent() public {
        vm.prank(ORG_OWNER);
        ticket.cancelEvent(eventId);
        vm.prank(MANAGER);
        vm.expectRevert(Ticket.EventCancelled.selector);
        ticket.requestOverride(tokenId, gateId, 1);
    }
```

(`MANAGER`·`gateId`·`eventId`·`tokenId`는 그 파일의 기존 이름이다. 매니저 역할의 변수명이 다르면 그 파일의 것을 따른다.)

- [ ] **Step 2: 실패를 확인한다**

Run: `forge test --match-path test/TicketOverride.t.sol -vv`
Expected: 두 테스트 FAIL — 요청이 그냥 성공한다.

- [ ] **Step 3: 최소 구현**

`contracts/src/Ticket.sol`의 `requestOverride`에서, `if (_revoked[tokenId]) revert TicketRevoked();` 아래에 두 줄:

```solidity
        if (_revoked[tokenId]) revert TicketRevoked();
        // manualOverride 와 같은 기준이다: 승인할 수 없는 요청은 올라가지 않는다(Minor 5).
        EventStatus status = eventStatus(eventId);
        if (status == EventStatus.Ended) revert EventEnded();
        if (status == EventStatus.Cancelled) revert EventCancelled();
        (uint256 gateEventId,,,,,) = organizers.gateInfo(gateId);
```

- [ ] **Step 4: 통과와 전체 회귀**

```bash
forge test
```

Expected: 305 passed 내외, 0 failed.

- [ ] **Step 5: 커밋**

```bash
git add contracts/src/Ticket.sol contracts/test/TicketOverride.t.sol
git commit -m "fix(contracts): requestOverride checks the event status like manualOverride does (Minor 5)"
```

---

## Task 11: I4 — 페이마스터 허용 목록의 구멍과, 다시는 재배포하지 않아도 되는 세터

**Files:**
- Modify: `contracts/src/MontiPaymaster.sol` (`SelectorAllowed` 이벤트, `setAllowed`, `argWordOf`, `_seedSelectors` 6줄)
- Test: `contracts/test/Paymaster.t.sol`, `contracts/test/Deploy.t.sol`

**Interfaces:**
- Consumes: Task 5의 `Identity.cancelRotation`, Task 8의 `Ticket.checkInLate`
- Produces: `MontiPaymaster.setAllowed(bytes4,ArgKind,uint8)`, `MontiPaymaster.argWordOf(bytes4) view returns (uint8)`, `MontiPaymaster.SelectorAllowed(bytes4,uint8,uint8)`. 03은 "이 네 개는 MON이 필요하다" 제약을 지운다.

리뷰 I4: 스펙 §6.3 T14는 도난당한 단말기의 답이 "관리자가 allowlist에서 빼면 끝"이라고 하고, §5.8은 "주최자 되기"를 관객이 시작하는 흐름으로, §5.5/§5.8은 티켓 취소와 행사 취소를 든다. 그런데 `revokeGate`, `Ticket.revoke`, `createOrganizer`, `transferOwner` 넷 다 스폰서되지 않아 **주최자가 이미 MON을 들고 있어야** 한다. 그리고 R-PM6의 구조적 귀결: 허용 목록은 생성자에 박혀 있고 **세터가 없어서**, 목록 한 줄을 바꾸려면 네 컨트랙트를 전부 다시 올려야 한다.

**`createOrganizer`를 스폰서하는 것의 잔존 위험을 분명히 한다.** 그 함수에는 인증이 없다 — 어떤 멤버든 무제한으로 조직을 만들 수 있고, 가스는 MONTI가 낸다. 레이트 리밋은 post-MVP다(I7, R-F5). 대신 **`setAllowed`가 즉시 정지 스위치**다: 남용이 보이면 재배포 없이 한 트랜잭션으로 그 셀렉터를 끈다. 운영 항목: 예치금을 작게 유지하고 `budgetOf(0)`을 감시한다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`contracts/test/Paymaster.t.sol`에 이벤트 선언을 추가하고(상단 이벤트 목록 옆):

```solidity
    event SelectorAllowed(bytes4 indexed selector, uint8 kind, uint8 word);
```

파일 끝에 테스트를 넣는다:

```solidity
    /// @dev I4. T14 의 대응 수단과 5.8 의 "주최자 되기"가 가스리스가 된다.
    function test_theFourMissingSelectorsAreSponsored() public view {
        assertTrue(paymaster.allowedSelector(bytes4(keccak256("revokeGate(uint256)"))), "revokeGate");
        assertTrue(paymaster.allowedSelector(bytes4(keccak256("revoke(uint256,uint8)"))), "Ticket.revoke");
        assertTrue(paymaster.allowedSelector(bytes4(keccak256("createOrganizer(address)"))), "createOrganizer");
        assertTrue(paymaster.allowedSelector(bytes4(keccak256("transferOwner(uint256,address)"))), "transferOwner");

        assertEq(
            uint8(paymaster.argKindOf(bytes4(keccak256("revokeGate(uint256)")))),
            uint8(MontiPaymaster.ArgKind.Platform),
            "a gateId resolves to a project only through a second lookup: MONTI pays"
        );
        assertEq(uint8(paymaster.argKindOf(bytes4(keccak256("revoke(uint256,uint8)")))), uint8(MontiPaymaster.ArgKind.TokenId));
        assertEq(
            uint8(paymaster.argKindOf(bytes4(keccak256("createOrganizer(address)")))),
            uint8(MontiPaymaster.ArgKind.Platform)
        );
        assertEq(
            uint8(paymaster.argKindOf(bytes4(keccak256("transferOwner(uint256,address)")))),
            uint8(MontiPaymaster.ArgKind.OrgId)
        );
    }

    /// @dev C1 과 C3 의 새 진입점도 가스리스여야 한다. 큐를 흘리는 것도, 도둑맞은 계정을
    ///      되돌리는 것도 사용자가 MON 을 들고 있어야 하는 일이 아니다.
    function test_theNewEntryPointsAreSponsored() public view {
        bytes4 late = bytes4(keccak256("checkInLate(uint256,(uint256,uint256,uint64,bytes32),bytes)"));
        assertTrue(paymaster.allowedSelector(late), "checkInLate");
        assertEq(uint8(paymaster.argKindOf(late)), uint8(MontiPaymaster.ArgKind.TokenId));
        assertEq(paymaster.argWordOf(late), 0);

        bytes4 cancel = bytes4(keccak256("cancelRotation()"));
        assertTrue(paymaster.allowedSelector(cancel), "cancelRotation");
        assertEq(uint8(paymaster.argKindOf(cancel)), uint8(MontiPaymaster.ArgKind.Platform));
    }

    /// @dev R-PM6 의 구조적 귀결을 끝낸다: 다음부터 허용 목록 변경은 재배포가 아니다.
    function test_deployerCanAddAndRemoveASelector() public {
        bytes4 sel = bytes4(keccak256("setNickname(bytes32,string)"));
        assertTrue(paymaster.allowedSelector(sel));

        vm.expectEmit(true, false, false, true);
        emit SelectorAllowed(sel, uint8(MontiPaymaster.ArgKind.None), 0);
        paymaster.setAllowed(sel, MontiPaymaster.ArgKind.None, 0);
        assertFalse(paymaster.allowedSelector(sel), "None removes it — the kill switch");

        paymaster.setAllowed(sel, MontiPaymaster.ArgKind.Platform, 0);
        assertTrue(paymaster.allowedSelector(sel), "and it comes back");
    }

    function test_setAllowedRecordsTheArgumentWord() public {
        bytes4 sel = bytes4(keccak256("transferFrom(address,address,uint256)"));
        assertEq(paymaster.argWordOf(sel), 2, "the tokenId is the third word");

        paymaster.setAllowed(sel, MontiPaymaster.ArgKind.TokenId, 1);
        assertEq(paymaster.argWordOf(sel), 1);
    }

    function test_onlyTheDeployerCanChangeTheAllowlist() public {
        vm.prank(ALICE);
        vm.expectRevert(MontiPaymaster.Unauthorized.selector);
        paymaster.setAllowed(bytes4(keccak256("whatever()")), MontiPaymaster.ArgKind.Platform, 0);
    }
```

**그리고 기존 단언 두 개를 뒤집는다.** `contracts/test/Paymaster.t.sol` 200행과 212·219행:

```solidity
        // 200행: 이전 assertFalse(... "createOrganizer(address)") -> 이제 스폰서된다
        assertTrue(paymaster.allowedSelector(bytes4(keccak256("createOrganizer(address)"))));
```

```solidity
        // 212행: 이전 assertFalse(Ticket.revoke.selector, "revoke is not sponsored")
        assertTrue(paymaster.allowedSelector(Ticket.revoke.selector), "revoke is sponsored (I4)");
        // 219행: 이전 ArgKind.None
        assertEq(uint8(paymaster.argKindOf(Ticket.revoke.selector)), uint8(MontiPaymaster.ArgKind.TokenId));
```

- [ ] **Step 2: 실패를 확인한다**

Run: `forge test --match-path test/Paymaster.t.sol -vv`
Expected: 컴파일 실패(`setAllowed`·`argWordOf` 없음) 그리고 새 단언들 FAIL.

- [ ] **Step 3: 최소 구현**

`contracts/src/MontiPaymaster.sol` 이벤트 목록에 한 줄(`event StakeWithdrawn(...)` 아래):

```solidity
    event SelectorAllowed(bytes4 indexed selector, uint8 kind, uint8 word);
```

`allowedSelector` 아래에 두 함수를 추가한다:

```solidity
    function argWordOf(bytes4 selector) external view returns (uint8) {
        return _argWord[selector];
    }

    /// @notice 허용 목록의 유일한 변경 경로. 지금까지는 생성자에만 있었던 탓에(R-PM6) 셀렉터 한
    ///         줄을 바꾸려면 네 컨트랙트를 전부 다시 올려야 했다(I4). `kind` 를 `None` 으로 주면
    ///         제거이며, 그것이 남용되는 셀렉터를 재배포 없이 끄는 정지 스위치다(I7 완화).
    /// @dev    새로 열리는 실질 위험은 없다: deployer 는 이미 withdrawPlatform 과 addStake 를
    ///         쥐고 있고, 대상 컨트랙트는 여전히 Ticket/Identity/Organizers 세 개로 제한되며,
    ///         그 안의 모든 함수는 자기 권한 검사를 그대로 갖는다.
    function setAllowed(bytes4 selector, ArgKind kind, uint8 word) external {
        if (msg.sender != deployer) revert Unauthorized();
        argKindOf[selector] = kind;
        _argWord[selector] = word;
        emit SelectorAllowed(selector, uint8(kind), word);
    }
```

`_seedSelectors`에 여섯 줄을 더한다:

```solidity
        // Ticket — gate
        _allow("checkIn(uint256,(uint256,uint256,uint64,bytes32),bytes)", ArgKind.TokenId);
        _allow("checkInLate(uint256,(uint256,uint256,uint64,bytes32),bytes)", ArgKind.TokenId);
        _allow("requestOverride(uint256,uint256,uint8)", ArgKind.TokenId);
        _allow("manualOverride(uint256,uint256,uint8)", ArgKind.TokenId);
        // 5.5: 주최자가 티켓을 무효화하는 것도, T14 의 답인 게이트 폐기도 MON 을 요구하지 않는다.
        _allow("revoke(uint256,uint8)", ArgKind.TokenId);
```

`Organizers` 묶음에:

```solidity
        _allow("openGate(uint256)", ArgKind.Platform);
        _allow("closeGate(uint256)", ArgKind.Platform);
        // gateId 는 두 번째 조회를 거쳐야 프로젝트가 나오므로 openGate/closeGate 와 같은 칸이다.
        _allow("revokeGate(uint256)", ArgKind.Platform);
        // 5.8 "주최자 되기"는 관객이 시작하는 흐름이다. 이 함수에는 인증이 없으므로 남용 가능성이
        // 남고(I7), 남용이 보이면 setAllowed 로 끈다.
        _allow("createOrganizer(address)", ArgKind.Platform);
        _allow("transferOwner(uint256,address)", ArgKind.OrgId);
        _allow("setAdmin(uint256,address,uint32)", ArgKind.OrgId);
        _allow("setManager(uint256,address,bool,bool)", ArgKind.OrgId);
```

`Identity` 묶음에:

```solidity
        _allow("setActiveDevice(bytes32,bytes32)", ArgKind.Platform);
        _allow("lockDevice(address)", ArgKind.Platform);
        _allow("setNickname(bytes32,string)", ArgKind.Platform);
        // 6.3 T11: 도둑맞은 계정을 되돌리는 버튼이 가스를 요구해서는 안 된다(C3).
        _allow("cancelRotation()", ArgKind.Platform);
```

- [ ] **Step 4: `Deploy.t.sol`도 새 셀렉터를 보게 한다**

`contracts/test/Deploy.t.sol`의 생성자 검증 테스트(77~84행 근처)에 두 줄을 더한다:

```solidity
        assertTrue(
            paymaster.allowedSelector(bytes4(keccak256("checkInLate(uint256,(uint256,uint256,uint64,bytes32),bytes)"))),
            "checkInLate is sponsored"
        );
        assertTrue(paymaster.allowedSelector(bytes4(keccak256("cancelRotation()"))), "cancelRotation is sponsored");
```

- [ ] **Step 5: 통과와 전체 회귀**

```bash
forge test
```

Expected: 311 passed 내외, 0 failed.

- [ ] **Step 6: 커밋**

```bash
git add contracts/src/MontiPaymaster.sol contracts/test/Paymaster.t.sol contracts/test/Deploy.t.sol
git commit -m "feat(contracts): sponsor the four missing selectors and add setAllowed (I4)

revokeGate / revoke / createOrganizer / transferOwner were unsponsored, so T14's
own remedy and 5.8's '주최자 되기' needed MON. checkInLate and cancelRotation join
them. setAllowed ends R-PM6's consequence: the allowlist no longer needs a
redeploy, and an abused selector can be switched off in one transaction."
```

---

## Task 12: 크기와 가스 예산을 테스트로 들고 있는다

**Files:**
- Create: `contracts/test/ContractSize.t.sol`
- Modify: `contracts/test/TicketCheckInLate.t.sol` (늦은 경로 가스 측정 컨트랙트 추가)
- Test: 위 두 파일

**Interfaces:**
- Consumes: Task 1~11의 모든 변경
- Produces: `Ticket` 런타임 크기와 `checkInLate` 가스가 테스트로 고정된다. 04가 UserOp 가스 4필드를 잡을 때(I10, 04 T21) 이 숫자를 출발점으로 쓴다.

- [ ] **Step 1: 크기 테스트를 쓴다**

`contracts/test/ContractSize.t.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {Test} from "forge-std/Test.sol";
import {Identity} from "../src/Identity.sol";
import {Organizers} from "../src/Organizers.sol";
import {Ticket} from "../src/Ticket.sol";

/// @notice 한도는 EIP-170 의 24,576 B 가 아니라 Monad 의 128 KB 다(Task 1 이 foundry.toml 에
///         code_size_limit 으로 못박았다). 이 테스트는 그 한도를 테스트로 들고 있어서, 어느
///         커밋이 얼마나 썼는지 그 자리에서 드러나게 한다.
///
///         런타임과 이니트코드를 둘 다 본다. 이니트코드가 먼저 걸린다 — Ticket 의 생성 코드는
///         런타임보다 756 B 크고, 배포 트랜잭션이 통과해야 하는 것은 그쪽이다.
contract ContractSizeTest is Test {
    /// @dev foundry.toml 의 code_size_limit 과 같은 값. revm 은 EIP-3860 이니트코드 상한도
    ///      이 값에서 유도하므로 둘을 같은 상수로 잰다.
    uint256 internal constant MONAD_CODE_SIZE_LIMIT = 131_072;

    function test_ticketFitsUnderMonadsLimit() public {
        Identity identity = new Identity(address(0xA11CE));
        Organizers organizers = new Organizers();
        Ticket ticket = new Ticket(address(identity), address(organizers));

        uint256 runtime = address(ticket).code.length;
        uint256 initcode = type(Ticket).creationCode.length;

        assertLt(runtime, MONAD_CODE_SIZE_LIMIT, "Ticket runtime crossed Monad's limit");
        assertLt(initcode, MONAD_CODE_SIZE_LIMIT, "Ticket initcode crossed Monad's limit");

        emit log_named_uint("Ticket runtime size (B)", runtime);
        emit log_named_uint("Ticket initcode size (B)", initcode);
        emit log_named_uint("Monad margin, runtime (B)", MONAD_CODE_SIZE_LIMIT - runtime);
        emit log_named_uint("Monad margin, initcode (B)", MONAD_CODE_SIZE_LIMIT - initcode);
    }

    /// @dev 나머지 셋도 같이 기록한다. 커지는 방향을 놓치지 않기 위한 것이지 한도 걱정은 아니다.
    function test_theOtherThreeAreNowhereNearTheLimit() public {
        Identity identity = new Identity(address(0xA11CE));
        Organizers organizers = new Organizers();

        emit log_named_uint("Identity runtime size (B)", address(identity).code.length);
        emit log_named_uint("Organizers runtime size (B)", address(organizers).code.length);
        emit log_named_uint("Identity initcode size (B)", type(Identity).creationCode.length);
        emit log_named_uint("Organizers initcode size (B)", type(Organizers).creationCode.length);

        assertLt(type(Identity).creationCode.length, MONAD_CODE_SIZE_LIMIT);
        assertLt(type(Organizers).creationCode.length, MONAD_CODE_SIZE_LIMIT);
    }
}
```

`MontiPaymaster`는 이 파일에서 배포하지 않는다 — 생성자가 EntryPoint를 포함한 네 주소를 요구해서 목이 필요하고, 크기 여유가 100 KB 넘게 남아 잴 값이 없다. `forge build --sizes`가 매 빌드마다 보고한다.

- [ ] **Step 2: 늦은 경로 가스 측정을 더한다**

`contracts/test/TicketCheckInLate.t.sol` 끝에:

```solidity
/// @notice 04 가 UserOp 의 네 가스 필드를 잡을 때 쓰는 출발점(I10). 늦은 경로는 gateInfo 조회가
///         하나 더 있어 현장 경로보다 조금 비싸다. 한도는 같은 200k 다(스펙 8.3).
///         픽스처는 setUp 에, 즉 별도 트랜잭션에 둔다 — 같은 트랜잭션에서 재면 계정과 슬롯이
///         이미 따뜻해서 게이트 폰이 실제로 내는 값보다 한참 낮게 나온다.
contract CheckInLateGasTest is CheckInLateBase {
    uint256 internal constant CHECK_IN_GAS_CEILING = 200_000;

    function setUp() public {
        _setUpLate(ISSUED, ISSUED + 6 hours);
        vm.warp(ISSUED + 1 hours);
    }

    function test_checkInLateGas() public {
        Ticket.GateCode memory g = _code();
        bytes memory sig = _sig();
        Ticket t = ticket;
        uint256 id = tokenId;

        vm.prank(GATE_A);
        uint256 before = gasleft();
        t.checkInLate(id, g, sig);
        uint256 used = before - gasleft();

        assertTrue(ticket.checkInOf(id).late, "the measured call must be a real late check-in");
        emit log_named_uint("checkInLate gas (local osaka)", used);
        assertLt(used, CHECK_IN_GAS_CEILING, "spec 8.3 budgets 275k for the whole user op; the call gets 200k");
    }
}
```

- [ ] **Step 3: 전부 돌리고 숫자를 읽는다**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/MONTI-01b/contracts
forge test --match-path test/ContractSize.t.sol -vv
forge test --match-test "checkInGas|checkInLateGas" -vv
```

Expected: PASS. 로그에 `Ticket runtime size (B)`, `Ticket initcode size (B)`, `checkIn gas (local osaka)`, `checkInLate gas (local osaka)` 네 숫자가 찍힌다. **네 숫자를 커밋 메시지에 적는다** — 이니트코드는 Task 15 Step 0이, 가스 두 개는 04 T21이 그대로 쓴다.

테스트가 빨간 경우 — 즉 어느 컨트랙트가 131,072 B를 넘은 경우 — 는 이 플랜에서 일어나지 않을 일이다(`Ticket`이 22,673 B에서 출발한다). 일어났다면 크기를 줄이려 들지 말고 **무엇이 그만큼 들어갔는지**를 먼저 보고한다.

- [ ] **Step 4: 전체 회귀와 포맷**

```bash
forge fmt
forge fmt --check
forge test
forge build --sizes
```

Expected: 314 passed 내외, 0 failed. `forge build --sizes`가 경고 없이 끝나고, `Ticket`의 `Runtime Margin`이 10만 B대로 보고된다.

- [ ] **Step 5: 커밋**

```bash
git add contracts/test/ContractSize.t.sol contracts/test/TicketCheckInLate.t.sol
git commit -m "test(contracts): hold the Monad size limit and the checkInLate gas figure

Ticket runtime <크기> B / initcode <크기> B against the 131,072 B limit.
checkIn <가스>, checkInLate <가스> — 04 T21 starts its UserOp gas fields there."
```

---

## Task 13: ABI 재내보내기 — 네 저장소 전부

**Files:**
- Modify: `MONTI-prod/packages/shared/src/abi/{Identity,Organizers,Ticket,MontiPaymaster}.json` (`export-abi.sh`가 쓴다)
- Modify: `MONTI-backend/packages/shared/src/abi/*.json`, `…/src/abi.test.ts`, `…/src/constants.ts`
- Modify: `MONTI-web/packages/shared/src/abi/*.json`, `…/src/abi.test.ts`, `…/src/constants.ts`
- Modify: `MONTI-staff/packages/shared/src/abi/*.json`, `…/src/abi.test.ts`, `…/src/constants.ts`
- Test: 각 저장소의 `packages/shared` 테스트

**Interfaces:**
- Consumes: Task 12까지의 최종 ABI
- Produces: 02·03·04가 새 타입으로 빌드된다.

**두 가지를 먼저 안다.**

1. **`packages/shared`는 넷이다** — `MONTI-prod`(ABI 드롭 전용), `MONTI-backend`(**정본**), `MONTI-web`, `MONTI-staff`. `MONTI-staff`는 `MONTI-web`의 완전한 동격이고 플랜 04의 `checkInLate` 소비자가 거기 산다.
2. **소비자 저장소의 `contracts/`는 prod의 서브모듈이 아니라 독립된 전체 사본이고, 오늘 이미 어긋나 있다** — `diff -rq`가 `Identity.sol`·`Ticket.sol`·`interfaces/ITicket.sol`·`libs/AttesterRole.sol`을 차이로 보고한다. 그 안에서 `export-abi.sh`를 돌리면 **옛 소스가 다시 내보내진다.** 그래서 스크립트는 prod(정확히는 워크트리 `MONTI-01b`)에서 **한 번만** 돌리고, 결과 JSON을 세 곳에 **복사**한다.

- [ ] **Step 1: 워크트리에서 내보낸다**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/MONTI-01b/contracts
./script/export-abi.sh
git -C .. status --porcelain -- packages/shared/src/abi
```

Expected: `Identity.json`, `Organizers.json`, `Ticket.json`, `MontiPaymaster.json` 네 개가 수정으로 잡힌다(`CoinbaseSmartWalletFactory.json`은 그대로).

- [ ] **Step 2: 새 이름이 실제로 들어갔는지 확인한다**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/MONTI-01b
A=packages/shared/src/abi
jq -r '.[] | select(.type=="function" or .type=="event") | .name' $A/Ticket.json | sort \
  | grep -E "checkInLate|offerDigest|eip712Domain|LATE_WINDOW|MIGRATE_DELAY|CheckedInLate"
jq -r '.[] | select(.type=="function" or .type=="event") | .name' $A/Identity.json | sort \
  | grep -E "cancelRotation|rotatedAt|rotatedFrom|ROTATION_UNDO_WINDOW|RotationCancelled"
jq -r '.[] | select(.type=="function" or .type=="event") | .name' $A/MontiPaymaster.json | sort \
  | grep -E "setAllowed|argWordOf|SelectorAllowed"
jq -r '.[] | select(.name=="checkInOf") | .outputs[0].components[].name' $A/Ticket.json
```

Expected: 순서대로 6개 / 5개 / 3개가 찍히고, 마지막 줄이 `gateId ts nonceHash manual late`를 낸다.

- [ ] **Step 3: 워크트리를 커밋한다**

```bash
git add packages/shared/src/abi
git commit -m "chore(shared): re-export the 01b ABIs"
```

- [ ] **Step 4: 세 소비자 저장소에 JSON을 복사한다**

```bash
SRC=/Users/moomi/Downloads/z03.Vibe_Coding/MONTI/MONTI-01b/packages/shared/src/abi
for R in MONTI-backend MONTI-web MONTI-staff; do
  D=/Users/moomi/Downloads/z03.Vibe_Coding/MONTI/$R/packages/shared/src/abi
  for F in Identity Organizers Ticket MontiPaymaster; do cp "$SRC/$F.json" "$D/$F.json"; done
  echo "$R updated"
done
```

`CoinbaseSmartWalletFactory.json`은 바뀌지 않았으므로 복사하지 않는다.

- [ ] **Step 5: 세 저장소의 `abi.test.ts`와 `constants.ts`를 고친다**

`abi.test.ts`는 `arrayContaining`으로 정확한 집합을 단언하므로, 여기 넣지 않으면 **새 함수가 빠져도 아무도 못 잡는다.** 세 저장소에 **같은** 변경을 한다:

- `Ticket` 함수 목록에: `'checkInLate'`, `'offerDigest'`, `'eip712Domain'`, `'LATE_WINDOW'`, `'MIGRATE_DELAY'`
- `Ticket` 이벤트 목록에: `'CheckedInLate'`
- `Identity` 함수 목록에: `'cancelRotation'`, `'rotatedAt'`, `'rotatedFrom'`, `'ROTATION_UNDO_WINDOW'`
- `Identity` 이벤트 목록에: `'RotationCancelled'`
- `MontiPaymaster` 함수 목록에: `'setAllowed'`, `'argWordOf'`
- `MontiPaymaster` 이벤트 목록에: `'SelectorAllowed'`

`constants.ts`의 `CODE_WINDOW_SECONDS = 60`(39행) 아래에 두 줄:

```ts
/** Ticket.LATE_WINDOW. 오프라인 큐의 코드 하한(개장 이 초 전)이자 제출 상한(폐장 이 초 후). */
export const LATE_WINDOW_SECONDS = 43_200;
/** Ticket.MIGRATE_DELAY = Identity.ROTATION_UNDO_WINDOW. 계정 교체 뒤 티켓이 따라가기까지, 그리고
 *  본인이 되돌릴 수 있는 시간(6.3 T11). 두 값은 같아야 한다. */
export const MIGRATE_DELAY_SECONDS = 86_400;
```

- [ ] **Step 6: 세 저장소에서 테스트를 돌린다**

```bash
for R in MONTI-backend MONTI-web MONTI-staff; do
  ( cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/$R && npm test -w packages/shared ) || echo "FAILED: $R"
done
```

Expected: 셋 다 PASS. 실패하면 `abi.test.ts`의 이름 목록과 방금 복사한 JSON이 어긋난 것이다.

- [ ] **Step 7: 세 저장소에서 각각 커밋한다**

```bash
for R in MONTI-backend MONTI-web MONTI-staff; do
  git -C /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/$R add packages/shared
  git -C /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/$R commit -m "chore(shared): adopt the 01b ABIs, LATE_WINDOW and MIGRATE_DELAY"
done
```

각 저장소의 `contracts/` 사본은 **이 Task에서 건드리지 않는다** — 이미 prod와 어긋나 있고, 그걸 맞추는 것은 이 플랜의 범위가 아니다. 다만 세 사본이 모두 오래된 소스를 들고 있다는 사실은 Task 17에서 하위 플랜에 남긴다.

---

## Task 14: `Deploy.s.sol` 확인과 `Seed.s.sol`의 자리표시자 게이트 키 제거

**Files:**
- Modify: `contracts/script/Seed.s.sol` (게이트 키를 환경변수로, 데모 기기 키 경고, `MEMBER_FUND_WEI` 기본값)
- Modify: `contracts/.env.example` (`SEED_GATE_KX`, `SEED_GATE_KY`)
- Test: `contracts/test/Seed.t.sol`, `contracts/test/Deploy.t.sol`

**Interfaces:**
- Consumes: Task 11까지의 컨트랙트
- Produces: `Seed`가 진짜 게이트 P-256 공개키로 게이트를 등록한다. Task 15의 재시드가 이걸 쓴다.

`Deploy.s.sol`은 **고칠 것이 없다** — 네 생성자의 인자가 하나도 바뀌지 않았고, 페이마스터의 허용 목록은 여전히 자기 생성자가 채운다. Task 11이 이미 `Deploy.t.sol`에 새 셀렉터 단언 두 줄을 넣었다.

`Seed.s.sol`은 고쳐야 한다. 리뷰 Minor 4: `Seed.s.sol:155`가 게이트를 `keccak256("gate-kx")`/`keccak256("gate-ky")` 자리표시자로 등록하므로 **§7.2 3단계의 관객 폰 게이트 서명 검증(T14 방어 ①)이 시드된 게이트에서는 애초에 동작하지 않는다.** 게다가 Task 6이 반쪽 0 키를 막았을 뿐 자리표시자는 여전히 통과한다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`contracts/test/Seed.t.sol`에 넣는다(기존 시드 테스트가 쓰는 헬퍼 호출 형태에 맞춘다):

```solidity
    /// @dev Minor 4. 자리표시자 키로 등록된 게이트는 관객 폰이 검증할 수 없다(T14 방어 1).
    ///      시드도 진짜 게이트 공개키를 받아야 한다.
    function test_seedRegistersTheGateWithTheSuppliedKey() public {
        bytes32 kx = bytes32(uint256(0x6A11));
        bytes32 ky = bytes32(uint256(0x6A22));
        _runSeedWithGateKey(kx, ky);

        (,, bytes32 gotX, bytes32 gotY,,) = organizers.gateInfo(seed.gateId());
        assertEq(gotX, kx, "the gate key is the one the founder supplied");
        assertEq(gotY, ky);
        assertTrue(gotX != keccak256("gate-kx"), "no placeholder survives");
    }
```

(`_runSeedWithGateKey`는 그 파일의 기존 시드 구동 헬퍼에 두 인자를 더한 형태다 — 기존 헬퍼 이름과 시그니처를 그대로 따라 확장한다.)

- [ ] **Step 2: 실패를 확인한다**

Run: `forge test --match-path test/Seed.t.sol -vv`
Expected: 컴파일 실패 또는 FAIL — `seed()`가 아직 게이트 키를 받지 않는다.

- [ ] **Step 3: `Seed.s.sol`을 고친다**

문서 주석의 환경변수 목록에 두 줄을 더한다:

```
///           GATE_ACCOUNT     the staff device's account, which becomes this event's open gate
///           SEED_GATE_KX     the gate device's P-256 public key X, as 0x-prefixed 32 bytes. The
///           SEED_GATE_KY     attendee phone verifies the gate's signature against these before it
///                            writes anything back (spec 7.2 step 3, T14 defence 1), so a placeholder
///                            here means that defence does not exist on the demo gate
```

`run()`에 읽기를 더한다:

```solidity
        address gate = vm.envAddress("GATE_ACCOUNT");
        bytes32 gateKx = vm.envBytes32("SEED_GATE_KX");
        bytes32 gateKy = vm.envBytes32("SEED_GATE_KY");
```

`seed(...)`의 시그니처에 두 인자를 더하고(`gateAccount_` 바로 뒤), 155행의 등록을 바꾼다:

```solidity
        gateId = organizers.registerGate(eventId, gateAccount, gateKx_, gateKy_);
```

그리고 데모 기기 키에 대한 경고를 `MEMBER_LABEL` 주석 옆에 붙인다(리뷰 Minor 3):

```solidity
    /// @dev 데모 계정, 그리고 오직 데모 계정: 라벨이 공개이므로 누구나 이 키를 유도할 수 있다.
    ///      세 데모 멤버가 같은 기기 공개키(P256Vectors.DEVICE_X/Y)를 쓰고, 그 개인키는
    ///      script/gen-p256-vectors.mjs:14 에서 그대로 나온다. **메인넷에 절대 가면 안 된다.**
    ///      진짜 관객 폰은 앱에서 자기 패스키 계정과 자기 기기 키를 만든다(서브플랜 03).
    string internal constant MEMBER_LABEL = "monti.seed.demo.member";
```

그리고 **데모 멤버 가스 기본값을 올린다**(`Seed.s.sol:44`). `progress.md`가 01b 항목으로 남긴 사실이다: Monad는 `gas_limit × 100 gwei`로 물리므로 0.02 MON으로는 데모 멤버의 `claim`이 나가지 않는다 — 2026-09-22 시드에서 세 건을 `cast`로 손수 마무리해야 했다.

```solidity
    /// @notice 한 번의 claim 이 이 안에서 끝나고, 나머지는 서브플랜 03 이 다음에 보여줄 것을 위해
    ///         계정에 남는다. Monad 는 gas_limit x 100 gwei 로 물리므로 0.02 MON 으로는 모자랐다
    ///         (2026-09-22 시드에서 세 건을 손으로 마무리해야 했다).
    uint256 public constant DEFAULT_MEMBER_FUND_WEI = 0.1 ether;
```

`contracts/.env.example`에 두 줄:

```
# The gate device's P-256 public key, as 0x-prefixed 32-byte words. Generated on the Android device
# (alias monti-gate) by sub-plan 04; the attendee phone verifies the gate signature against these.
SEED_GATE_KX=
SEED_GATE_KY=
```

- [ ] **Step 4: 통과와 전체 회귀**

```bash
forge test
forge fmt --check
```

Expected: 315 passed 내외, 0 failed. `Seed.t.sol`이 자금 조달 금액을 단언하고 있으면 그 기대값도 0.1 MON으로 같이 고친다.

- [ ] **Step 5: 커밋**

```bash
git add contracts/script/Seed.s.sol contracts/test/Seed.t.sol contracts/.env.example
git commit -m "fix(contracts): the seed takes a real gate key and funds members for Monad (Minor 4)

A placeholder kx/ky means the attendee phone cannot verify the gate before it
writes back — T14 defence 1 simply does not exist on a placeholder gate.
MEMBER_FUND_WEI 0.02 -> 0.1 MON: Monad charges gas_limit x 100 gwei, and the
2026-09-22 seed had to finish its three claims by hand."
```

---

## Task 15: 재배포, 배포 파일 갱신, 재시드, 인덱서 시작 블록

**Files:**
- Modify: `contracts/deployments/10143.json` (Deploy가 덮어쓴다)
- Modify: `contracts/deployments/seed-10143.json` (Seed가 덮어쓴다)
- Modify: `MONTI-backend/packages/shared/src/deployments/*.json`, `MONTI-web/packages/shared/src/deployments/*.json`
- Modify: `MONTI-web/apps/web`의 `.env`류 (`VITE_ADDR_*` 네 개)
- Test: 온체인 확인 명령들(아래 Step 4)

**Interfaces:**
- Consumes: Task 14까지의 모든 것
- Produces: 새 네 주소, 새 시작 블록, 새 시드. 02·03·04가 여기서부터 동작한다.

이 Task는 TDD가 아니라 **런북**이다. 순서를 지킨다.

- [ ] **Step 0: 128 KB 가정을 체인과 번들러에서 실증한다 (이 Task에서 제일 먼저)**

Task 1이 올린 것은 **툴체인의 한도**다. Monad 노드와 Pimlico가 실제로 무엇을 받는지는 아직 아무도 확인하지 않았다. 가정이 틀리면 Step 2에서 재배포가 통째로 실패하고, 번들러 거부는 **온체인 흔적을 남기지 않는다**(리뷰 I6과 같은 실패 양식). 폐기용 컨트랙트 하나로 30분 안에 끝난다.

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/MONTI-01b/contracts
set -a && . ./.env && set +a
```

`contracts/script/SizeProbe.s.sol`을 만든다(이 Task가 끝나면 지운다 — 커밋하지 않는다):

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

/// @notice 배포 가능한 최대 크기를 실제 체인에 묻는 폐기용 프로브. 런타임은 PUSH 로 채운
///         상수 배열 하나이고, 로직은 없다. Ticket 의 이니트코드(약 23.5 KB)보다 크고 EIP-170
///         한도보다 확실히 큰 크기를 목표로 한다.
contract Fat {
    bytes public constant BLOB = hex"<0x 없이 40,000자 = 20,000 B 아무 16진수. `openssl rand -hex 20000` 로 만든다>";

    function ping() external pure returns (uint256) {
        return BLOB.length;
    }
}

contract SizeProbe is Script {
    function run() external {
        vm.startBroadcast(vm.envUint("DEPLOYER_PK"));
        Fat f = new Fat();
        vm.stopBroadcast();
        console2.log("probe        ", address(f));
        console2.log("runtime bytes", address(f).code.length);
    }
}
```

```bash
forge script script/SizeProbe.s.sol:SizeProbe \
  --rpc-url "$MONAD_TESTNET_RPC" --broadcast --slow --gas-limit 30000000
```

- [ ] 배포가 성공하고 `runtime bytes`가 24,576보다 크다 → **런타임 한도 확인.** 실패하면 되돌아가 `Ticket`을 24,576 B 아래로 유지해야 하고(이 플랜의 전제가 무너진다) 즉시 보고한다.
- [ ] `cast code <probe> --rpc-url "$MONAD_TESTNET_RPC" | wc -c`로 체인에 실제로 그 크기가 올라갔는지 본다.
- [ ] **이니트코드 한도**는 위 배포가 이미 증명한다 — 생성 코드가 런타임보다 크기 때문이다. 배포 트랜잭션의 `input` 길이를 기록해 둔다(`cast tx <hash> --rpc-url "$MONAD_TESTNET_RPC" input | wc -c`).

그다음 **번들러 경로**를 확인한다. Pimlico(Alto)는 노드의 `eth_call`/`debug_traceCall`로 시뮬레이션하므로 노드 한도가 지배하지만, 거부는 조용하다:

- [ ] **현재 배포**의 `Ticket`에 스폰서된 `checkIn` UserOp을 **한 건** 실제로 보내 성공시킨다(R-F1의 엔드투엔드 탭이 이미 이걸 했다면 그 결과를 재사용한다). `userOpHash`와 영수증을 기록한다.
- [ ] Step 2·3이 끝난 뒤 **새 배포**에서 같은 것을 한 번 더 한다(Step 4의 마지막 항목).

프로브 컨트랙트 파일은 여기서 지운다. 주소만 런북에 남긴다.

- [ ] **Step 1: 전제 조건을 확인한다 (건너뛰지 않는다)**

- [ ] Step 0의 세 항목이 전부 초록이다.
- [ ] 02/03/04가 **현재 배포**에서 게이트 탭 한 번을 엔드투엔드로 성공시켰다(R-F1). 아니면 여기서 멈춘다.
- [ ] 04가 실제 스태프 단말기의 **게이트 계정 주소**(`GATE_ACCOUNT`)와 **진짜 게이트 공개키**(`SEED_GATE_KX`, `SEED_GATE_KY` — 0x 접두 32바이트 두 개)를 넘겼다. 계정 주소는 채택된 팩토리 `0xBA5ED110eFDBa3D005bfC882d75358ACBbB85842`로 **`factoryAddress`를 명시해** 유도한 것이어야 한다 — viem과 permissionless의 기본값은 v1.0 팩토리라 다른 주소가 나온다.
- [ ] `SEED_IMAGE_CID`가 Pinata에 핀된 실제 CID다(`bafy…`, 59자).
- [ ] 배포자 계정에 가스가 넉넉하다. 7건의 브로드캐스트가 각각 `--gas-limit 30000000`으로 나가고, Monad는 **한도 × 100 gwei**로 문다.
- [ ] **옛 배포에서 살려야 할 것 목록이 있다** — Step 8의 계정 재등록 대상과 Step 9의 스테이크·예치금.
- [ ] `forge test`가 초록이고 `.github-checks.sh`가 통과한다.

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/MONTI-01b/contracts
./.github-checks.sh
cat deployments/10143.json    # 옛 주소를 기록해 둔다 — Step 8·9와 롤백 판단에 쓴다
cp deployments/10143.json /tmp/monti-10143-old.json
```

- [ ] **Step 2: 네 컨트랙트를 배포한다**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/MONTI-01b/contracts
set -a && . ./.env && set +a
forge script script/Deploy.s.sol:Deploy \
  --rpc-url "$MONAD_TESTNET_RPC" \
  --broadcast --slow \
  --gas-limit 30000000
```

Expected: 콘솔에 네 주소와 `wrote deployments/10143.json`. `--gas-limit`은 선택이 아니다 — Monad는 한도로 과금하므로 모든 브로드캐스트에 명시한다(플랜 01과 같은 값).

```bash
jq . deployments/10143.json
```

Expected: `identity`/`organizers`/`ticket`/`paymaster` 넷 다 **옛 값과 다르고**, `block`이 옛 `64385989`보다 크며, `coinbaseFactory`와 `entryPoint`는 그대로 유지된다(`record()`가 기존 값을 읽어 넘긴다).

- [ ] **Step 3: 시드를 돌린다**

`GATE_ACCOUNT`, `SEED_GATE_KX`, `SEED_GATE_KY`, `SEED_IMAGE_CID`를 `.env`에 채운 뒤:

```bash
forge script script/Seed.s.sol:Seed \
  --rpc-url "$MONAD_TESTNET_RPC" \
  --broadcast --slow \
  --gas-limit 30000000
jq . deployments/seed-10143.json
```

Expected: `orgId`/`eventId`/`gateId`/`gateAccount`/`members`/`tokenIds`. 컨트랙트가 새것이므로 상태가 비어 있어 **이번에는 시드를 처음부터 돌리는 것이 맞다**(기존 배포에 게이트를 더하는 경우와 다르다 — 아래 Step 6).

- [ ] **Step 4: 체인에서 실제로 확인한다**

```bash
T=$(jq -r .ticket deployments/10143.json)
I=$(jq -r .identity deployments/10143.json)
P=$(jq -r .paymaster deployments/10143.json)
R="$MONAD_TESTNET_RPC"

# 새 진입점이 살아 있다
cast call "$T" "LATE_WINDOW()(uint256)"    --rpc-url "$R"   # 43200
cast call "$T" "MIGRATE_DELAY()(uint256)"  --rpc-url "$R"   # 86400
cast call "$I" "rotatedAt(bytes32)(uint64)" 0x0000000000000000000000000000000000000000000000000000000000000000 --rpc-url "$R"   # 0

# 허용 목록에 새 셀렉터 여섯 개가 들어갔다 (1=Platform 3=TokenId 4=OrgId)
for sig in "checkInLate(uint256,(uint256,uint256,uint64,bytes32),bytes)" "cancelRotation()" \
           "revokeGate(uint256)" "revoke(uint256,uint8)" "createOrganizer(address)" "transferOwner(uint256,address)"; do
  echo -n "$sig -> "
  cast call "$P" "argKindOf(bytes4)(uint8)" "$(cast sig "$sig")" --rpc-url "$R"
done

# 페이마스터가 스테이크되고 예치되어 있다
cast call 0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789 "getDepositInfo(address)((uint112,bool,uint112,uint32,uint48))" "$P" --rpc-url "$R"
```

Expected: `43200`, `86400`, `0`, 그리고 셀렉터 여섯 개가 각각 `3 1 1 3 1 4`. `getDepositInfo`가 `staked: true`와 1e18 스테이크/예치를 보고한다.

- [ ] **마지막으로 새 배포에서 스폰서 UserOp 한 건을 실제로 통과시킨다**(Step 0의 짝). 시드된 게이트 계정으로 `checkIn` 또는 `checkInLate`를 Pimlico에 보내 영수증을 받는다. **번들러 거부는 온체인 흔적을 남기지 않으므로, 이것을 데모 전에 확인하지 않으면 확인할 기회가 없다.** 동시에 04가 I10의 네 가스 필드(`callGasLimit`, `verificationGasLimit`, `preVerificationGas`, `maxFeePerGas`)를 여기서 받아 적는다.

- [ ] **Step 5: 새 주소를 세 저장소와 웹 환경변수에 퍼뜨린다**

```bash
SRC=/Users/moomi/Downloads/z03.Vibe_Coding/MONTI/MONTI-01b/contracts/deployments
for R in MONTI-backend MONTI-web MONTI-staff; do
  D=/Users/moomi/Downloads/z03.Vibe_Coding/MONTI/$R
  cp "$SRC/10143.json"      "$D/contracts/deployments/10143.json"
  cp "$SRC/seed-10143.json" "$D/contracts/deployments/seed-10143.json"
  ( cd "$D" && node packages/shared/scripts/sync-deployments.mjs )
done
```

**그리고 웹·스태프 두 앱의 환경변수 네 개를 반드시 갈아준다.** `MONTI-web/apps/web/src/shared/config.ts`(그리고 `MONTI-staff`의 같은 파일)는 `loadDeployment`를 거치지 않고 `requiredEnv`로 이 넷을 직접 읽는다 — 안 바꾸면 앱이 옛 컨트랙트를 조용히 계속 쓴다:

```
VITE_ADDR_IDENTITY=<새 identity>
VITE_ADDR_ORGANIZERS=<새 organizers>
VITE_ADDR_TICKET=<새 ticket>
VITE_ADDR_PAYMASTER=<새 paymaster>
```

`MONTI-web`과 `MONTI-staff` **양쪽**에서, 로컬 `.env`와 배포 환경(호스팅 대시보드) **둘 다**. 번들러 URL(`VITE_BUNDLER_URL`)은 바뀌지 않는다.

- [ ] **Step 6: 인덱서 시작 블록과 상태를 다시 맞춘다**

인덱서의 시작 블록은 `deployments/10143.json`의 **`.block`** 이다(`packages/shared/src/constants.ts:86`의 `Deployment.block` 주석이 그렇게 정의한다). Step 5의 동기화로 값 자체는 이미 새것이다.

```bash
jq -r '"indexer start_block = \(.block)"' \
  /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/MONTI-backend/packages/shared/src/deployments/10143.json
```

**현재 시점의 사실:** Envio `config.yaml`은 아직 존재하지 않는다 — `start_block: ${deployment.block}`을 생성하는 `gen-config` 단계는 플랜 02 문서(7512·7526행)에만 있고 구현되지 않았다. 그러니 01b가 할 일은 여기까지다. 만약 그사이 02가 인덱서를 띄웠다면, **옛 배포를 인덱싱한 데이터를 반드시 비운다**: 주소가 전부 달라졌으므로 섞이면 안 된다. `envio stop` → 데이터베이스 초기화(`envio start --reset` 또는 그 저장소의 초기화 명령) → 새 `start_block`으로 재시작.

- [ ] **Step 7: 게이트를 **나중에** 하나 더 붙이는 절차 (재시드하지 않는다)**

두 번째 스태프 단말기가 생기거나 게이트를 잘못 등록했을 때, **`Seed`를 다시 돌리지 않는다** — 재시드는 새 조직·새 행사·새 게이트를 만들고 `seed-10143.json`을 무효화한다. 기존 행사에 직접 붙인다:

```bash
ORG_EVENT=$(jq -r .eventId deployments/seed-10143.json)
T=$(jq -r .ticket deployments/10143.json)
O=$(jq -r .organizers deployments/10143.json)

cast send "$O" "registerGate(uint256,address,bytes32,bytes32)" \
  "$ORG_EVENT" <새 게이트 계정> <kx> <ky> \
  --rpc-url "$MONAD_TESTNET_RPC" --private-key "$DEPLOYER_PK" --gas-limit 500000

# 반환된 gateId 로 문을 연다
cast send "$O" "openGate(uint256)" <gateId> \
  --rpc-url "$MONAD_TESTNET_RPC" --private-key "$DEPLOYER_PK" --gas-limit 200000
```

`registerGate`는 한 주소를 **한 번만** 받는다. 다만 01b의 I3 덕분에 실수로 등록한 게이트는 `revokeGate(gateId)` 뒤 **그 주소를 다시 쓸 수 있다** — 재배포 전이라면 그 주소가 영구히 타버렸다.

- [ ] **Step 8: 옛 `Identity`에 있던 계정을 새 `Identity`에 다시 등록한다**

최종 리뷰가 번들의 일부로 명시한 항목이다("re-registering any accounts already created"). R-F1이 재배포를 **엔드투엔드 탭 성공 이후**로 미뤘으므로, 그 시점에는 옛 `Identity 0x226E…beD6`에 **진짜 패스키 계정이 존재한다** — 그냥 두면 그 사람들은 새 스택에서 존재하지 않는 사람이 된다.

스마트 계정 주소 자체는 패스키에서 유도되므로 **바뀌지 않는다.** 옮겨야 하는 것은 `Identity`의 세 가지 기록뿐이고, 셋 다 옛 컨트랙트에서 읽을 수 있다.

```bash
OLD_I=$(jq -r .identity /tmp/monti-10143-old.json)
NEW_I=$(jq -r .identity deployments/10143.json)
R="$MONAD_TESTNET_RPC"

# 1) 옛 Identity 의 Registered 이벤트로 대상 목록을 만든다.
cast logs --rpc-url "$R" --address "$OLD_I" \
  "Registered(bytes32,address)" --from-block "$(jq -r .block /tmp/monti-10143-old.json)" \
  | tee /tmp/monti-old-registered.txt

# 2) 각 (personId, account) 에 대해 기기 키와 KYC 등급을 읽는다.
cast call "$OLD_I" "activeDevice(address)(bytes32,bytes32)" <account> --rpc-url "$R"
cast call "$OLD_I" "kycLevelOf(address)(uint8)"            <account> --rpc-url "$R"

# 3) 어테스터로 새 Identity 에 같은 값을 등록한다.
cast send "$NEW_I" "register(bytes32,address,bytes32,bytes32,uint8)" \
  <personId> <account> <deviceX> <deviceY> <kycLevel> \
  --rpc-url "$R" --private-key "$ATTESTER_PK" --gas-limit 300000
```

MVP 규모에서 대상은 **시드 데모 멤버 3명 + 창업자의 테스트 계정 몇 개**다. 열 건이 넘지 않으므로 위 세 줄을 손으로 반복하면 되고, 그보다 많아지면 `Registered` 로그를 순회하는 일회용 `forge script`를 쓴다. 어느 쪽이든 **목록을 런북에 남긴다** — 누가 다시 등록됐고 누가 안 됐는지가 나중에 유일한 근거다.

**같이 넘어가지 않는 것 세 가지를 사람들에게 미리 알린다:**

- **티켓.** 새 `Ticket`은 빈 컨트랙트다. 옛 토큰은 옛 주소에 그대로 남고 옮겨오지 않는다. 데모 멤버는 Step 3의 시드가 다시 발급하고, 그 밖의 계정은 새 행사에서 다시 받아야 한다.
- **닉네임.** `setNickname`은 계정 본인만 부를 수 있으므로 어테스터가 대신 옮길 수 없다. 각자 앱에서 다시 설정한다.
- **기기 잠금 상태.** `register`는 항상 잠금 해제 상태로 시작한다. 옛 계정에서 잠가 두었던 사람은 다시 잠가야 한다.

시드 데모 멤버는 Step 3의 `Seed`가 이미 `identity.isMember`를 확인하고 없으면 등록하므로, **Step 8의 대상은 시드 밖의 진짜 계정들**이다.

- [ ] **Step 9: 옛 페이마스터의 스테이크와 예치금을 회수한다**

옛 `MontiPaymaster 0xDa78…2539`에는 스테이크 1 MON과 예치금 1 MON이 잠겨 있다(리뷰가 `getDepositInfo`로 확인했다). **`unlockStake`는 Step 2 직후에 불러 24시간 지연을 나머지 작업과 병렬로 돌린다.**

```bash
OLD_P=$(jq -r .paymaster /tmp/monti-10143-old.json)
R="$MONAD_TESTNET_RPC"

# (Step 2 직후) 언스테이킹을 시작한다. 이 시점부터 옛 페이마스터는 번들러가 어차피 받지 않는다.
cast send "$OLD_P" "unlockStake()" --rpc-url "$R" --private-key "$DEPLOYER_PK" --gas-limit 200000

# 예치금은 바로 뺄 수 있다. 조직 예산이 들어간 적 없으면 전액이다.
cast call "$OLD_P" "budgetOf(uint256)(uint256)" 0 --rpc-url "$R"
cast send "$OLD_P" "withdrawPlatform(address,uint256)" <배포자 주소> <위 금액> \
  --rpc-url "$R" --private-key "$DEPLOYER_PK" --gas-limit 300000

# 24시간(unstakeDelaySec 86400) 뒤에 스테이크를 뺀다.
cast send "$OLD_P" "withdrawStake(address)" <배포자 주소> \
  --rpc-url "$R" --private-key "$DEPLOYER_PK" --gas-limit 300000
```

셋 다 `deployer` 전용이고 `MontiPaymaster.sol:145/174/183`에 있다. `withdrawPlatform`은 `_orgBudgetTotal`만큼은 남기므로, 어떤 조직이 `deposit(orgId)`로 넣은 돈이 있으면 그만큼은 그 조직 오너가 `withdraw`로 빼야 한다(MVP에서는 0일 것이다). **24시간 뒤 항목을 잊지 않도록 런북에 날짜와 함께 적는다.**

- [ ] **Step 10: 커밋한다 (푸시는 하지 않는다)**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/MONTI-01b
git add contracts/deployments
git commit -m "chore(contracts): redeploy all four for 01b and re-seed

identity <addr> / organizers <addr> / ticket <addr> / paymaster <addr>
block <n> — the indexer's new start_block. The previous deployment
(ticket 0xE9686503c4d675B0B1Ec9DE19AbEC51Fc59F1113) is retired."
```

`MONTI-backend`·`MONTI-web`·`MONTI-staff` 세 곳에서도 각각 `git add contracts/deployments packages/shared/src/deployments` 후 같은 취지로 커밋한다.

---

## Task 16: 스펙 본문을 코드에 맞춘다

**Files:**
- Modify: `docs/superpowers/specs/2026-09-20-monti-nfc-ticketing-design.md`
- Test: 없음(문서). 검증은 아래 Step 5의 grep이다.

**Interfaces:**
- Consumes: Task 15까지의 모든 것
- Produces: 스펙이 배포된 컨트랙트와 일치한다. 리뷰의 "Spec drift" 표에서 1·2·6번 행이 닫히고, 3번 행(KMS)은 메인넷 전 요구사항으로 명시된다.

**이 Task 전에는 스펙 파일을 건드리지 않는다.** 아래 치환은 전부 **정확한 원문 → 정확한 새 문장**이다.

- [ ] **Step 1: §6.3 T11 — 리뷰가 "Contradicted"로 판정한 행**

찾기(§6.3 위협 모델 표):

```
| T11 | 백엔드 침해 | **무력화.** 서버에 관객 키도, 게이트 키도, 발행 권한도 없다. 단말기는 체인만 믿는다. 남는 피해는 서비스 중단과 개인정보 유출(암호화로 대응) |
```

바꾸기:

```
| T11 | 백엔드 침해 | **부분 차단.** 서버에 관객 키도, 게이트 키도, 티켓 발행 권한도 없다. 단말기는 체인만 믿는다. 다만 **확인 서명 키(어테스터)가 털리면** 신원 등록·KYC 등급·계정 교체를 위조할 수 있다. 계정 교체는 `AccountRotated`로 체인에 남고, **티켓은 24시간(`MIGRATE_DELAY`) 동안 따라가지 않으며**, 그 24시간 안에 **직전 계정 본인이** `cancelRotation()`으로 되돌릴 수 있다(되돌려도 7일 쿨타임은 되감기지 않아 공격자는 다음 시도까지 꼬박 기다린다). 24시간 안에 되돌리지 않으면 미사용 티켓이 넘어간다. 남는 피해: KYC 등급 위조, 임의 신원 등록, 계정 잠금(현장 대량 DENY), 서비스 중단, 개인정보 유출(암호화로 대응). **어테스터 키를 Cloud KMS로 옮기는 것이 근본 해결이고 정식 출시 전 필수다(10.3).** 못 하는 것: 티켓 발행, 티켓 취소, 입장 처리, 행사 생성, 이미 입장했거나 취소된 티켓 이동. 되돌리기 자체의 잔존: 도난·동기화된 **옛** 패스키가 정당한 교체 한 번을 그 24시간 안에 무효화해 복구를 다음 쿨타임으로 미룰 수 있다. 신원을 빼앗지는 못한다 — 되돌려도 교체가 건 기기 잠금이 남아 되살아난 계정은 문에서도 양도에서도 막히고, 그걸 푸는 `setActiveDevice`는 T6이 이미 받아들인 잔존 권한이다 |
```

- [ ] **Step 2: §12 — 오프라인 큐가 실제로 들어가는 방식**

찾기:

```
| 단말기 인터넷 없음 | **서명된 스냅샷** `{event, ticket, 계정, 기기 키, 사진, epoch, 만료} ‖ sig_attester`로 로컬 검증. "OFFLINE 승인"으로 표시하고 트랜잭션을 큐에 쌓아 복구 후 전송. 큐의 트랜잭션은 관객 서명이 있어야만 체인이 받는다 | **있음**(고립된 단말기끼리). 수용·기록·사후 대사 |
```

바꾸기:

```
| 단말기 인터넷 없음 | **서명된 스냅샷** `{event, ticket, 계정, 기기 키, 사진, epoch, 만료} ‖ sig_attester`로 로컬 검증. "OFFLINE 승인"으로 표시하고 트랜잭션을 큐에 쌓아 복구 후 전송. 복구 후 보내는 것은 `checkIn`이 아니라 **`checkInLate(tokenId, G, S)`**다 — 현장 경로의 60초 창으로는 큐가 절대 들어갈 수 없기 때문이다. 큐 경로가 받는 코드는 **개장 12시간 전부터**이고, 제출은 **폐장 12시간 후까지** 가능하다(`LATE_WINDOW`). 나머지 증명은 현장과 똑같다: 큐의 트랜잭션은 관객 기기 키 서명이 있어야만 체인이 받고, 폐기된 게이트는 큐도 못 흘린다. 체인에 `CheckIn.late = true`와 `CheckedInLate` 이벤트가 남아 사후 대사가 가능하다 | **있음**(고립된 단말기끼리). 수용·기록·사후 대사. 두 번째 제출은 `AlreadyCheckedIn`으로 되돌아오고, 단말기는 체인의 `checkInOf`를 읽어 "누가 먼저였는지"를 기록한다 |
```

- [ ] **Step 3: §13 — 스태프 화면의 두 행**

찾기:

```
| **OFFLINE 승인** | 초록에 앰버 테두리, "복구 후 기록 예정", 사진 |
```

바꾸기:

```
| **OFFLINE 승인** | 초록에 앰버 테두리, "복구 후 기록 예정", 사진. 복구되면 `checkInLate`로 기록되고 배지가 "기록됨"으로 바뀐다. 폐장 12시간이 지나면 기록 창이 닫히므로 "미기록"으로 남고 주최자 대사 목록에 올라간다 |
```

찾기:

```
| 오프라인 | "OFFLINE, 스냅샷 N분 전, 대기 N건" |
```

바꾸기:

```
| 오프라인 | "OFFLINE, 스냅샷 N분 전, 대기 N건". 복구 후에는 "기록됨 N건 / 충돌 N건 / 미기록 N건" |
```

그리고 DENY 행의 `EXPIRED_CODE(다시 대세요)` 뒤에 한 문장을 붙인다 — **큐 경로에서 나온 `EXPIRED_CODE`는 "다시 대세요"가 아니다**:

찾기:

```
| **DENY** | ALREADY_USED(첫 입장 시각·게이트), WRONG_EVENT, REVOKED, EXPIRED_CODE(다시 대세요), NO_TICKET, GATE_CLOSED, DEVICE_LOCKED, DEVICE_MISMATCH, GATE_MISMATCH(다른 게이트의 번호), EVENT_ENDED(행사 종료), EVENT_CANCELLED(취소된 행사), TX_FAILED(사유) |
```

바꾸기:

```
| **DENY** | ALREADY_USED(첫 입장 시각·게이트), WRONG_EVENT, REVOKED, EXPIRED_CODE(현장에서는 "다시 대세요". 큐를 흘리다 나오면 문구가 다르다 — "기록 창 만료, 미기록"), NO_TICKET, GATE_CLOSED, DEVICE_LOCKED, DEVICE_MISMATCH, GATE_MISMATCH(다른 게이트의 번호), EVENT_ENDED(행사 종료), EVENT_CANCELLED(취소된 행사), TX_FAILED(사유. 회전 대기 `RotationPending`과 탈퇴 계정 `NotMember`가 여기로 들어온다) |
```

- [ ] **Step 4: 나머지 드리프트 네 곳**

**(a) §7.3 파라미터 표** — `| 번호 유효기간(체인 검사) | 60초 | 탭 → 전송 → 블록 포함까지 여유 |` 아래에 한 행을 더한다:

```
| 큐 유효기간(체인 검사) | 개장 −12시간 ~ 폐장 +12시간 | 오프라인 큐 전용(`checkInLate`). 현장 60초 창과 무관하며, 하한이 게이트의 서명 사전 수확을 막는다 |
```

**(b) §5.8** — `| 취소·환불 | 행사 취소 시 티켓 일괄 취소(체인). 환불은 유료 전환 후 | 취소는 있음, 환불은 이후 |`를 바꾼다:

```
| 취소·환불 | 행사 취소는 체인에 기록되고, 그 행사의 모든 티켓이 즉시 "취소됨"으로 읽힌다(`tokenURI`가 `eventStatus`에서 파생. 티켓마다 트랜잭션을 보내지 않는다). 환불은 유료 전환 후 | 취소는 있음, 환불은 이후 |
```

**(c) §5.5의 복구 행**(183행 근처) — `| 패스키 자체를 잃음 | 문자 인증 또는 본인인증 재수행 → 새 패스키 → 확인 서명 키가 체인에서 계정을 교체(7일 쿨타임) → 티켓이 새 계정으로 이동 |`을 바꾼다:

```
| 패스키 자체를 잃음 | 문자 인증 또는 본인인증 재수행 → 새 패스키 → 확인 서명 키가 체인에서 계정을 교체(7일 쿨타임) → **24시간 뒤** 티켓이 새 계정으로 이동. 교체는 옛 폰의 기기를 즉시 잠그고, 본인이 원하지 않은 교체라면 옛 계정이 그 24시간 안에 `cancelRotation()`으로 되돌린다(6.3 T11) |
```

**(d) §10.2 `Identity` API 목록** — 이 한 줄만 바뀐다(557행). `checkIn` 줄은 그대로 두고, 새 경로는 아래 v2.6 블록이 설명한다:

```
- `rotateAccount(personId, newAccount)` 확인 서명 키만, 7일 쿨타임. 옛 계정의 기기를 잠그고, 직전 계정을 24시간 되돌리기용으로 기록한다
```

`v2.5 추가(컨트랙트)` 블록 **위에** 새 블록을 넣는다:

```
**v2.6 추가(컨트랙트, 01b 번들 재배포 2026-10-05)**
- `Ticket`: `checkInLate(tokenId, G, S)` — 오프라인 큐 전용 입장 기록(12장). 게이트 계정만, 증명은 `checkIn`과 동일, 시계만 넓다(개장 −`LATE_WINDOW` ~ 폐장 +`LATE_WINDOW`, 12시간). 게이트가 열려 있을 필요는 없고 폐기된 게이트는 막힌다. `CheckIn`에 `late` 추가, 이벤트 `CheckedInLate(tokenId, gateId, issuedAt, ts)`.
- `Ticket`: 양도 승인 서명이 **EIP-712**가 된다. `TransferApproval(uint256 tokenId,bytes32 recipientCommitment,address recipient)` / 도메인 `(MONTI Ticket, 1, chainId, verifyingContract)`. 조회 `offerDigest(tokenId, commitment, recipient)`. 같은 서명이 다른 체인·다른 배포본에서 더는 유효하지 않다.
- `Ticket`: `migrate`에 `MIGRATE_DELAY`(24시간) 타임락. `tokenURI`가 취소된 행사를 "취소됨"으로 읽는다. `_update`가 보내는 쪽도 검사한다(잠김·탈퇴 계정은 전송 불가). `checkIn`이 보유자의 멤버십을 다시 본다. `requestOverride`가 행사 상태를 본다.
- `Identity`: `cancelRotation()` — **직전에 밀려난 계정만**, **교체 후 `ROTATION_UNDO_WINDOW`(24시간) 안에만**. 조회 `rotatedAt(personId)`, `rotatedFrom(personId)`, 이벤트 `RotationCancelled`. `rotateAccount`가 옛 기기를 잠그고, **되돌려도 그 잠금은 풀리지 않는다**(정상적인 `setActiveDevice` 경로로만 풀린다). `ROTATION_UNDO_WINDOW`는 `Ticket.MIGRATE_DELAY`와 같은 값이어야 한다.
- `Organizers`: `revokeGate`가 게이트 계정 매핑을 해제한다(폐기 뒤 재등록 가능, 페이마스터 스폰서 중단). `registerGate`가 반쪽 0 키를 거부한다.
- `Paymaster`: 허용 함수에 `checkInLate`, `cancelRotation`, `revokeGate`, `revoke`, `createOrganizer`, `transferOwner` 추가. **deployer 전용 `setAllowed(selector, kind, word)`** — 허용 목록 변경이 더는 재배포를 요구하지 않고, 남용되는 셀렉터를 한 트랜잭션으로 끌 수 있다.
- **입장 서명은 low-`s`만 받는다**(solady `P256.verifySignature`). 관객·게이트 기기 키로 서명하는 모든 클라이언트는 `s > N/2`이면 `s = N − s`로 정규화한 뒤 보낸다. 안 하면 정상 탭의 절반이 `DEVICE_MISMATCH`로 거절된다.
- **`Ticket.revoke`는 `PERM_CREATE_EVENT`를 가진 사람이 한다**(9.4 표에는 별도 행이 없다. 프로젝트를 만들 수 있는 권한이 그 프로젝트의 티켓을 무효화할 수 있다는 뜻이다).
```

**(e) §6.3 T14** — 이제야 그 행이 약속한 대응이 실제로 동작한다(I3·I4). 마지막 문장 `진짜 단말기를 도난당해도 관리자가 allowlist에서 빼면 끝`을 이렇게 바꾼다:

```
진짜 단말기를 도난당해도 관리자가 allowlist에서 빼면 끝이다. v2.6부터 그 폐기(`revokeGate`)는 **가스 없이** 되고, 폐기된 게이트 계정은 페이마스터의 스폰서 대상에서도 즉시 빠지며, 그 주소를 새 단말기로 **다시 등록할 수 있다**. 폐기된 게이트는 오프라인 큐(`checkInLate`)도 흘리지 못한다
```

**(f) §7.2 5·6단계** — 5단계의 `checkIn(tokenId, G, S)` 뒤에 한 문장을 붙이고,

```
인터넷이 끊긴 상태였다면 같은 값을 큐에 쌓아 두었다가 복구 후 `checkInLate(tokenId, G, S)`로 보낸다(12장)
```

6단계 ④의 `now - issued_at ≤ 60초`를 이렇게 바꾼다:

```
④ 현장 경로는 `now - issued_at ≤ 60초`. 복구 후 기록 경로(`checkInLate`)는 개장 −12시간 ~ 폐장 +12시간
```

**(g) 문서 헤더** — 1행 `# MONTI 기획서 v2.5 (최종 고정)`과 3행의 버전·상태 줄을 **v2.6**으로 올린다. 아래 v2.6 블록만 추가하고 헤더를 두면 문서가 자기 버전을 잘못 말한다.

- [ ] **Step 5: 고쳤는지 확인한다**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/MONTI-01b
S=docs/superpowers/specs/2026-09-20-monti-nfc-ticketing-design.md
grep -c "무력화" $S            # 0 이어야 한다 (T11 행에서 사라졌다)
grep -n "checkInLate" $S        # §12, §13, §7.3, §10.2 에 나온다
grep -n "cancelRotation" $S     # §6.3 T11, §5.5, §10.2
grep -n "일괄 취소(체인)" $S    # 0 이어야 한다 (§5.8 이 다시 쓰였다)
grep -n "v2.6 추가" $S          # 1
grep -c "v2.5 (최종 고정)" $S   # 0 이어야 한다 (헤더가 v2.6 으로 올라갔다)
grep -n "checkInLate" $S | wc -l  # 5 이상 (12, 13, 7.2, 7.3, 10.2)
```

- [ ] **Step 6: 커밋**

```bash
git add docs/superpowers/specs/2026-09-20-monti-nfc-ticketing-design.md
git commit -m "docs(spec): v2.6 — state what 01b actually built

T11 no longer claims a backend breach is 무력화: a compromised attester forges
KYC and can take an unused ticket unless the owner cancels within 24h, and the
KMS move is named as a pre-launch requirement. 12 names checkInLate and its
window. 5.8's '일괄 취소' is rewritten as a derivation, which is what it is."
```

---

## Task 17: 하위 플랜 문서를 새 인터페이스에 맞춘다

**Files:**
- Modify: `docs/superpowers/plans/2026-09-20-monti-04-staff-android.md` (T21, T22, T24, T28, T29)
- Modify: `docs/superpowers/plans/2026-09-20-monti-03-web-attendee.md` (주최자 플로우, 복구 화면)
- Modify: `MONTI-backend/indexer/schema.graphql`, `MONTI-web/indexer/schema.graphql`, `MONTI-staff/indexer/schema.graphql`
- Test: 각 저장소의 `indexer/test/schema.test.ts`

**Interfaces:**
- Consumes: Task 16까지의 모든 것
- Produces: 04가 `checkInLate`를 실제로 부르고, 03이 새 스폰서 사실과 복구 화면을 알고, 02가 `CheckIn.late`를 받을 스키마를 갖는다.

**이 Task가 없으면 C1이 체인에 올라간 채 아무도 안 쓴다.** `staff/gate/checkInOp.ts`·`staff/queue/opQueue.ts`·`staff/queue/reconcile.ts`·`staff/gate/verdict.ts`는 아직 **하나도 존재하지 않는 04의 산출물**이다. 즉 지금 시점에서 계약은 코드가 아니라 **플랜 문서**이고, 04 플랜에는 `checkInLate`도 `late` 필드도 EIP-712도 **한 번도 나오지 않는다.** T28의 `drainQueue`는 여전히 `sendCheckIn`을 부르게 쓰여 있다 — 그대로 구현하면 큐는 계속 `CodeExpired`로 되돌아온다.

- [ ] **Step 1: 04 플랜 T21에 늦은 경로 인코더를 더한다**

`docs/superpowers/plans/2026-09-20-monti-04-staff-android.md`의 Task 21에서, `Produces` 줄에 두 이름을 더하고

```
`encodeCheckInLateCall(code, response): Hex`, `sendCheckInLate(p): Promise<SponsoredOpHandle>` — Task 28 이 큐를 흘릴 때 쓴다
```

구현 코드 블록 아래에 다음을 덧붙인다:

```ts
// 복구 후 큐를 흘릴 때 쓰는 짝. 인자가 완전히 같고 functionName 만 다르다 — 현장 탭은 계속
// 'checkIn' 이다. 체인의 60초 창은 큐가 절대 통과할 수 없으므로(01b C1), 두 경로를 섞으면 안 된다.
export function encodeCheckInLateCall(code: GateCodeWire, response: GateResponseWire): Hex {
  return encodeFunctionData({
    abi: ticketAbi,
    functionName: 'checkInLate',
    args: [
      BigInt(response.tokenId),
      { gateId: BigInt(code.gateId), eventId: BigInt(code.eventId), issuedAt: BigInt(code.issuedAt), nonce: code.nonce },
      response.deviceSig,
    ],
  });
}
// sendCheckInLate: sendCheckIn 과 같고 encodeCheckInLateCall 을 쓴다.
```

테스트 지시(Step 1)에도 한 줄 더한다: `decodeFunctionData` 가 `encodeCheckInLateCall` 에 대해 `functionName === 'checkInLate'` 를 내고, 인자 세 개가 `checkIn` 과 동일할 것.

- [ ] **Step 2: 04 플랜 T28의 큐 흘리기를 `sendCheckInLate`로 바꾼다**

같은 파일 Task 28에서 `Consumes` 줄의 `sendCheckIn (Task 21)`을 **`sendCheckInLate` (Task 21)**로 바꾸고, `drainQueue` 구현 블록의 호출을 바꾼다:

```ts
      const handle = await sendCheckInLate({ code: entry.gateCode, response: entry.response, orgId: params.orgId });
```

그리고 Doc note에 한 문장을 더한다:

```
큐는 `checkIn` 이 아니라 `checkInLate` 로 나간다. 체인의 현장 창은 60초라 큐가 통과할 수 없고,
기록 창은 개장 −12시간 ~ 폐장 +12시간이다(01b C1, 스펙 12). 그 창이 닫힌 항목은 재시도해도
`CodeExpired` 이므로 '미기록' 으로 옮긴다.
```

- [ ] **Step 3: 04 플랜 T29의 대사 보고서에 `late`를 더한다**

같은 파일 Task 29에서 `ReconcileReport` 타입에 필드를 더하고

```
ReconcileReport = { confirmed: number; late: number; conflicts: Array<{tokenId; firstGateId; firstTs}>; failed: number; unrecorded: number }
```

`checkInOf` 읽기의 구조 분해를 고친다 — 반환 구조체에 `late`가 생겼다:

```ts
const onChain = await getPublicClient().readContract({ … functionName: 'checkInOf', args: [BigInt(entry.tokenId)] });
// onChain = { gateId, ts, nonceHash, manual, late }
```

그리고 `CodeExpired` / `EventEnded` 로 실패한 항목을 `failed` 가 아니라 **`unrecorded`** 로 세고 주최자 화면에 따로 보여주도록 한 문단을 더한다(스펙 12의 사후 대사).

- [ ] **Step 4: 04 플랜 T22와 T24를 손본다**

- **T22** revert→DENY 맵에 두 줄 추가: `NotMember` → `TX_FAILED`, `RotationPending` → `TX_FAILED`(§13에 대응 코드가 없다). 그리고 **`CodeExpired`의 문구가 경로에 따라 다르다**는 것을 적는다 — 현장은 "다시 대세요", 큐 흘리기는 "기록 창 만료, 미기록".
- **T24** `verdict.ts`는 **바꿀 것이 없다.** `checkInLate`도 같은 `CheckedIn(uint256,uint256,uint256,bytes32,uint64)`을 내므로 topic0과 인덱스 토픽이 동일하다. 그 사실을 한 문장으로 적어 두어(「늦은 경로도 같은 이벤트를 내므로 구독은 그대로다」) 구현자가 헷갈리지 않게 한다. 원하면 `CheckedInLate(uint256,uint256,uint64,uint64)` 구독을 더해 큐 흘림 건수를 화면에 띄운다.
- 04 플랜 5820행의 `CODE_WINDOW` ↔ `CODE_WINDOW_SECONDS` 이름 불일치 메모 옆에 `LATE_WINDOW` ↔ `LATE_WINDOW_SECONDS`도 같은 관계임을 적는다.

- [ ] **Step 5: 03 플랜에 새 사실 두 가지를 적는다**

`docs/superpowers/plans/2026-09-20-monti-03-web-attendee.md`의 주최자 태스크(T30, 라이프사이클·팀·초대·게이트 등록·대시보드)에 **삭제가 아니라 추가**를 한다. 초안은 "그 제약을 지운다"고 적었지만 **그 제약은 03 플랜에 애초에 없다**(`createOrganizer`·`transferOwner`·`revokeGate`·`R-F4` 검색 결과가 0이다). 즉 03은 그 제약을 들어본 적이 없으므로, 사실을 새로 적어 넣는다:

```
주최자 조작은 전부 가스리스다. 01b 이후 `createOrganizer`, `transferOwner`, `revokeGate`,
`Ticket.revoke` 네 개가 페이마스터 허용 목록에 있으므로 주최자 계정에 MON 이 없어도 된다.
다만 **조직 오너·관리자·매니저 계정도 Identity 멤버여야** 페이마스터가 받는다(I5) — 가입을
먼저 끝내고 조직을 만든다.
```

그리고 복구 화면에 한 항목을 더한다:

```
계정 교체를 되돌리는 버튼은 `rotatedFrom(personId) == 내 주소 && now < rotatedAt + MIGRATE_DELAY`
일 때만 보인다. 되돌린 뒤에도 기기 잠금은 남으므로 이어서 "새 기기 등록"(`setActiveDevice`)을
안내하고, 마지막 기기 변경으로부터 7일이 안 지났으면 그 날짜까지 비활성으로 렌더한다.
`migrate` 가 `RotationPending` 으로 되돌아오면 "N시간 후 사용 가능" 으로 보여준다.
```

- [ ] **Step 6: 인덱서 스키마에 `late`를 더한다 (세 저장소)**

`indexer/schema.graphql`의 `CheckIn` 엔티티에 한 줄과 주석 한 줄:

```graphql
# Ticket.CheckedIn(tokenId, eventId, gateId, nonceHash, ts) — manual false;
# Ticket.ManualOverride writes the same row with manual true and a zero nonceHash.
# Ticket.CheckedInLate(tokenId, gateId, issuedAt, ts) in the same transaction sets late true (spec 12).
type CheckIn {
  id: ID!            # tokenId
  gateId: BigInt!
  ts: BigInt!
  nonceHash: String!
  manual: Boolean!
  late: Boolean!
  txHash: String!
  block: BigInt!
}
```

핸들러는 아직 하나도 없으므로 **구현은 02 T36 인계 항목**이다. 01b는 스키마 한 줄과 그 커밋된 테스트만 옮긴다.

```bash
for R in MONTI-backend MONTI-web MONTI-staff; do
  ( cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/$R && npm test -w indexer ) || echo "FAILED: $R"
done
```

Expected: 셋 다 PASS(`schema.test.ts`가 필드 목록을 단언하고 있으면 `late`를 같이 추가한다).

- [ ] **Step 7: 커밋 (저장소마다)**

```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/MONTI-01b
git add docs/superpowers/plans/2026-09-20-monti-04-staff-android.md docs/superpowers/plans/2026-09-20-monti-03-web-attendee.md
git commit -m "docs(plans): point 04's queue at checkInLate and tell 03 the organizer ops are sponsored

04 T28 flushes with sendCheckInLate, T21 keeps checkIn for live taps, T29 reports
late/unrecorded, T22 gains two DENY rows. T24 is unchanged on purpose — the late
path emits the same CheckedIn. 03 learns that the four organizer ops no longer
need MON, and how to render the rotation-undo window."

for R in MONTI-backend MONTI-web MONTI-staff; do
  git -C /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/$R add indexer
  git -C /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/$R commit -m "feat(indexer): CheckIn.late for the offline queue (01b C1, hand-off to 02 T36)"
done
```

---

## Self-Review

플랜을 다 쓴 뒤 스펙·최종 리뷰·플랜 리뷰를 다시 보며 스스로 돌린 점검이다.

**0. 플랜 리뷰(2026-09-21)의 지적 반영**

| 지적 | 어디서 고쳤나 |
|---|---|
| E4 / §3 `cancelRotation`이 취약하다 (`_personOf`는 영원히 남아 "가져본 모든 계정"이 시한 없이 되돌릴 수 있고, 잠금까지 풀어 T6 DoS가 된다) | 설계 D2 전면 재작성 + Task 5 — `_rotatedFrom` 한 칸, 24시간 창, **잠금 유지**. 테스트 8개 중 4개가 이 구멍 자체를 겨냥한다 |
| §4 코드 크기 룰링 | Task 1이 `code_size_limit = 131072`로 바뀌었다. D5 재작성, 탈출구 삭제, Tasks 2·4·5·8·9의 크기 게이트 삭제, Task 12가 런타임·이니트코드 둘 다 131,072로 단언 |
| §4 OZ `EIP712` 사용 | 설계 D3 재작성 + Task 9 — `EIP712("MONTI Ticket","1")`은 기반 생성자 호출이라 `Deploy.s.sol` 불변. `eip712Domain()`이 델타에 추가됐다 |
| §4 >24 KB와 번들러를 실증하라 | **Task 15 Step 0** 신설 — 폐기용 `SizeProbe`를 Monad 테스트넷에 올리고, 스폰서 UserOp 한 건을 Pimlico로 통과시킨다. Step 4 끝에 새 배포에서 한 번 더 |
| E1 소비자 저장소에서 `export-abi.sh`를 돌리면 옛 소스가 나온다 | Task 13 재작성 — 워크트리에서 한 번 내보내고 **JSON을 복사**한다 |
| E2 `MONTI-staff`가 빠졌다 | Global Constraints·델타 표·Task 13·Task 15 전부 네 저장소로 |
| E3 오프체인 `offerDigest`가 이미 있다 | 델타에 `@monti/shared` 절 신설 + **Task 9가 컨트랙트와 `encoding.ts`와 고정 벡터를 한 커밋에** 담는다(Step 3b/3c/3d) |
| E5 하위 플랜 문서를 아무도 안 고친다 | **Task 17** 신설 — 04 T21/T22/T24/T28/T29, 03 주최자·복구 화면, 인덱서 스키마 `CheckIn.late` |
| E6 `MEMBER_FUND_WEI` 0.02 → 0.1 | Task 14 |
| Task 15에 계정 재등록·스테이크 회수가 없다 | **Step 8**(옛 `Identity` 계정 재등록, 티켓·닉네임·잠금이 안 따라온다는 고지 포함), **Step 9**(`unlockStake`/`withdrawStake`/`withdrawPlatform`) |
| 숫자가 낡았다 (HEAD, 테스트 수, 셀렉터 수) | HEAD `f8e577d` / 260 기준선 / 23 셀렉터로 교정. Task 1~4의 기대값 260·263·266·269 |
| Minor 9·10의 처분이 없다 | D6에 두 줄 추가 |
| §2 C1 잔존 위험을 더 정확히 | D1 표의 "신규 잔존 위험" 행 재작성 — 하한은 *코드의 나이*만 묶고 *보유 시간*은 안 묶는다(6시간 행사면 최대 30시간), 재생은 1회 입장이 막는다, nonce 레지스트리는 원래 없다 |
| §2 스펙 패치에 T14·§7.2가 빠졌다 | Task 16에 (e) T14, (f) §7.2 5·6단계, (g) 문서 헤더 v2.6 추가 |
| 백엔드 호출 집계가 틀렸다 | 델타 02-7을 읽기 18(+`nicknameOwner`)·쓰기 5(+`setAdmin`/`setManager`)로 교정 |
| 03 T30에 지울 제약이 없다 | 델타 03-5와 Task 17 Step 5를 "삭제"가 아니라 "사실로 추가"로 |

**1. 최종 리뷰 항목 커버리지**

| 리뷰 항목 | Task | 비고 |
|---|---|---|
| C1 오프라인 큐 | 8 | `checkInLate`. 설계 D1 |
| C2 고-`s` | 7 | 컨트랙트 변경 없음. 클라이언트 정규화는 R-F2로 03/04 소관 |
| C3 어테스터 침해 | 5 | `_rotatedFrom` + 24시간 창 + 타임락. 설계 D2. KMS는 R-F3대로 메인넷 전 |
| I1 `_update` from-가드 | 3 | `_internalMove` 분기 **안**에, `isMember` → `isLocked` 순서 |
| I2 회전 잠금 + `checkIn` 멤버십 | 4 | |
| I3 `revokeGate` | 6 | |
| I4 허용 목록 + `setAllowed` | 11 | |
| I5 조직 오너 멤버십 | 17 | R-F4. 컨트랙트 변경이 아니라 03 플랜에 적는 사실 |
| I6 스테이크 | 15 Step 9 | 새 배포는 R-F5대로 1 MON. 옛 배포의 스테이크는 회수한다 |
| I7 레이트 리밋 | — | post-MVP. `setAllowed`가 정지 스위치를 준다(11) |
| I8 도메인 분리 | 9 | 컨트랙트 + `encoding.ts` + 고정 벡터를 한 커밋에 |
| I9 취소된 행사 | 2 | |
| I10 UserOp 가스 | 12, 15 Step 4 | 콜 단위 숫자는 12, 실 UserOp 4필드는 15 Step 4에서 04가 받아 적는다 |
| Minor 1 배포본 불일치 | 15 | 재배포가 해소한다 |
| Minor 2 반쪽 0 게이트 키 | 6 | |
| Minor 3 공유 데모 기기 키 | 14 | 경고 주석 |
| Minor 4 자리표시자 게이트 키 | 14 | |
| Minor 5 `requestOverride` 상태 | 10 | |
| Minor 11 `revoke` 권한 문서화 | 16 | v2.6 블록 |
| Minor 6·7·8·9·10 | — | D6에 각각 기각/이관 사유 |
| Spec drift 1·2·6 | 16 | |
| Spec drift 3 (KMS) | 16 | 메인넷 전 요구사항으로 명시 |
| Spec drift 4·5·7~13 | — | 의도된 결정이거나 이미 일치 |

**2. 자리표시자 점검**

"TBD", "적절히 처리", "Task N과 비슷하게"는 없다. 모든 코드 스텝에 실제 Solidity/TS/bash가 들어 있다. 실행자가 기존 파일의 이름을 읽어 맞춰야 하는 곳은 다섯 군데이고 각각 "이름이 다르면 그 파일의 것을 따른다"를 붙였다: Task 5의 `CAROL` 상수, Task 6의 `_registerGate` 헬퍼, Task 10의 `MANAGER` 변수명, Task 14의 `_runSeedWithGateKey`, Task 17의 04/03 플랜 내 소제목. 값이 실행 중에 정해지는 곳은 셋이며 전부 그 자리에서 뽑는 절차를 적었다: Task 9 Step 3b의 새 고정 벡터, Task 12의 크기·가스 숫자, Task 15의 새 주소.

**3. 타입 일관성**

- `LATE_WINDOW`: Solidity `12 hours` = 43,200 · TS `LATE_WINDOW_SECONDS = 43_200` · 스펙 "12시간". 셋이 같다.
- `MIGRATE_DELAY`(Ticket) = `ROTATION_UNDO_WINDOW`(Identity) = `1 days` = 86,400 · TS `MIGRATE_DELAY_SECONDS` · 스펙 "24시간". **두 컨트랙트 상수가 같은 값이어야 한다는 것을 Task 5의 `test_theUndoWindowAndTheMigrateTimelockAreTheSameLength`가 단언한다.**
- `CheckIn` 필드 순서 `{gateId, ts, nonceHash, manual, late}` — Task 8 구현, Task 8·12 테스트, Task 13의 `jq` 확인, 델타 표, Task 17의 04 주석이 전부 같다.
- `checkInLate(uint256,(uint256,uint256,uint64,bytes32),bytes)` — Task 8·11·15·17, 델타, 04 노트가 전부 동일.
- `offerDigest`: 온체인 `(uint256,bytes32,address)`, 오프체인 `{chainId, ticket, tokenId, recipientCommitment, recipientAccount}`. **두 모양이 다른 것은 의도적이다** — 온체인은 `block.chainid`와 `address(this)`를 스스로 알고, 오프체인은 몰라서 받아야 한다. 같은 값을 낸다는 것은 Task 9 Step 3b의 벡터가 잇는다.
- `ArgKind`는 ABI에서 `uint8`이다 — `setAllowed`의 델타 표기와 Solidity 파라미터 타입이 달라 보이지만 같은 것이며 그 사실을 표에 적었다.

**4. Task 순서의 의존성**

1(크기 한도) → 전부. 4(회전 잠금) → 5(취소가 그 잠금을 **유지**한다는 테스트가 4의 결과를 읽는다) → 3의 기대값 안정성(그래서 3의 검사 순서를 `isMember` 먼저로 고정했다). 6(`revokeGate`가 `_gateOf` 삭제) → 8(늦은 경로의 폐기 게이트 테스트). 7(고-`s`) → 8(늦은 경로에도 같은 요구). 5·8 → 11(새 셀렉터). 1~11 → 12(크기·가스) → 13(ABI) → 14(시드) → **15 Step 0(체인·번들러 실증)** → 15 나머지 → 16(스펙) → 17(하위 플랜·스키마). 9는 3~8 어디에 끼어도 되지만 13 앞이어야 한다.

**5. 남은 위험 두 가지 (실행자가 반드시 알 것)**

- **크기가 아니라 체인.** 한도는 Task 1이 128 KB로 풀었으므로 구현 중에 바이트를 걱정할 일은 없다. 대신 **Task 15 Step 0**을 건너뛰면 안 된다 — 128 KB 가정이 틀리면 재배포가 Step 2에서 통째로 실패하고, 번들러 거부는 온체인 흔적을 남기지 않는다.
- **`Paymaster.t.sol`의 기존 단언 두 개가 뒤집힌다**(200행의 `createOrganizer`, 212·219행의 `revoke`). Task 11이 명시하지만, 다른 Task에서 전체 회귀가 이 둘 때문에 빨개지면 원인은 그것이다.
