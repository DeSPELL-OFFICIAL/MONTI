# MONTI 웹 UX 2차 개정 — 창업자 폰 테스트(2026-09-24) 반영

**작성** 2026-09-24 · **마감** 2026-10-13 해커톤 · **범위** 가입 1화면화 · 행사 만들기 1화면화 · 포스터 모달 · 테마 · 티켓 그림 · 임시저장.
**근거 코드** 웹 `MONTI-web`(mvp-web a56a740) · 백엔드 `MONTI-backend`(mvp-backend) · 컨트랙트 `contracts/src/Ticket.sol`.
**제품 규칙** 관객·주최자 화면에 지갑·가스·체인·NFT 말이 없다 · 수수료는 MONTI가 낸다 · 무료 한도만 쓴다(Pinata 1 GB, Firestore).
**선행 계획** `2026-09-22-monti-ux-flow.md` · `2026-09-22-monti-event-creation-scene.md`(SCENE 1/2 구조) — 이 문서는 그 위에 얹는다.

---

## 0. 결정 요약

| # | 결정 | 근거 한 줄 |
|---|---|---|
| 1 | 패스키+기기등록을 **한 화면 한 번 누르기**로 합친다 | 기기 키 생성은 사용자 제스처가 필요 없다(`shared/deviceKey/web.ts:98`) |
| 2 | `만들기`는 **항상 `/org/new`** 로 간다. 주최사는 만들기 화면 안의 **미리 채워진 한 칸** | `useOrganizerEntry.ts:63` 이 `orgs.length===0` 일 때 `/org/become` 으로 보내는 것이 "한 번 더 누르기"의 정체 |
| 3 | 포스터는 **전체 화면 모달 1개**(고르기→자르기→확정)이고 업로드는 **배경에서** 돈다 | 지금은 업로드 왕복 + 게이트웨이 재다운로드가 화면을 붙잡는다(`PosterCard.tsx:26-46,51`) |
| 4 | "테마" = 행사 **카테고리 칩**. 12종 **드롭다운**으로 넓힌다 | `category` 는 체인에서 `uint8`(`Ticket.sol:35`) — 계약·인덱서 변경 0 |
| 5 | 티켓 그림 **8종(인라인 SVG)** + 제목·이름·종류·날짜를 그려 넣고 **PNG 내려받기** | 서버 `ART_PRESETS`(`eventArt.ts:18`)와 규칙(`firestore.rules:151`)이 a~d 로 박혀 있어 **양쪽 다 넓혀야 한다** |
| 6 | 표시 이름은 **새 칸 `users/{uid}.displayName`**. 체인 닉네임은 건드리지 않는다 | 체인 닉네임은 `^[a-z0-9_]{3,20}$`(`Nickname.tsx:80`) — 한글이 안 되고 스폰서 트랜잭션이 든다 |
| 7 | SCENE 1+2 를 **한 화면 한 버튼**으로 합치고 필수 칸을 8 → 5 로 줄인다 | "다음" 누르고 "만들기" 누르는 것 자체가 2번 누르기다 |
| 8 | `임시 저장` 버튼과 진입 시 `이어서 작성하기` 시트를 **눈에 보이게** 만든다 | 자동저장은 이미 다 있다(`useEventDraft.ts`) — 보이지 않을 뿐이다 |

---

## A. 항목별 — 무엇을 봤나 → 왜 그런가(코드) → 무엇을 바꾸나

