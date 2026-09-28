# Expert 5 — 상태·대기·신뢰·복구 리뷰 (MONTI web)

기준 바: **"중학생도 혼자 끝까지"**. 렌즈: 모든 대기 지점에서 (무슨 일이 일어나는지 / 됐는지 아는지 /
중간에 나가거나 새로고침하면 / 실패하면 다음 행동 / 무료·안심 문구)를 본다.
소스: MONTI-web mvp-web `ca9c8d7`. 등급 = 14세가 지금 무슨 일인지 아는 정도(1~5).

## 1. 비동기 액션 지도 (트리거 → 진행 → 완료/실패)

| 액션 | 진행 표시 | 보통/최대 | 성공 신호 | 실패 → 다음 행동 | 나감·새로고침 | 등급 |
|---|---|---|---|---|---|---|
| **행사 생성** `usePublish/CreateEvent` | OpProgress 저장→확인, 경과초, "보통 3~10초", 10초 슬로우, 45초 캡 | 12초 / 45초 | done 화면(성공체크·QR·링크) | 캡→**결정블록**(다시 시도/나중에 확인), 멱등 | 초안에 opHash·id 저장, 홈 배너가 자동 해소 | **5** |
| **발행** `Dashboard` | OpProgress(확인) + 인덱서 폴링(`Dashboard.tsx:120`) | ~12초 | `life.published` 알림 | 리버트 문장, 폴링이 새로고침 대체 | 로컬 outcome 유실, 재진입 시 인덱서로 상태 복원 | **4** |
| **가입 등록** `Register` | Steps 3점 + 스피너 + 10초 슬로우 한 줄 | ~10초 / 30초+ | done 화면 | 단계별 문장 + 다시 시도, 키없음→건너뛰기 | sessionStorage 보존, 챌린지 재발급 | **4** |
| **로그인(패스키)** `Login` | 스피너 + "확인하고 있어요"만 | **콜드 ~7초** | `/tickets` 이동 | 자동재시도 2×1.5초 후 다시 시도 | 미보존, 재탭 | **3** |
| **본인인증(Didit)** `VerifyIdentity` | 스피너 + "확인하고 있어요"만, **90초** 폴링 | 30초 / 90초 | 레벨↑ 후 복귀 | 거절→ContactLink, 타임아웃→다시 확인, inFlight→대기 | 웹마커/딥링크로 복귀 재개 | **4** |
| **OTP 확인/재전송** `Verify` | busy 비활성(스피너 없음), 60초 재전송 카운트다운 | ~2초 | exit 이동 | 코드틀림/만료 등 구체 문장, 단일사용 래치 | sessionStorage | **4** |
| **티켓 받기(claim)** `Claim` | **OpProgress "saving" 고정**(단계 안 넘어감), 15초 wait | **~3.5초** / 15초 | **없음** — `navigate('/tickets')` 즉시(`:165`), 인덱서 1~2초 지연 | **"티켓을 받지 못했어요"만, 재전송 없음**(라이브 S1: 둘째 이용자 실패) | **미보존**, 재탭 시 중복 위험 | **2** |
| **신청/신청취소(승인제)** `Claim` | OpProgress "saving" | ~3.5초 | 신청완료 알림, refetch | 확인중 알림뿐, 재전송 없음 | 미보존 | **2.5** |
| **양도/초대 받기** `transfer` | 확인중 알림 "내 티켓에서 확인" | ~3.5초 | "티켓을 받았어요" | 재전송 없음, describeFailure | 미보존 | **3** |
| **내 티켓 목록/상세** | Skeleton/Spinner | 1~2초 | 행 표시 | describeFailure + 다시 시도, 상세는 오류≠없음 구분 | React Query 재조회 | **4** |
| **게이트 입장(NFC)** `enter/Result` | arming→armed(60초)→verifying→확인→기록 다상태 | 수초 | "입장 완료" | 태그 실패류 재탭 안내 | 네이티브 | **4** |

핵심: **생성 경로는 만점(모델), 받기 경로는 낙제**. 정확히 이 대비가 문제다.

## 2. 불일치 패턴 (같은 대기인데 화면마다 다름)

