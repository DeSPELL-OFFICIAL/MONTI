# MONTI 실사용 E2E 하니스 (페르소나)

프로덕션 사이트 `https://monti.despell.io` 를 대상으로 관리자 1명 + 이용자 9명 페르소나가
실제로 앱을 쓰는 흐름을 자동화한다. 패스키는 RP ID 가 `monti.despell.io` 라 로컬호스트로는
검증되지 않으므로 반드시 프로덕션(또는 같은 도메인)을 대상으로 한다.

## 실행

```bash
fnm exec --using=22 pnpm -F web e2e            # 전체
fnm exec --using=22 pnpm -F web e2e e2e/tests/01-public-surface.spec.ts   # 로그인 불필요 표면만
```

- 브라우저는 Chromium(헤디드 기본). 패스키는 CDP WebAuthn 가상 인증자로 처리한다.
- 뷰포트 390×844(iPhone 13 급), 로케일 ko-KR, 타임존 Asia/Seoul.
- 실패 시 스크린샷·비디오·트레이스가 `e2e/.artifacts/` 와 `e2e/.report/` 에 남는다.

## 환경 변수(플래그)

| 변수 | 뜻 | 기본 |
|---|---|---|
| `E2E_BASE_URL` | 대상 URL | `https://monti.despell.io` |
| `E2E_HEADLESS=1` | 헤드리스 강제 | 헤디드 |
| `E2E_APPROVAL=1` | 승인제 시나리오(d) 및 승인 행사 생성 활성화 | off |
| `E2E_ADMIN` | 관리자/주최자로 쓸 테스트 번호 인덱스(`01`…`10`, `persona-05`·`5` 도 허용) | `01` |
| `E2E_USER_FROM` | 이용자 풀 시작 인덱스(…10 다음은 …01 로 순환, 관리자 번호는 건너뜀) | 관리자 다음 번호 |
| `E2E_PRICE_USD` | 유료 행사 티켓 값(달러 정수). 55 가 티어 카드에 넣고 52/55/56 이 CTA 로 검증 | `30` |
| `E2E_OVERRIDE_PERSONA` | 53 에서 수동 승인을 누를 페르소나(승인 권한 없는 매니저여야 함) → `requestOverride` 요청 경로 | 없음(관리자 = 승인 경로) |
| `E2E_RPC_URL` · `E2E_TICKET_ADDR` · `E2E_ORGANIZERS_ADDR` · `E2E_RELAYER` · `E2E_TREASURY` | 체인 진실 읽기(`utils/chain.ts`) 주소 재정의. 기본은 `deployments/10143.json`(v2 rc1) | rc1 |
| `E2E_PERSONA_OFFSET` | 다이얼 번호 오프셋(인덱스+오프셋 → 뒷자리). 기본 10 이면 인덱스 1…10 = `+821000000011`…`+821000000020`(원래 `…0001`–`…0010` 블록은 전부 소진). id 는 `persona-01…10` 그대로, `.state` 파일은 오프셋별로 분리됨(`persona-09@10.*`). `0` 이면 원래 블록 | `10` |

## v2 트랜잭션 다이어트 (2026-10-12 rc1)

스테이징 `E2E_BASE_URL=https://v2.monti.despell.io` 로 돌린다(운영 도메인은 O8 전환 전까지 v1).

| 흐름 | 화면 | 체인 기록 |
|---|---|---|
| 주최자 → 공개 | `/org/new` 만들기 → **다음**(초안 저장만) → `/org/new/<draftId>/publish`(유료면 정산 규칙 카드: 수령인 행 + 고정 MONTI 5%, 합 100%) → **공개하기** → 확인 시트 **네, 공개할게요** → `/org/new/done/<eventId>` | `publishEvent` **1건**(행사 Published + 정책 동결). 행사 id 는 1001 부터 |
| 단말기 승인 | 스태프 `/staff/setup` 요청 → 주최자 `/org/events/<id>/gates` **등록** | `registerGate` **1건**, 등록 즉시 열림(따로 여는 단계 없음. 닫았던 단말기만 **다시 열기**) |
| 유료 결제 | `/claim/<id>` 결제하고 받기 → 카드 시트 | 트레저리의 `purchase` **1건**(민팅 + 에스크로 원자). 실패면 "결제가 완료되지 않았어요 · 청구된 금액은 없어요" |
| 수동 승인 | 콘솔 수동 승인하기 | 승인권자: `manualOverride` **1건** / 권한 없는 매니저: `requestOverride` 콜러블(체인 기록 0) → "요청됨 — 승인 대기" |