| # | 창업자가 본 것 | 왜(코드 위치) | 바꿀 것 | 절 |
|---|---|---|---|---|
| 1 | 패스키 뒤에 등록을 한 번 더 한다 | `/signup/passkey`(`Passkey.tsx:73` → `navigate('/signup/device')`)와 `/signup/device`(`Device.tsx:170`)가 각각 버튼을 가진 별개 화면 | 한 화면 + 3단계 진행 애니메이션 | C |
| 2 | 주최사를 만들고 만들기를 또 눌러야 한다 | `useOrganizerEntry.ts:63` → `/org/become` → `Become.tsx:91` 이 `/org` 로 보냄 → 거기서 `만들기` 재탭(`Layout.tsx:156`) | 진입은 항상 `/org/new`, 주최사는 인라인 1칸 | B |
| 3 | 포스터가 오래 걸리고 자르기 UX가 나쁘다 | `PosterCard.tsx:26` 이 `pin()` 왕복을 await 하고, 끝나면 `gatewayUrl(cid)`(`:51`)로 **방금 올린 바이트를 다시 내려받는다** | 모달 1개 + 배경 업로드 + 로컬 미리보기 | D |
| 4 | 테마를 늘리고 드롭다운으로 | `themeLabel: '테마'`(`organizer/copy.ts:286`), 칩 4개(`CreateEvent.tsx:112-122`), `THEME_CODES=[0,1,2,3]`(`draftRules.ts:27`) | 12종 + `<select>` + 탐색 필터 공용 모듈 | A-4 아래 |
| 5 | 티켓 샘플이 적고, 이름이 안 찍히고, "이름"이 뭔지 모르겠다 | 프리셋 4개(`TicketArt.tsx:13,30`), 제목·종류만 HTML 오버레이(`:61-64`), 라벨이 그냥 `name: '이름'`(`copy.ts:335`) | 8종 SVG + 제목/이름/종류/날짜 + 내려받기 + 라벨 교체 | E |
| 7 | 전체가 어렵다. 초등학생도 만들 수 있어야 | 필수 8개(`draftRules.ts:77-104`) + 종류 이름 필수(`:157`), 화면 2개, 버튼 2개 | 1화면 1버튼, 필수 5개, 나머지 `더 설정하기` | B |
| 8 | 튕겨도 이어서 하고 싶다 | 자동저장은 이미 동작(`useEventDraft.ts:300-311`)하지만 버튼도 시트도 없다 | `임시 저장` 버튼 + `이어서 작성하기` 시트 | F |

**A-4 · 테마 확정.** "테마"는 행사 **카테고리**다 — 화면 문구가 `테마`(`organizer/copy.ts:286`)이고 값은 `EventMeta.category`(`buildEventMeta.ts:61`), 체인 타입은 `uint8`(`Ticket.sol:35`), 서버는 0–255 를 받는다(`organizer.ts optionalCategory`). **계약·인덱서·마이그레이션 없이 클라이언트만 고치면 된다.**
0–3 의 뜻은 그대로 두고(기존 행사 라벨 보존) 8개를 더한다: `0 공연 · 1 모임 · 2 전시 · 4 페스티벌 · 5 스포츠 · 6 콘퍼런스 · 7 강연·클래스 · 8 파티 · 9 영화·상영 · 10 마켓 · 11 네트워킹 · 3 기타`(기타는 화면 맨 아래).
칩 대신 `<Field label="테마"><select>`. 목록과 라벨은 **새 공용 모듈 `shared/eventThemes.ts`** 한 곳에만 둔다 — 지금 주최자쪽(`draftRules.ts:27`)과 관객 필터쪽(`discover/useEvents.ts:32`, `Filters.tsx:21-26`)이 각자 4개를 들고 있어, 한쪽만 넓히면 주최자가 고른 테마의 행사가 탐색 필터에서 사라진다. 문구는 `themes: Readonly<Record<ThemeCode, string>>` 로 두어 로케일 누락이 빌드에서 깨지게 한다(지금 `theme0~3` 평면 키의 의도 유지).

---

## B. 단순화한 만들기 플로우(항목 7) + 주최사 결정(항목 2)

**B-1 · 한 화면 한 버튼.** `/org/new/:draftId/tickets`(`Layout.tsx:182`)를 없애고 `TicketSettings.tsx` 의 JSX 를 `CreateEvent` 안의 `<TicketSection>` 으로 옮긴다. `usePublish`·`tierProblems`·`paidTiers` 는 그대로 쓴다(로직 이동 없음). 옛 경로는 `/org/new/:draftId` 로 리다이렉트만 남긴다.

**B-2 · 기본 노출 5칸.** 포스터 · 제목 · 시작 시각 · 장소(지역 `select` + 장소 `input` 한 줄) · 티켓(`티켓 종류` 미리채움 `일반` + `수량` 100).
`더 설정하기`(`<details>`) 안으로: 소개 · 테마 · 태그 · 종료 시각 · 공개 범위 토글 2개 · 양도/양도 마감/본인 확인 · 1인당 한도 · 가격 · 종류 추가 · 주최사 선택(2개 이상일 때).

**B-3 · 필수 규칙 변경**(`draftRules.ts:77-104`).
- `body` 필수 해제 — **안전 확인됨**: 서버는 `name` 만 빈 값을 거절하고 `description` 은 길이만 잰다(`functions/src/functions/organizer.ts:206-212`).
- `endsAt` 은 `더 설정하기` 를 열지 않으면 **`startsAt + 2시간` 으로 파생**. `saleWindow`(`draftRules.ts:113`)가 항상 `saleStart < saleEnd` 를 만족한다.
- `emptyEventDraftTier.name`(`useEventDraft.ts:50`) 기본값을 `'일반'` 로 → `tierProblems` 의 `tierName` 이 기본 상태에서 발생하지 않는다.
- 남는 필수: 포스터 · 제목 · 시작 시각 · 장소 · (미리 채워진) 종류 이름.