- **재전송/멱등**: 생성·발행·수정은 `submittedOpHash`+`resolveSubmittedOp`+stale 재전송+홈 배너로 무정지.
  **claim·신청·양도·받기는 전무** — 한 번 안 실리면 그대로 끝(라이브 S1의 그 버그, `friction-log.md`).
- **대기 지평선**: 생성·발행은 `maxTimeoutMs=45s`(`sendSponsoredOp.ts:118`), **claim은 기본 15초**
  (`Claim.tsx:159`에 인자 없음) → OpProgress가 45초 캡을 암시하는데 실제론 15초에 꺼진다.
- **진행 언어**: 생성=경과초+슬로우+결정블록 / claim=saving 고정 / 로그인·KYC=스피너 한 줄.
  같은 온체인 대기가 세 가지 다른 얼굴.
- **성공 확인**: 생성=done화면, 가입=성공체크, **claim=무음 이동**. `copy.claim.done`("티켓을 받았어요",
  `ko.ts:134`)이 **선언돼 있으나 미사용**.
- **문구 모순**: 발행은 폴링으로 새로고침 없앴는데 `organizer/copy.ts:75` `confirming`은 여전히
  "잠시 뒤 이 화면을 다시 열어 주세요"(죽은 지시).

## 3. 신뢰 큐(무료·안심) — 거의 없음

- 코드 전체에 **"무료"·"돈 안 들어요"·"공짜" 문자열 0건**. 유일한 안심 문구는 주최자용
  `feeNote`="만드는 비용은 MONTI가 대신 내요"(`organizer/copy.ts:443`) 하나뿐.
- **주 사용자(받기 하는 14세)에겐 가격/무료/대납 안내가 전혀 없다.** 받기 버튼은 그냥 "티켓 받기".
  "이거 돈 내야 하나?"라는 첫 질문에 화면이 답하지 않는다.
- web3 낱말을 감춘 건 잘함(op/체인/가스 노출 없음). 안심 문구만 비어 있다.

## 4. 통일 패턴 제안: 하나의 "진행 → 완료" (모든 온체인 쓰기 공통)

생성 경로를 표준으로 굳혀 전 쓰기에 적용:
1. **확정형 OpProgress** 저장 중 → 확인 중 → 완료, 경과초 + "보통 N초" + 10초 슬로우, **모든 op에
   `maxTimeoutMs=45s`** 전달(claim 포함) → 화면과 폴이 같이 끝난다.
2. **먼저 opHash 기록** 후 실패 가능 단계 진입(멱등 재전송의 전제).
3. **타임아웃=막다른 알림 금지** → 항상 결정블록(다시 시도 / 나중에 확인).
4. **배경 해소기**(배너/폴링)로 수동 새로고침 제거.
5. **명시적 완료** — "티켓을 받았어요 · 내 티켓에 있어요" + 위치.
6. **안심 한 줄** 대기·버튼 근처: "무료예요 · 돈 안 들어요", "MONTI가 대신 처리해요".

**공통 카피 세트(추가)**: `common.free`="무료예요 · 돈 안 들어요" · `common.montiHandles`="MONTI가
대신 처리해요" · `claim.doneWhere`="티켓을 받았어요 · 내 티켓에 있어요" · `op.resending`="다시 보내는
중이에요"(생성의 `opExpired`처럼).

## 5. 복구 매트릭스 (실패 클래스 → 처리)

| 실패 클래스 | 문장/행동 | 현재 상태 |
|---|---|---|
| 오프라인(`navigator.onLine=false`) | "연결되면 자동으로 다시" 자동재조회 | 처리됨 `errors.ts:58` |
| 인덱서 도달불가(network) | fetchFailed + 다시 시도 | 처리됨 |
| 인덱서 다운(http/graphql/empty) | serviceDown "지금은" | 처리됨 |
| op 타임아웃(안 실림) | 확인중 + 배경폴링/배너 + 다시 시도(멱등) | 생성·발행 O / **claim·양도 X** |
| op 리버트(규칙) | 한도·마감·취소·승인필요 등 명명 | 처리됨 |
| op 드롭/stale(멤풀) | 현 수수료로 **자동 재전송** | 생성 O / **claim X ← S1** |
| 미후원(paymaster) | UnsponsoredNotice 배너 | 생성 O / claim 분기 없음 |
| KYC 필요/거절 | 시트→인증→재개 / 거절→ContactLink | 처리됨 |
| 콜드 함수 | 자동재시도 2× | 로그인 O |

