# MONTI 홀더 게이팅(보유자 전용) — 설계 부록 (2026-10-01)

상태: 설계 부록(코드 변경 없음, 배포 없음, 커밋 없음). 정산 설계/계획
(`2026-10-01-monti-settlement-split-{design,plan}.md`)의 **애드온 배치**이며, 핵심 4개 컨트랙트
(Ticket/Organizers/Identity/Forwarder) **무변경** 원칙을 그대로 지킨다.

근거 파일(읽음): `MONTI-01b/contracts/src/Identity.sol` — 어테스터가 설정 가능한 건
`register`/`rotateAccount`/`setKycLevel` 뿐이고 **범용 badge/attribute 매핑이 없다**; `kycLevelOf`
는 `_kycLevel[_personOf[account]]` 즉 **personId 키라 "행사별" 상태를 담을 수 없다**.
`Ticket.sol` — `EventMeta{approvalRequired, requireKyc, ...}`; `_claimTo` 가
`requireKyc && identity.kycLevelOf(to) < 1` → `KycRequired` revert; 릴레이 경로는
`claimFor`(→`_claimTo`)와 `requestClaimFor`(승인제, 같은 KYC 검사).

## 0. 창업자용 한국어 요약 (≤12줄)
- **무엇을 하나.** 주최자가 행사를 "보유자 전용"으로 걸면, 관객은 외부 지갑을 한 번 연결(서명)해 소유를 증명하고, 그 지갑이 지정 토큰/NFT를 **지금 보유**한 경우에만 티켓을 받는다.
- **어디서 막나(핵심).** 보유 검사는 **백엔드가 발급을 중계(relayClaim)하기 직전**에 한다 = MONTI 신뢰 게이트. 규칙은 해시로 기록해 위변조는 검증되지만 체인이 발급을 강제하진 않는다(오프체인 집행 + 규칙 해시 기록). **핵심 4 컨트랙트 0줄 변경.** 게이트 토큰이 보통 **다른 체인**에 있어 Monad가 그 잔액을 직접 못 봐서, 어느 방식이든 "MONTI(어테스터)가 확인"이 상한선이다.
- **web3 낱말 예외.** 이 기능 화면(지갑 연결·보유자 인증·연결된 지갑·주최자 보유자 설정)에서만 "지갑/토큰/NFT"를 **써도 된다** — 사용자가 선택한, 본질적으로 web3인 기능이라서. 다른 화면의 금지 규칙은 유지.
- **공수.** 백엔드 콜러블(link/verify/unlink/gate/setRule) + Firestore 문서·규칙 + 주최자 설정 폼 + 관객 인증 플로우(WalletConnect) + e2e ≈ **4~6일**. 컨트랙트 변경 0 → 정산 파일과 **충돌 없음**.
- **일정.** 정산 데모(10-13)가 영웅 스토리, D10–D12는 리허설 구간 → **1순위 권장 = 데모 이후(10-13+) 별도 배치 J**. 꼭 데모에 넣으면 토큰을 **Monad 테스트넷**에 두고(멀티체인·스마트지갑 제외) 최소 컷을 D10–D12에 "가장 먼저 자를 기능"으로 병렬.
- **큰 위험.** ① 멀티체인 RPC 한도·도달성(데모는 Monad 단일) ② 토큰 돌려쓰기 시빌("지갑당 1인" 역인덱스로 완화, 완전차단은 스냅샷/후속) ③ 지갑 주소 프라이버시(주소는 서버에만, 주최자엔 "인증 완료"만 노출).

## 읽는 순서
Q1 지갑 연결 · Q2 보유 확인 · Q3 집행 위치 · Q4 UX · Q5 범위·일정·위험.

---

## Q1 — 지갑 연결 (attendee ↔ 외부 EVM 지갑)

### 결정
- **전송 = WalletConnect v2(Reown AppKit)**, 주입형(injected, MetaMask 인앱 브라우저)은 **자동 폴백**. 모바일 웹에서 다수 지갑을 QR/딥링크로 커버하는 표준이라서.
- **증명 = EIP-4361(SIWE) 메시지.** 서버 발급 nonce로 `domain + address(외부지갑) + chainId + nonce + issuedAt + expirationTime` 서명. MONTI의 `personId`·스마트계정 `account` 는 메시지 `statement`/`resources` 에 바인딩 → "이 외부 지갑 소유자가 MONTI 사용자 X" 를 묶는다.
- **검증 = viem.** EOA 는 `verifyMessage`/`verifySiweMessage`; 스마트 지갑은 **EIP-1271**(viem public client 전달 시 자동 처리, 해당 체인 RPC 필요). 데모는 EOA 우선, EIP-1271 은 여유 시.
- **개수 = 사람당 여러 지갑 허용, 지갑당 1인 고정.** 사용자는 여러 지갑에 토큰을 나눠 들 수 있으니 다대일 링크를 허용하되, **역인덱스 `walletOwners/{addr} → personId`** 로 한 지갑이 두 사람에 묶이는 것을 막는다(핵심 시빌 레버). 주소는 소문자 정규화.
- **재검증 주기.** 서명(소유 증명)은 **지속**(키 소유는 만료 안 함) — 데모는 재서명 강제 없음, unlink 로만 해제. **보유량**은 발급 때마다 라이브 재확인(Q2). 선택: 90일 경과 링크 재서명 요구(후속).
- **web3 낱말 예외(명시).** 이 화면들에서만 "지갑/토큰/NFT/서명" 허용. 사용자가 **정의상 지갑 보유자**이므로 "지갑 연결" 이 가장 정확한 표현 — 다른 화면 금지 규칙은 불변.