**B-4 · 주최사 — 결정: "인라인 1칸, 미리 채움". 자동 생성 아님.**
- 근거 1: `orgProfiles.name` 은 **영구히 못 고친다** — 클라이언트 쓰기 전면 금지이고 수정 콜러블이 없다(`task-create-organizer-report.md`). 자동으로 지은 이름은 심사위원이 보는 행사 화면에 그대로 박힌다.
- 근거 2: 구현 비용이 같다. 어느 쪽이든 `createOrganizerForMe` 를 publish 안에서 한 번 부르고 가드를 걸어야 한다. 차이는 미리 채워진 입력 한 줄뿐이다.
- 근거 3: 누르는 횟수가 늘지 않는다. 표시 이름으로 미리 채워 두므로 그냥 `만들기` 를 누르면 된다.
- 화면: 주최사가 **하나도 없을 때만** `만들기` 버튼 바로 위에 한 줄. 이미 있으면 칸을 아예 그리지 않고, 2개 이상이면 `더 설정하기` 안의 `주최사` 드롭다운으로 내린다.
- 문구 — 라벨 `주최자 이름` / 도움말 `행사 화면에 이 이름이 보여요. 나중에 바꿀 수 없어요.` / 플레이스홀더 `예: 몬티 크루`.
- 진입 경로: `useOrganizerEntry.ts:63` 의 `orgs.length===0 → '/org/become'` 를 `'/org/new'` 로 바꾼다. `/org/become` 는 주최자 홈에서 2·3번째 주최사를 만들 때만 남긴다.

**B-5 · publish 안의 주최사 생성 가드**(`usePublish.ts:313` 의 기존 `createdEventId` 패턴을 그대로 따른다). `createOrganizerForMe` 는 **멱등이 아니고** 영수증+finality 까지 2–5초(드물게 10초+) 걸린다:
1. `draft.orgId !== ''` → 그대로 쓴다.
2. `useMyOrgs()` 에 `canCreateEvent` 인 주최사가 있으면 첫 번째를 쓰고 `patch({orgId})`.
3. 없으면 `patch({orgPendingName: name})` → `await save()` → `createOrganizerForMe({name})` → `patch({orgId, orgPendingName:''})` → `await save()`.
4. 3단계 재진입인데 `orgPendingName` 이 이미 차 있으면 **먼저 `refetch()` 후 2단계를 다시 본다.** 그래도 비면 그때 만든다.
- 단계 표시: `phase` 에 `'org'` 를 더하고 문구 `주최사를 만들고 있어요`.
- 남는 위험(기록): 3단계 중 앱이 죽으면 주최사 1개가 떠돌 수 있다. 4단계가 다음 시도에서 그것을 주워 쓰므로 피해는 최대 1개, 상한 3개가 뒤를 받친다.

---

## C. 가입 합치기(항목 1)

**C-1 · 제스처 판정 — 붙여서 돌릴 수 있다.**
- `navigator.credentials.create`(→ `passkey/web.ts:8`)는 **사용자 제스처가 필요하다.** 그러니 화면의 단 하나뿐인 버튼이 이것을 시작해야 한다.
- 기기 키 생성은 **제스처가 필요 없다**: 웹은 `crypto.subtle.generateKey` + IndexedDB(`deviceKey/web.ts:98`), 네이티브는 플러그인 `generateKey`(`deviceKey/native.ts:20`) — iOS `SecAccessControl`/안드로이드 `setUserAuthenticationRequired` 모두 **생성이 아니라 사용 시점**에 생체 창을 연다.
  *미검증*: 플러그인 네이티브 코드를 읽지 않았다. 실기에서 생성 시 생체 창이 뜨더라도 시스템 창일 뿐 앱 버튼이 하나 더 생기는 것은 아니므로 설계는 유지된다. **T-UX2-3 의 수용 조건에 실기 확인을 넣는다.**
