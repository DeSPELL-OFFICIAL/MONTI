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
| `E2E_MANUAL_CAPTCHA=1` | 가입 시 reCAPTCHA 이미지 챌린지를 **사람이 직접** 풀도록 최대 5분 대기 | off |
| `E2E_APPROVAL=1` | 승인제 시나리오(d) 및 승인 행사 생성 활성화 | off |

## 지금 막혀 있는 것 (중요)

- **가입의 reCAPTCHA**: Firebase 전화 인증의 invisible reCAPTCHA 가 자동화 환경에서 점수가
  낮아 한국어 이미지 챌린지("자전거가 포함된…")로 승격된다. 봇이 풀 수 없으므로 **완전 자동
  가입은 현재 막혀 있다.** 두 경로 중 하나가 필요하다.
  1) 헤디드로 `E2E_MANUAL_CAPTCHA=1` 실행 후 사람이 챌린지를 1회씩 푼다(재실행 시 세션 재사용).
  2) 다음 배포에서 테스트 번호에 한해 `appVerificationDisabledForTesting` 를 켜는 훅을 노출한다.
- **승인제(d)**: 신청 관리(승인) 화면과 `VITE_APPROVAL_MODES=on` 은 01c 배포에서 도착한다.
- **유료 티켓**: 컨트랙트가 계속 거절 — 시나리오 a 는 "발행 버튼 비활성 + 안내 문구"만 검증한다.

## 세션 재사용

가입에 성공하면 `e2e/.state/<persona>.state.json`(localStorage 의 `monti.passkey` 포함)과
`<persona>.creds.json`(가상 인증자 자격증명)을 저장한다. 다음 실행에서는 가상 인증자에 자격증명을
다시 심고 `/login` 패스키 로그인으로 재접속해 값비싼 온체인 가입을 반복하지 않는다.