### 기각한 대안
- **주입형 전용(MetaMask 인앱 브라우저):** MONTI를 지갑 앱의 dapp 브라우저에서 열어야만 동작 → 모바일 웹(사파리/크롬) 다수에서 실패. 폴백으로만.
- **비표준 서버 챌린지:** SIWE(EIP-4361)가 이미 nonce·만료·도메인 바인딩 표준 → 재발명 안 함.

### 데이터·콜러블
```
// Firestore: walletLinks/{personId}/wallets/{addrLower}
WalletLink { address: string(checksum), chains: number[], verifiedAt: ts, method: "eoa"|"erc1271", lastNonce: string }
// Firestore: walletOwners/{addrLower}  (역인덱스·유일성, 서버 전용)  { personId, linkedAt }

getWalletLinkNonce(): { nonce, expiresAt, statement }        // personId 바인딩, TTL 5분, 1회용
linkWallet({ address, chainId, message, signature })
  -> { ok, address, linkedAt } | { error: "BAD_SIG"|"WALLET_TAKEN"|"NONCE_EXPIRED" }
  // 서버: step1 nonce+personId 로 기대 메시지 재구성 → verifySiweMessage(EIP-1271 인지)
  //       → walletOwners 유일성 강제 → walletLinks + walletOwners 기록
unlinkWallet({ address }) -> { ok }      // walletLinks + walletOwners 제거
```

---

## Q2 — 보유 확인 (holder check)

### 결정
- **규칙(주최자 지정) = HolderRule.** `{chainId, tokenAddress, standard(ERC721|ERC1155|ERC20), minBalance, tokenIds?}`. 트레잇 게이팅은 토큰 메타데이터 열람·소유 토큰 열거가 필요 → **MVP 보류**(컨트랙트/토큰ID 단위만).
- **검사 = RPC balanceOf, 라이브 + 짧은 캐시(권장).**
  - ERC721: `balanceOf(addr) >= minBalance`(보통 1); 특정 tokenId면 `ownerOf(tokenId)==addr`.
  - ERC1155: `balanceOf(addr, tokenId) >= minBalance`(tokenId 필수; 다수는 `balanceOfBatch`).
  - ERC20: `balanceOf(addr) >= minBalance`(base units; `decimals()` 반영).
- **스냅샷 vs 라이브 = 라이브(발급 시점) + 60–120초 캐시.** 라이브가 "지금 보유" 사용자 멘탈모델과 일치. 캐시로 RPC 한도·이중호출(인증 단계 + 발급 단계) 흡수. 스냅샷(블록 고정)은 전송·시빌엔 강하나 인덱서·블록 선택·"나중 구매자 거부" 문제 → 후속 옵션.
- **이중 검사점.** (1) **인증 때**(`verifyHolder`): 연결된 지갑들로 검사해 녹색 배지 + 캐시 채움. (2) **발급 때**(relayClaim 직전): 캐시 신선하면 재사용, 아니면 재질의 = **권위 게이트**(Q3).
- **멀티체인 설정.** 백엔드 `chains.ts` 허용목록만 주최자에게 노출(미지원·도달불가 체인 차단). 데모 기본 = **Monad 테스트넷(10143)**(동일 테스트넷, RPC 키 의존 0). 메인넷(Ethereum 1·Base 8453)은 Alchemy 키. viem `createPublicClient` 를 체인별 메모이즈 + `multicall`/동시성 제한.

### 데이터·콜러블
```
// Firestore: eventPrivate/{eventId}.holderRule  (getEventPrivate/setEventPrivate 경유)
HolderRule { enabled: bool, chainId, tokenAddress, standard, minBalance: string(base units),
             tokenIds?: string[], display?: { name, symbol } }
ruleHash = keccak256(canonicalJSON(rule - display))      // 위변조 증거(Q3)
// 서버 캐시: holderCache/{chainId}:{token}:{addrLower}  { balance: string, at: number }  TTL 60–120s

verifyHolder({ eventId, address? })
  -> { eligible: bool, wallet, balance, checked: {chainId, token, standard, minBalance} }
  // address 생략 시 연결된 모든 지갑 검사 → 통과하는 첫 지갑 반환
```