- `api.registerIdentity` 는 네트워크 호출이라 제스처와 무관하다.
- **주의(지금도 있는 버그)**: `Passkey.tsx:64` 는 `loginChallenge` 왕복을 **끝낸 뒤에** `createPasskey` 를 부른다. 느린 콜드 스타트가 제스처 유효창(크롬 5초, 사파리는 더 엄격)을 넘기면 `NotAllowedError` → 화면은 `잠금 설정을 취소했어요` 라는 거짓말을 한다. **챌린지를 화면 진입 시 미리 받아 둔다**(수명 60초, 1회용, 45초 지나면 재발급) → T-UX2-17.

**C-2 · 화면.** `/signup/register` 하나. `Passkey.tsx`·`Device.tsx` 는 지우고(하위 호환 레이어 없음) `/signup/passkey`·`/signup/device` 는 리다이렉트만 남긴다 — 라우터 가드(`router.tsx:41`)가 `/signup/device?returnTo=` 를 쓰므로 **쿼리는 그대로 받는다**. 세션에 이미 `account` 가 있으면 1단계를 건너뛰고 2단계만 돈다.
진행 표시는 점 3개 스테퍼: `패스키 → 휴대폰 등록 → 완료`. 현재 단계만 맥동(`@keyframes`), 끝난 단계는 채움. 결정 막대(퍼센트)는 쓰지 않는다 — `registerIdentity` 는 finality 를 기다려 30초까지 갈 수 있어 거짓말이 된다.
**문구** — 제목 `계정 만들기` / 본문 `얼굴·지문 잠금을 걸고 이 휴대폰을 등록할게요. 한 번만 누르면 끝나요.` / 버튼 `시작하기` / 1단계 진행 `잠금을 만들고 있어요` / 2단계 진행 `휴대폰을 등록하고 있어요` / 10초 경과 `거의 다 됐어요. 조금만 기다려 주세요` / 실패 `다시 시도하기`. 기존 실패 문구(`ko.ts:27-38`)는 단계별로 그대로 재사용한다.
`DeviceKeyUnavailable`(시크릿 창) 분기만 두 번째 버튼을 만든다: `이대로 계속하기`(= 지금의 `deviceSkip`).

**C-3 · 표시 이름은 완료 화면에서 묻는다.** 등록 화면은 "한 번 누르기"를 지켜야 하므로 입력 칸을 두지 않는다. `Done.tsx` 에 한 칸을 더한다 — 제목 `어떻게 불러 드릴까요?` / 도움말 `티켓에 이 이름이 보여요. 나중에 프로필에서 바꿀 수 있어요.` / 플레이스홀더 `예: 김태완` / 버튼 `시작하기`. 비워 두면 그냥 넘어간다.

---

## D. 포스터 모달(항목 3)

**D-1 · 흐름.** 카드의 `포스터 올리기` → **전체 화면 모달**: (a) 사진 고르기(시스템 피커) → (b) 큰 프레임에서 끌기/핀치 → (c) `이 사진으로 정하기`. 확정을 누르면 **모달이 즉시 닫힌다.** 카드에는 `URL.createObjectURL(cropped.blob)` 로 만든 **로컬 미리보기**가 바로 뜨고, 업로드는 배경에서 돌며 카드 모서리에 진행 표시가 돈다. 씬은 계속 쓸 수 있다.
`A4Cropper.tsx` 는 프레임·제스처만 남기고 버튼을 모달 바닥 바로 위로 옮긴다(`crop`/`again` 2버튼 → 주 버튼 1 + 고스트 1 + 닫기 X).

**D-2 · 느린 이유 — 확인할 용의자(순위대로).** `performance.now()` 계측을 붙여 실제 순위를 먼저 확정한다(T-UX2-10).
1. **`api.pinEventImage` 왕복.** 600 KB JPEG → base64 800 KB 본문이 서울에서 `us-east1` 로 가고(콜드 스타트 512 MiB/Node 22), 거기서 Pinata 로 다시 올라간다. **1순위.**
2. **핀 직후의 게이트웨이 재다운로드.** `PosterCard.tsx:51` 이 `gatewayUrl(posterCid)` 로 바꿔 끼우는 순간, 방금 브라우저 메모리에 있던 바이트를 공용 게이트웨이에서 다시 받는다. 순수 낭비이고 전파 지연까지 얹힌다. **2순위.**
3. **구제 재인코딩**(`a4Crop.ts:101`). 첫 인코딩이 600 KB 를 넘으면 12 MP 비트맵을 **한 번 더** 그리고 굽는다.
4. `createImageBitmap(file, {imageOrientation:'from-image'})` — 12 MP 사진 디코딩.
5. `FileReader.readAsDataURL` — 무시 가능할 것으로 본다(계측으로 확인만).

