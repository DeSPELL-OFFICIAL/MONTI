# functions — 운영 메모

Cloud Functions 소스. 일상적인 명령은 `package.json` 의 스크립트에 있다
(`pnpm test`, `pnpm test:rules`, `pnpm build`, `pnpm build:deploy`, `pnpm deploy`).
이 문서에는 **손으로 돌리는 작업**만 적는다.

## 테스트 계정 초기화 — `scripts/reset-persons.ts`

계약을 새로 배포하면 옛 `Identity` 에 등록된 계정은 전부 죽은 계정이 된다. 그 계정들은
7일 유예를 기다릴 이유가 없으므로(진짜 사용자가 아니다) 이 스크립트가 **즉시** 지운다.
지우는 일 자체는 매일 04:00 에 도는 `processDeletions` 와 **같은 함수**
(`src/lib/erasePerson.ts`)가 한다 — 두 경로에 사본은 없다.

### 돌리는 법

`functions/` 안에서, Node 22 로 돈다. 비밀값은 Secret Manager 에서 바로 꺼내 환경변수로 넘긴다
(파일로 떨어뜨리지 않는다).

```sh
GOOGLE_APPLICATION_CREDENTIALS=/절대경로/monti-deployer.json \
DIDIT_API_KEY="$(firebase functions:secrets:access DIDIT_API_KEY --project mon-ti)" \
fnm exec --using=22 pnpm --filter monti-functions exec tsx scripts/reset-persons.ts --all
```

대상은 셋 중 하나를 고른다.

| 인자 | 뜻 |
| --- | --- |
| `--all` | 아직 지워지지 않은 사람 전부 (`persons` 에서 `status` 가 `deleted` 가 아닌 문서) |
| `--person <personId>` | `0x` + 64 hex 하나 |
| `--phone <E.164>` | 예: `+821012345678`. 평문 번호는 Firestore 에 없으므로 Firebase Auth 로 uid 를 찾는다 |

`--yes` 가 **없으면 드라이런**이다 — 대상만 찍고 아무것도 건드리지 않는다.
번호는 가려서 나온다(`+8210****5678`). 먼저 목록을 눈으로 확인하고, 같은 명령에 `--yes` 를
붙여 다시 돌린다. 사람마다 한 줄씩 영수증이 나온다:

```
    1. 0xaa…  +8210****5678  status=active  kyc=approved  createdAt=2026-09-21T04:11:07.000Z

     0xaa…  didit sessions deleted 2, firestore docs deleted 6, auth deleted yes
```

`DIDIT_API_KEY` 가 없으면 드라이런조차 거부한다. 키 없이 Firestore 를 먼저 털면 `sessionId`
가 사라져 Didit 에 남은 얼굴 자료를 **영영** 못 지운다.

### 지우는 것 / 두는 것

지운다 — Didit 세션(연 적 있는 것 전부) · `persons`(문서는 남기고 개인정보 필드만 턴다,
`status='deleted'`) · `users` · `passkeys` · `devices` · `phoneIndex` · Firebase Auth 사용자 ·
`eventDrafts/{uid}/drafts/*`(주인이 사라진 행사 초안).

둔다 — `orgProfiles` · `eventPrivate` · `eventArt` 는 **사람이 아니라 행사**에 달려 있다
(문서 id 가 `eventId` 다). 주최자 한 명을 지운다고 그 행사의 이름·장소·티켓 그림이 사라지면
안 되므로 그대로 둔다. `deletionRequests` 도 건드리지 않는다 — 이 경로에는 요청 자체가 없다.

**체인은 건드리지 않는다.** 옛 계약은 그냥 버린다(스펙 §10.2). `Identity` 항목과 이미 발급된
티켓은 남지만 `personId` 는 아무 의미 없는 난수이고 계정 주소·기기 키에는 개인정보가 없다.

전부 멱등이다 — 같은 대상에 다시 돌리면 0건을 세고 끝난다.