---

## Q3 — 집행 위치 (enforcement)

### 결정: (a) 백엔드 게이트 + 규칙 해시 기록. (b) 온체인 집행은 후속.
- **집행 = 백엔드.** 릴레이 경로(`relayClaim`→`Ticket.claimFor`, 및 승인제 `relayRequestClaim`→`requestClaimFor`)가 발급을 중계하므로, 홀더 전용 행사면 **중계 직전 `verifyHolder` 통과를 요구**하고 실패 시 `HOLDER_REQUIRED` 로 거절(새 컨트랙트 함수 없음). `requireKyc` 가 `_claimTo` 에서 막는 것과 **같은 자리의 오프체인 판본**.
- **규칙 기록.** `HolderRule` 원문은 Firestore, `ruleHash` 로 위변조 검증 가능(정산 설계의 reasonHash 패턴과 동일). 즉 **규칙은 감사 가능**, 단 **발급 거절을 체인이 강제하진 않음**(MONTI 신뢰).
- **왜 지금 온체인 집행 불가(명시).**
  - Identity 에 **범용 badge/attribute 매핑이 없다** — 어테스터 설정 가능한 건 `kycLevel`(uint8) 뿐이고, 그마저 **personId 키라 행사별 상태를 못 담는다**(`kycLevelOf` = `_kycLevel[_personOf[account]]`).
  - 새 플래그/매핑 추가 = Identity 또는 Ticket **코드 변경** = 정산 스프린트 **동결(core 4 git diff 0)** 위반. Ticket 은 크기 한계 근처.
  - 결정적으로 **게이트 토큰이 보통 타 체인**(이더리움/베이스)이라 Monad 컨트랙트가 그 `balanceOf` 를 **직접 못 본다** → 오라클/스토리지 증명 없이는 어떤 온체인 방식도 "어테스터가 확인해 준다" 가 상한.
- **(b)로 가는 길(후속).** Identity 에 **범용 어테스터 badge** 추가: `setBadge(personId, badgeId)` / `hasBadge(account, badgeId)` + `BadgeSet(account, badgeId)`. 어테스터가 오프체인 보유 확인 후 badge 세팅 → Ticket(또는 신규 게이팅 컨트랙트)이 `requireKyc` 처럼 `requireBadge → hasBadge(to, eventBadgeId)` 강제. 멀티체인 RPC 는 오프체인 유지(체인 간 조회 불가라 당연), **집행만 온체인**. **완전 트러스트리스**는 Monad 네이티브 토큰이거나 스토리지 증명 오라클일 때만 — 범위 밖.

### 한 줄 요약(무엇이 어디서 강제되나)
- **강제(체인):** 신원·발급·입장(기존 그대로). **홀더 조건은 체인이 강제하지 않음.**
- **강제(백엔드):** 홀더 전용 행사의 발급 중계 차단(verifyHolder 불통과 시).
- **기록(해시):** 홀더 규칙 원문(Firestore) + `ruleHash`(위변조 검증).

---

## Q4 — UX

### 주최자
- 행사 생성/수정에 **"홀더 전용" 토글**(기존 승인제/KYC 토글 옆). 켜면 **토큰 스펙 폼:** 컨트랙트 주소 붙여넣기 · 체인 선택(허용목록 드롭다운) · 표준(ERC-165 `supportsInterface` 자동감지 또는 선택) · 최소 수량 · (선택) tokenIds.
- **미리보기/검증 버튼:** 컨트랙트 도달성 + 표준 확인 + `name()`/`symbol()` 읽어 표시(주소 오입력 방지). 데모 여유 없으면 컷.
- 카피: 이 화면은 "지갑/토큰/NFT" 허용(Q0 예외).

### 관객 (홀더 전용 행사)
- "티켓 받기" 앞에 **"보유자 인증하기"** 단계 삽입:
  1. **지갑 연결**(AppKit) → SIWE 서명 → 링크.
  2. **보유 확인**(`verifyHolder`) → 통과 시 "인증 완료" 배지 → "티켓 받기" 활성화.
  3. **실패 카피(명확):** 조건을 토큰명·최소수량·체인과 함께 안내 — 예: "연결한 지갑에서 OO(최소 N개, △△ 체인) 보유를 확인하지 못했어요. 다른 지갑을 연결하거나 보유량을 확인해 주세요."
- **프로필 > 연결된 지갑:** 목록(주소 축약 + 체인 + 인증일) + **연결 해제**(확인 후 역인덱스까지 제거).
- 이 기능 밖 화면엔 web3 낱말 **없음**(기존 규칙 유지).