- `utils/organizer.ts` `createDraftAndPublish(page, spec)` 가 위 주최자 흐름 전체(유료면 `spec.split`)를 하고
  체인에서 `eventStatus == 1` 을 확인한 뒤 `{ eventId, publishMs }` 를 준다. 옛 `createOrganizerAndEvent`·`publishEvent`
  (Draft → 공개 2단계)와 50/50b/31 스펙은 삭제됐다.
- `utils/gates.ts`: `fileGateRequest` → `approveGate`(등록 직후 체인 `gateInfo.open` 확인, 열기 버튼이 남은 빌드면 한 번
  눌러 `openedSeparately` 로 기록) → `startConsole` → `admitByOverride`(승인/요청 두 결과).
- `utils/chain.ts`: rc1 주소로 읽는 viem 클라이언트, 릴레이어·트레저리 MON 잔고.
- **55** 가 한 프로세스로 공개 1 · 결제 1 · 등록 1 · 수동 승인 1 을 돌리고 `e2e/.artifacts/55-chain-diag.json` 에
  단계별 지연(ms), 릴레이어 MON(단계별), **트레저리 MON 델타(결제)**, **주최자 온체인 기록 수**(`organizerWrites`,
  `relayAction` kind + `createOrganizerForMe`)를 남긴다. 스크린샷은 `E2E_SHOTS_DIR` 그대로.
- 이어 달리기: 52(결제만, `EVENT_ID`), 53/57(입장, `EVENT_ID`+`TOKEN_ID`), 56(결제 후 환불, `EVENT_ID`).
- 컴파일 확인: `fnm exec --using=22 pnpm -F web exec playwright test --list` (라이브 실행은 O7).

## 릴레이 경로 (2026-09-30 재배포)

이제 모든 쓰기가 릴레이어를 통한다 — 예전 스폰서 op 스택(페이마스터·번들러·온체인 계약)은 더 이상 없다. 티켓 받기는
앱이 디바이스 키로 `ClaimAuth` 에 서명하고 `relayClaim` 콜러블을 호출하면 MONTI 릴레이어가
`claimFor`/`requestClaimFor` 를 대납 제출한다. 주최자 쓰기(행사 생성/공개·게이트·팀·오버라이드)와
송금(친구에게 주기)은 서명한 `ForwardRequest` 를 `relayAction` 콜러블로 보내 릴레이어가
`MontiForwarder.execute` 로 대납한다. 어느 쪽이든 앱은 `relays/{relayId}` 문서를 따라
저장→확인→완료로 진행한다(화면 문구·상태 불변). 승인제 신청도 같은 `relayClaim`(`mode:'request'`)이다.

- `utils/claim.ts` 의 `claimFree`/`requestApproval` 은 결과를 **화면 문구**로 읽으므로(문구 불변)
  그대로 동작한다. `utils/relay-capture.ts` 가 `relayClaim`·`relayAction` 콜러블을 관찰한다: 요청
  본문의 계정(`auth.account` 또는 `req.from`)으로 페르소나 계정을 기록하고, 실패 시 콜러블의
  `HttpsError`(`details.code`)를 `e2e/.artifacts/relay-errors/…` 와 friction 로그에 남긴다. 송금
  시나리오(`30-transfer`)도 같은 relay-capture 를 쓴다(옛 스폰서 op 캡처 유틸은 삭제됨).
- **비용 측정**은 **릴레이어 EOA 잔액**으로 잰다(모든 쓰기를 릴레이어가 대납). 릴레이어
  `0xFA93A9dB40a4396a8CdcF63991FA8615d1A35fFd` 잔액을 `eth_getBalance`(`https://testnet-rpc.monad.xyz`)
  로 라이브 런 전후에 직접 읽는다(하니스 코드가 아니라 운영자가 RPC 로 측정).
- tokenId 는 이제 `(eventId<<96)|(tier<<88)|serial` 큰 수다. 하니스는 인덱서/URL 에서 tokenId 를
  **문자열 그대로**(`held.id` → `/tickets/{id}`, GraphQL `String!`) 다루므로 숫자 파싱이 없어 그대로
  안전하다(신규 파싱 불필요 — 새 숫자 파싱을 넣지 말 것).

## 가입 캡차 우회 (monti:e2e)