**D-3 · 고칠 것.** (1)(2)를 막는 경로에서 뺀다 — 확정 즉시 배경 업로드 + 로컬 미리보기. 세션 동안 `Map<cid, objectUrl>` 을 들고 있어 카드·`TierCard` 미리보기·완료 화면이 전부 로컬 바이트를 본다.
`만들기` 는 업로드가 진행 중이면 **막지 않고 기다린다** — 포스터 문제 문구를 `포스터를 올리는 중이에요. 곧 끝나요` 로 바꾼다. 실패하면 바이트가 아직 메모리에 있으므로 `다시 올리기` 칩 하나로 재시도한다.
(3)(4)가 계측에서 지배적으로 나오면 그때만 1차 품질 0.85 → 0.72, 구제 0.7 → 0.6 으로 내린다(T-UX2-20). **서버 한도는 건드리지 않는다**(poster ≤ 600 KB, JPEG·PNG 만, 한 변 ≤ 4000 px, 하루 20장).
**문구** — `사진 고르기` / `끌어서 옮기고, 두 손가락으로 크기를 맞춰요` / `이 사진으로 정하기` / `다른 사진 고르기` / `포스터를 올리고 있어요` / `포스터를 올리지 못했어요` / `다시 올리기`.

---

## E. 티켓 이미지(항목 5)

**E-1 · 프리셋 8종 — 서버·규칙을 같이 넓혀야 한다(막힘 요인).**
- `functions/src/functions/eventArt.ts:18` `ART_PRESETS = ['a','b','c','d']` → `['a'..'h']`, `saveEventArt` 재배포.
- `firestore.rules:151` `art.get('preset','a') in ['a','b','c','d']` → 8글자 목록, `firestore:rules` 재배포. **이걸 빼먹으면 프리셋 `e` 를 고른 순간부터 초안 자동저장이 문서 단위 권한 오류로 전부 죽는다**(규칙 파일이 스스로 경고하는 그 실패다).
- 클라이언트: `TicketArtPreset`(`TicketArt.tsx:13`), `BACKDROPS`(`:30`), `TICKET_ART_PRESETS`(`draftRules.ts:186`), `presetLabel`(`ArtPicker.tsx:9`), 문구 `artA~artD` → `artNames: Record<preset, string>`.
- 배경을 **파일 4개에서 인라인 SVG 모듈 `shared/ui/ticketArt/presets.ts` 로 옮긴다.** 래스터화할 때 외부 요청이 생기지 않고 Vite 의 `assetsInlineLimit` 에도 의존하지 않는다.

**E-2 · 진짜 티켓처럼 그리기.** `buildTicketSvg({ preset, title, holder, tierName, dateText, used })` 가 **SVG 문자열 하나**(1000×1600, 배경 + 스크림 + 절취선 + 스텁)를 만든다. 화면도 이 문자열을 인라인으로 그려서 **보이는 것과 내보내는 것이 같다**.
- 제목은 SVG `<text>` 가 줄바꿈을 못 하므로(지금 코드가 `TicketArt.tsx:44-46` 에서 바로 그 이유로 HTML 오버레이를 쓴다) **JS 에서 미리 줄을 나눈다**: 한글 1.0 / ASCII 0.55 폭 가중치로 2줄까지, 넘치면 말줄임. 순수 함수라 단위 테스트가 된다.
- 글꼴은 `system-ui, -apple-system, 'Apple SD Gothic Neo', sans-serif`. 캔버스도 같은 시스템 글꼴로 굽는다.
- 모든 문자열은 XML 이스케이프한다(우리가 만든 문자열이지만 제목·이름은 사용자 입력이다).

**E-3 · 이름은 어디서 오나.** 새 칸 `users/{uid}.displayName`(≤ 24자, 한글 허용).
- 쓰기: `saveUserProfile`(`firestore.ts:242`)의 patch 타입에 `displayName` 추가 + **`firestore.rules:28` 의 `changedOnly(['nickname','locale','chatOrder'])` 에 `displayName` 추가**(안 하면 저장이 권한 거부). 문서는 `startSignup` 이 이미 만든다.
- 읽기: 새 `loadMyProfile()` + `useDisplayName()`. 티켓 렌더는 **`attendee/tickets/useTicketArt.ts:44` 의 `useTicketArtProps` 한 곳에서** 읽어 두 티켓 화면(`List`/`Detail`)에 같은 값을 넘긴다. 주최자 미리보기(`TierCard.tsx:54`)도 같은 훅을 쓰고, 없으면 견본 이름으로 그린다.
- 이름이 없는 사람의 티켓에는 **아무것도 그리지 않는다**(`이름 없음` 같은 자리표시자는 티켓에 넣지 않는다).
- **체인 닉네임은 그대로 둔다.** `^[a-z0-9_]{3,20}$`(`Nickname.tsx:80`)라 한글이 안 되고, 설정에 스폰서 트랜잭션이 들며, 양도·대화용 고유 손잡이라는 다른 역할이 있다. 티켓에는 쓰지 않는다.

