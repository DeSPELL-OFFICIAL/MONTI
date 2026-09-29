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
- **유료 티켓**: 컨트랙트가 계속 거절 — 시나리오 a 는 "발행 버튼 비활성 + 안내 문구"만 검증한다.
- **프로덕션 주소 전환 대기**: 라이브 런은 프로덕션 번들이 2026-09-30 재배포(티켓
  `0x7E1f…51Cf`, 포워더 `0xb19c…B4B5F`)를 가리킬 때만 유효하다. 소스는 이미 이 주소로 고정돼
  있으나(`apps/web/.env.example`·`packages/shared/src/deployments/10143.json` 의 current), 활성
  프로덕션 config 가 아직 이전 배포를 가리키는 동안에는 릴레이/자금이 신규 배포에 있어 서명
  도메인이 어긋나므로 실행하지 말 것.

## 세션 재사용

가입에 성공하면 `e2e/.state/<persona>.state.json`(localStorage 의 `monti.passkey` 포함)과
`<persona>.creds.json`(가상 인증자 자격증명)을 저장한다. 다음 실행에서는 가상 인증자에 자격증명을
다시 심고 `/login` 패스키 로그인으로 재접속해 값비싼 온체인 가입을 반복하지 않는다.