### 프라이버시
- 외부 지갑 주소는 **서버에만** 저장. 주최자·타 관객에겐 주소 대신 **"인증 완료(보유자 N명)"** 만 노출(주소 비공개). 역인덱스는 Admin SDK 전용. 사용자는 기능 사용으로 동의, unlink 로 철회.

---

## Q5 — 범위 · 일정 · 위험

### 작업 (배치 J, 컨트랙트 변경 0)
| # | 작업 | 규모 | 의존 |
|---|---|---|---|
| J1 | 백엔드 콜러블 getWalletLinkNonce/linkWallet/unlinkWallet (SIWE·EIP-1271·역인덱스 유일성) | M | WalletConnect projectId(Reown, 무료) |
| J2 | 백엔드 verifyHolder + 멀티체인 viem 클라이언트 + 캐시; setHolderRule(권한=주최자, ruleHash) | M–L | chains.ts·RPC 키 |
| J3 | **게이트:** relayClaim/relayRequestClaim 직전 holderRule.enabled 시 verifyHolder 강제(HOLDER_REQUIRED) | S | J2 |
| J4 | Firestore 문서·규칙·인덱스 (walletLinks=소유자만, walletOwners=서버전용, holderRule=관객 읽기/주최자 쓰기) | S | — |
| J5 | 웹 주최자 홀더 전용 토글 + 스펙 폼(+검증 미리보기) | S–M | J2 |
| J6 | 웹 관객 보유자 인증 플로우(AppKit 연결→서명→확인→배지) + 프로필 연결 지갑/해제 | M–L | J1·J2 |
| J7 | e2e (테스트 지갑 + Monad 테스트넷 테스트 토큰): 인증→발급 허용/차단 | M | J3·J5·J6 |

합계 ≈ **4~6 에이전트일.** 임계경로 J1→J2→J3, J4 병렬, J5‖J6 → J7.

### 일정 (정산 12일 캘린더 대비)
- 정산이 D1–D12 점유, **D10–D12 = 통합/e2e/리허설**(여유 적음). 홀더는 컨트랙트 0이라 **정산 파일·core4 와 무충돌**이지만 **백엔드·웹 에이전트 용량을 공유**(정산 C/D/E/F 와 경쟁).
- **1순위 권장: 데모 이후(10-13+) 별도 배치 J.** 영웅 스토리는 정산 — 리허설 창에 WalletConnect·멀티체인 의존을 넣어 메인 데모를 흔들지 않는다.
- **데모 포함을 원하면:** 최소 컷(백엔드 게이트 + 주최자 1필드 + 관객 1화면; 지갑 1개; 라이브 검사만; **게이트 토큰 = Monad 테스트넷**; EIP-1271·트레잇·tokenIds 제외)을 **D10–D12 병렬, "가장 먼저 자를" 배치**로. 파일 격리·컨트랙트 0 이라 머지 안전하나 리허설 리스크는 존재.

### 자를 것 (압박 시, 역순)
1. 멀티체인 → Monad 테스트넷 단일. 2. EIP-1271 스마트지갑 → EOA 전용. 3. 트레잇/tokenId → 컨트랙트 단위 balanceOf. 4. 다중 지갑 → 사람당 1지갑. 5. 검증 미리보기 버튼. 6. 온체인 badge 경로 → 명확히 후속.

### 위험 · 엣지케이스
- **RPC 한도/도달성:** 캐시 + 프로바이더 키 + 데모는 Monad 단일. 허용목록으로 미지원 체인 차단.
- **EIP-1271 스마트지갑:** viem public client 가 처리하나 배포된 지갑+RPC 필요 → 데모 EOA 전용.
- **시빌(토큰 돌려쓰기):** "지갑당 1인" 역인덱스가 **디지털 대여**를 막는다. **물리적 토큰 전송**(실제 넘겨줌)은 홀더 게이팅의 본질적 한계 — 완전 차단 불가, 스냅샷 모드가 더 강한 레버(후속). 미해결로 명시.
- **프라이버시:** 외부 지갑 연결은 MONTI 신원↔온체인 이력 연결 위험 → 주소 서버 전용·비공개·unlink 제공.
- **신뢰 모델:** 백엔드 게이트 = MONTI 가 우회·위조 가능(데모 허용). `ruleHash` 는 **규칙**의 위변조만 막고 **집행**을 보장하진 않음 — 온체인 집행은 후속(Q3b).
- **외부 의존:** Reown(WalletConnect) projectId(무료), 메인넷 RPC 키 — 데모 전 확보. T0 식 착수 게이트로 "지갑 연결 1건 + balanceOf 1건 라이브" 선확인 권장.