**E-4 · 이미지 내보내기.** SVG 문자열 → `new Image().src = 'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg)` → `canvas.drawImage` → `toBlob('image/png')` → 웹은 `<a download>`. 주최자가 올린 그림(`imageCid`)은 게이트웨이 URL 을 직접 넣으면 캔버스가 오염되어 `toBlob` 이 던지므로, `fetch(gatewayUrl(cid))` → blob → **FileReader 로 data URI 로 바꿔** SVG 안에 넣는다. 네이티브에서는 새 의존성을 들이지 않고 인라인 이미지 길게 눌러 저장하도록 안내한다.
**문구** — `티켓 이미지 저장` / `만들고 있어요` / `저장하지 못했어요. 다시 시도해 주세요.`

**E-5 · 라벨 교체.** `organizer/copy.ts:335` `name: '이름'` → `'티켓 종류 (예: 일반, VIP)'`, 플레이스홀더 `일반`, 도움말 `티켓에 찍히는 이름이에요`. 기본값도 `'일반'`(B-3).

---

## F. 임시 저장 / 이어서 작성(항목 8)

**F-1 · 이미 있는 것.** 2초 디바운스·10분·`visibilitychange`/`pagehide`/`beforeunload` + localStorage 사본 + Firestore 문서, 상태 표시 `SaveStatus`(`useEventDraft.ts:300-410`). **동작은 하는데 보이지 않는다.**
**F-2 · 더할 것.** 하단 고정 바에 `만들기` 옆 고스트 버튼 `임시 저장` → `save()` → 상태줄이 `저장됨 · 방금`(기존 `savedNow`).
**F-3 · 진입 시트.** `/org/new` 진입에서 이어쓸 초안이 있으면 바텀 시트: 제목 `이어서 작성할까요?` / 본문 `{{title}} · 마지막 저장 {{when}}`(제목 없으면 `제목 없는 행사`) / `이어서 작성하기` · `새로 만들기`. 지금의 조용한 재개(`CreateEvent.tsx:83-90` 의 흐린 한 줄)를 대체한다.
**F-4 · `새로 만들기` 는 지우지 않는다.** `useEventDraft` 에 `startNew()` 를 더한다 — 새 id 를 발급하고 **옛 초안은 남긴다**(상한 5개, `pruneDrafts` 가 뒤를 본다). 지금은 `discard()` 밖에 없고 그것은 문서를 지운다(`useEventDraft.ts:313`).

---

## G. 작업 목록