## 6. claim 자동 재전송 규칙 (발행을 그대로 미러)

`usePublish`의 생성 재전송 로직(`usePublish.ts:408-447` + `PendingCreateBanner`)을 받기에 이식:
1. `wait()`가 TIMEOUT이면 `submittedOpHash`+`submittedAt`를 **내구 저장**(이벤트+tier 키의 claim 초안,
   sessionStorage/Firestore).
2. 재진입·재탭 시 **먼저 `resolveSubmittedOp(hash, submittedAt)`**: pending→계속 대기 /
   landed→해당 티켓으로 성공 이동 / **failed·stale→hash 버리고 현 수수료로 재전송**.
3. **`maxTimeoutMs: MAX_WAIT_TIMEOUT_MS`**를 claim/requestClaim에 전달(15→45초).
4. 이중 발급 방지는 receipt 기준(생성의 "one createEvent per draft"와 동형): hash가 있으면
   "묻는다, 절대 맹목 재전송 안 함". `resolveSubmittedOp`가 landed/failed를 receipt로 구분하므로
   failed·stale에서만 안전 재전송.
5. `/tickets` 이동은 **인덱서 반영 확인 후**(또는 "방금 받은 티켓이 곧 나타나요" 힌트).

## 7. 상위 10개 변경(우선순위·path:line)

1. **[P0] claim 드롭/stale 자동 재전송** — 발행 미러. `attendee/claim/Claim.tsx:158-174`(run 성공/캐치),
   내구 hash 저장 신설, `resolveSubmittedOp` 재진입. 라이브 S1 정확히 이 지점(`friction-log.md`).
2. **[P0] claim wait 15→45초** — `Claim.tsx:159` `ticketOp`에 `maxTimeoutMs: MAX_WAIT_TIMEOUT_MS`
   (`sendSponsoredOp.ts:118`). OpProgress 45초 캡과 일치.
3. **[P0] 받기 완료 확인** — `Claim.tsx:165` 무음 이동 대신 완료 화면/토스트 "티켓을 받았어요 · 내
   티켓에 있어요"(미사용 `copy.claim.done`, `ko.ts:134` 활용).
4. **[P0] 받기 무료·대납 안심 문구** — `Claim.tsx` 버튼/대기 근처에 "무료예요 · 돈 안 들어요 · MONTI가
   대신 처리해요". 선례 `organizer/copy.ts:443` feeNote. 신규 `common.free`/`montiHandles`.
5. **[P1] claim OpProgress 단계 실제화** — `Claim.tsx:259,289` "saving" 고정 → 저장→확인 단계·경과초·
   타임아웃 결정블록(생성과 동형). 현재 15초에 꺼져 saving만 보임.
6. **[P1] 신청/신청취소·양도에도 재전송** — `Claim.tsx:150-156,184-190`, `transfer/*` 동일 규칙.
7. **[P1] 새로고침 안전(claim 중복 방지)** — 진행 중 op hash 미보존이라 새로고침 후 재탭 시
   `held` 미갱신 창에서 이중 클레임 위험. #1의 내구 저장으로 해소.
8. **[P2] KYC 90초 진행 형상** — `VerifyIdentity.tsx:150` 스피너 한 줄 → 경과/단계·"곧 끝나요" 안심.
   90초를 스피너만 보고 기다리는 건 이탈 유발.
9. **[P2] 로그인 7초 대기 형상** — `Login.tsx:123-128` 스피너+한 줄 → "확인하고 있어요"에 안심 톤.
   자동재시도는 유지.
10. **[P2] 죽은 새로고침 문구 정리** — `organizer/copy.ts:75` `confirming` "다시 열어 주세요"를
    폴링형으로(발행은 이미 자동 해소). 인덱서 지연 힌트 `tickets/List.tsx` 추가 권장.