모든 페르소나 컨텍스트는 첫 페이지 로드 전에 `addInitScript` 로 `localStorage['monti:e2e']='1'`
를 심는다(`e2e/utils/session.ts`). 앱의 `shared/api/auth.ts` 가 이 값을 보고 `verifier()` 에서
`appVerificationDisabledForTesting` 를 켜, 프로젝트에 등록된 **테스트 번호에 한해** reCAPTCHA 를
목(mock) 검증기로 바꾼다 — 실번호는 여전히 실제 챌린지를 받으므로 악용 불가. 따라서 테스트 번호
가입은 이미지 챌린지 없이 바로 코드 화면으로 넘어간다.

> 이 우회를 담은 프로덕션 배포가 나가야 라이브 시나리오가 통과한다. 배포 전에는 여전히 실제
> reCAPTCHA 가 뜬다.

## 아직 막혀 있는 것

- **승인제(d)**: 신청 관리(승인) 화면과 `VITE_APPROVAL_MODES=on` 이 프로덕션 빌드에 반영됐다
  (`E2E_APPROVAL=1` 로 켠다). 승인 신청은 `relayClaim(mode:'request')`, 주최자 승인은 스폰서 op.
- **주소 전환 대기**: 소스는 v2 rc1(티켓 `0x8544…9edC`, 포워더 `0xcE6D…ddbb`)을 가리킨다. 대상
  번들(`E2E_BASE_URL`)이 rc1 빌드가 아니면 서명 도메인이 어긋나므로 실행하지 말 것(v1 운영 도메인 금지).

## 관리자 선택과 재등록 번호(/recover)

- **관리자 선택(`E2E_ADMIN`)**: 기본은 …01 이 주최자이고 …02–…10 이 이용자 9명이다. 어떤 테스트
  번호든 주최자 자리에 앉힐 수 있다 — `E2E_ADMIN=05` 면 …05 가 주최자, 이용자 풀은 …06–…10 뒤에
  …01–…04 로 순환해 항상 9명을 채운다(관리자 제외). `E2E_USER_FROM` 으로 이용자 시작 번호만 따로
  바꿀 수 있다. 선택 로직은 순수 함수 `selectPersonas`/`parsePersonaIndex`(`e2e/fixtures/personas.ts`)
  이고 `e2e/fixtures/personas.test.ts` 가 단위 테스트한다(`pnpm -F web test`). 상태 파일은 번호 id 와
  다이얼 오프셋(`E2E_PERSONA_OFFSET`, 기본 10)으로 저장되므로(`persona-05@10.*`), 번호가 로테이션되면
  이전 오프셋에 저장된 소진 번호의 세션을 되살리지 않고 항상 새 가입으로 시작한다.

- **재등록 번호 → `/recover` 처리**: 온체인 신원은 남았는데 Firestore person 은 소프트 삭제된 번호는
  이미 `active` 상태라, 새 가입이 `getSignupStatus()` 판정으로 `/signup/register` 가 아니라 `/recover`
  (분실/기기교체 재설정)로 간다. 하니스의 `signUp`(`utils/signup.ts`)은 인증 후 착지 지점을 보고
  분기한다: `/recover` 면 사용자가 하듯 **새로 설정하기** 를 눌러 가상 인증자로 새 패스키를 만들고,
  디바이스 키를 다시 발급하고, `recoverAccess`(체인 소유자 교체 + 세션 발급, 단일 `confirming` 단계)
  가 끝나 `/tickets` 로 넘어갈 때까지 기다린다. 실패 시 화면은 **다시 시도** 버튼을 내밀고, 하니스는
  제한된 횟수만 재시도한 뒤 화면 사유(ROTATION_COOLDOWN·RECOVERY_RATE_LIMIT 등)를 담아 던진다.
  성공하면 앱이 `markDeviceHealthy()` 를 호출하므로 `shared/deviceHealth.ts` 가드가 바로 통과한다.
  이렇게 복구된 계정은 `e2e/.state/<persona>.meta.json` 에 `recovered` 플래그로 기록돼(세션의
  `recovered`), 다음 런의 재사용 로직이 이 계정의 내력을 안다.
  (라이브 실행 금지 작업이라 `/recover` 경로는 실제로 돌려 보지 않고 `Recover.tsx` 를 읽어 구현·검증했다.)

## 세션 재사용

가입에 성공하면 `e2e/.state/<persona>.state.json`(localStorage 의 `monti.passkey` 포함)과
`<persona>.creds.json`(가상 인증자 자격증명)을 저장한다. 다음 실행에서는 가상 인증자에 자격증명을
다시 심고 `/login` 패스키 로그인으로 재접속해 값비싼 온체인 가입을 반복하지 않는다.