| ID | 크기 | 우선 | 작업 | 한 문단 브리프 |
|---|---|---|---|---|
| T-UX2-1 | S | P0 | 백엔드 프리셋 a–h | `functions/src/functions/eventArt.ts:18` 의 `ART_PRESETS` 를 8글자로 넓히고 `saveEventArt` 만 재배포한다. 타입 `ArtPreset` 이 파생되므로 다른 수정은 없다. 유닛 테스트에 `'e'` 통과·`'i'` 거절 2건을 더한다. E-1 이 이것을 기다린다. |
| T-UX2-2 | S | P0 | 규칙 2곳 | `firestore.rules:151` `artOk` 의 프리셋 목록을 a–h 로, `:28` `changedOnly` 에 `displayName` 을 더하고 `displayName is string && size()<=24` 검사를 붙인다. `firestore:rules` 재배포. 빠뜨리면 초안 자동저장과 이름 저장이 각각 권한 오류로 죽는다. |
| T-UX2-3 | M | P0 | 가입 1화면 | `/signup/register` 를 만들고 `Passkey.tsx`·`Device.tsx` 를 지운다(리다이렉트만 남김, `returnTo` 유지). 한 버튼이 패스키→기기키→`registerIdentity` 를 이어서 돌리고 3점 스테퍼가 단계를 보여 준다. **수용 조건에 실기(iOS/안드로이드) 확인**: 키 생성 단계에서 앱 버튼이 한 번 더 필요하지 않을 것. C-1/C-2. |
| T-UX2-4 | S | P0 | 완료 화면 이름 칸 | `Done.tsx` 에 입력 한 칸을 더하고 `saveUserProfile({displayName})` 로 저장한 뒤 넘어간다. 비워도 진행된다. T-UX2-2 뒤. |
| T-UX2-5 | S | P0 | 진입 경로 | `useOrganizerEntry.ts:63` 의 `orgs.length===0 → '/org/become'` 를 `'/org/new'` 로 바꾸고, `become.test`·`organizerHome.test` 의 해당 행을 고친다. 창업자 항목 2 의 절반이 이 한 줄이다. |
| T-UX2-6 | M | P0 | 씬 합치기 | `TicketSettings.tsx` 의 JSX 를 `CreateEvent` 안 `<TicketSection>` 으로 옮기고 버튼을 `만들기` 하나로 만든다. `usePublish`·`tierProblems` 로직은 그대로 둔다. `/org/new/:draftId/tickets` 는 리다이렉트. B-1. |
| T-UX2-7 | M | P0 | 기본값·접기 | 기본 노출 5칸, 나머지를 `더 설정하기` 로 접는다. `eventProblems` 에서 `body` 필수를 빼고 `endsAt` 을 `startsAt+2h` 로 파생, 기본 종류 이름을 `'일반'` 으로. B-2/B-3. |
| T-UX2-8 | M | P0 | 주최사 인라인 + 가드 | 주최사가 없을 때만 보이는 미리 채워진 한 칸, 그리고 `usePublish` 안에서 4단계 해석 순서(초안→내 주최사→생성→재진입 시 재조회)를 구현한다. `phase: 'org'` 와 문구 추가. B-4/B-5. |
| T-UX2-9 | M | P0 | 포스터 모달 | 전체 화면 모달 1개(고르기→자르기→확정), 확정 즉시 닫고 배경 업로드, 로컬 objectURL 미리보기, 세션 `Map<cid,url>`, 실패 시 `다시 올리기`. `만들기` 는 진행 중이면 기다린다. D-1/D-3. |
| T-UX2-10 | S | P0 | 포스터 계측 | `createImageBitmap` / 1차 인코딩 / 구제 인코딩 / base64 / `pinEventImage` / 게이트웨이 첫 바이트에 `performance.now()` 를 찍어 실기 3장(12 MP, 4 MP, PNG)의 표를 남긴다. D-2 의 순위를 확정하고 T-UX2-20 의 발동 여부를 정한다. |
| T-UX2-11 | M | P0 | 테마 12종 드롭다운 | `shared/eventThemes.ts` 를 새로 만들어 코드·라벨·표시 순서를 한 곳에 두고, 주최자 씬(칩→`select`)과 탐색 필터(`useEvents.ts:32`, `Filters.tsx:21-26`)가 둘 다 그것을 읽게 한다. 0–3 의 뜻은 보존. A-4. |
| T-UX2-12 | L | P0 | 티켓 SVG 8종 + 렌더 | 인라인 SVG 프리셋 8개와 `buildTicketSvg`(제목 2줄 줄바꿈·이름·종류·날짜·절취선·사용됨 처리)를 만들고 `TicketArt` 가 그것을 그리게 바꾼다. 줄바꿈 함수는 단위 테스트 대상. E-1/E-2. |
| T-UX2-13 | M | P0 | 티켓 이미지 내려받기 | SVG → 캔버스 → PNG → `<a download>`. 업로드 그림은 fetch→blob→data URI 로 인라인해 캔버스 오염을 피한다. 네이티브는 길게 눌러 저장 안내. E-4. |
| T-UX2-14 | S | P0 | 종류 이름 라벨 | `copy.ts:335` 라벨·플레이스홀더·도움말 교체와 기본값 `'일반'`. 창업자가 "이름이 뭔지 모르겠다"고 한 그 칸이다. E-5. |
| T-UX2-15 | M | P0 | 임시 저장 + 이어쓰기 시트 | 하단 바 `임시 저장` 버튼, 진입 바텀 시트, `useEventDraft.startNew()`. 옛 초안을 지우지 않는 것이 핵심. F-2/F-3/F-4. |
| T-UX2-16 | S | P1 | 내 정보 표시 이름 | `Profile.tsx` 에 표시 이름 칸을 더한다(체인 닉네임 칸과 나란히, 설명 한 줄로 구분). T-UX2-4 와 같은 저장 경로. |
| T-UX2-17 | S | P1 | 패스키 챌린지 선발급 | 등록 화면 진입 시 `loginChallenge({purpose:'register'})` 를 미리 받아 두고 45초 넘으면 재발급한다. 느린 콜드 스타트가 제스처 창을 넘겨 `취소했어요` 라고 거짓말하는 경로를 없앤다. C-1. |
| T-UX2-18 | S | P1 | 회귀 테스트 갱신 | `createEvent.test`·`ticketSettings.test`·`scenePublish.test`·`finish.test`·`ticketArt.test`·`discover.test` 를 새 구조에 맞춘다. 합쳐진 씬과 합쳐진 가입 화면이 기존 테스트를 통째로 깬다. |
| T-UX2-19 | S | P2 | 인코딩 품질 튜닝 | T-UX2-10 결과가 인코딩 지배를 보일 때만: 1차 0.85→0.72, 구제 0.7→0.6. 서버 한도·치수는 손대지 않는다. |

**개수: P0 15 / P1 3 / P2 1 · 합계 19.**
**순서** T-UX2-1·2(배포가 앞서야 함) → 5 → 3·4 → 6·7·8 → 9·10 → 11 → 12·13·14 → 15 → 16·17·18 → 19. 1·2 는 다른 저장소(백엔드)라 첫날 병렬로 뗀다.
**건드리지 않는 것** `EditEvent.tsx:93` 은 이미 `/org/new/${draftId}` 로 보내므로 씬 합치기 뒤에도 그대로 동작한다 — 리다이렉트만 있으면 된다.

---

## H. 확인한 것 / 확인하지 못한 것 (추정으로 표시)

**소스로 확인함**
- `pinEventMetadata` 는 빈 `description` 을 받는다 — `name` 만 `nameChars === 0` 을 거절한다(`functions/src/functions/organizer.ts:206-212`). B-3 의 소개 필수 해제가 안전하다.
- 주최자 판정은 **체인을 직접 읽는다**(`functions/src/lib/auth.ts:66-91` 전부 `publicClient().readContract`). `createOrganizerForMe` 가 finality 까지 기다리므로 주최사 생성 직후의 `pinEventMetadata` 는 인덱서 지연 없이 통과한다 — B-5 에 재시도를 넣을 필요가 없다.
- `category` 는 체인 `uint8`(`Ticket.sol:35`)이고 서버는 0–255 를 받는다. 테마 확장에 계약·인덱서·마이그레이션이 없다.
- 서버 프리셋은 `['a','b','c','d']`(`eventArt.ts:18`), 규칙도 같은 4글자(`firestore.rules:151`), `users/{uid}` 는 `changedOnly(['nickname','locale','chatOrder'])`(`firestore.rules:28`). **셋 다 넓히지 않으면 8종 프리셋과 표시 이름이 조용히 실패한다.**

**확인하지 못함 (추정)**
1. **`@monti/device-key` 플러그인의 네이티브 소스를 읽지 않았다.** 키 *생성* 시 생체 창이 뜨지 않는다는 것은 iOS `SecAccessControl`·안드로이드 `setUserAuthenticationRequired` 의 일반 동작에 근거한 추정이다. 실기 확인은 T-UX2-3 의 수용 조건이다. 떠도 설계는 유지된다(시스템 창일 뿐 앱 버튼이 늘지 않는다).
2. **포스터가 느린 실제 원인은 측정 전이다.** D-2 의 순위는 코드 경로 추론이지 측정값이 아니다. T-UX2-10 이 먼저다 — 배경 업로드(D-3)는 어느 쪽이 1순위든 이득이므로 계측을 기다리지 않아도 된다.
3. **`getConfig().ipfsGateway` 가 Pinata 전용 게이트웨이인지 공용인지 확인하지 않았다.** 전용이면 D-2 의 2순위(전파 지연)가 내려가지만, "이미 브라우저에 있는 바이트를 다시 받는다"는 낭비 자체는 그대로다.
4. **사파리가 캔버스로 굽는 SVG 안에서 한글 시스템 글꼴을 쓰는지 실기 확인이 필요하다.** 못 쓰면 내려받은 PNG 의 한글이 네모로 나온다. 대안은 글꼴 subset 을 data URI 로 심는 것인데 용량이 커서 최후 수단이다 — T-UX2-13 의 첫 확인 항목으로 둔다.
5. 창업자 피드백 6번은 이 문서에 오지 않았다(전달된 항목은 1·2·3·4·5·7·8). 6번이 있었다면 별도로 받아야 한다.
