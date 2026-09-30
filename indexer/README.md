# MONTI 인덱서 (Envio)

Monad 테스트넷(10143)의 MONTI 컨트랙트 세 개를 읽어 GraphQL 로 내보낸다.
Functions 는 `ENVIO_GRAPHQL_URL` 로 이 인덱서에 묻는다.

## 이 디렉터리는 혼자 서 있다

Envio 호스티드 서비스는 저장소에서 **루트 디렉터리로 지정한 폴더 하나만** 가져다
그 안에서 `pnpm install` 을 돌린다. Envio 문서의 말 그대로다 — *"If you're working in
a monorepo, ensure all your imports are contained within your indexer directory."*

그래서 `indexer/` 는 워크스페이스 밖을 가리키지 않는다. 예전에 `@monti/shared` 에서
가져오던 셋은 `scripts/gen-config.mjs` 가 **복제해서 커밋**한다:

| 파일 | 원본 |
| --- | --- |
| `src/vendored/ticket-abi.json` | `packages/shared/src/abi/Ticket.json` |
| `src/vendored/deployment.json` | `contracts/deployments/10143.json` |
| `src/vendored/event-status.json` | `packages/shared/src/types.ts` 의 `EVENT_STATUS_BY_CODE` |

셋 다 **손으로 고치지 않는다.** 원본이 바뀌면 `pnpm indexer:config` 로 다시 뽑는다.
어긋난 채로 커밋하면 `pnpm indexer:check` 가 막는다(같은 검사가 `pnpm test` 에도 있다).

## 호스티드 배포 — 처음 한 번

1. `https://envio.dev/app/deployments` 에 GitHub 로 로그인한다.
2. **Add indexer** → 이 저장소를 고른다(GitHub App 설치 권한을 한 번 준다).
3. 배포 설정에 이렇게 넣는다.
   - **Root directory**: `indexer`  ← 저장소 루트가 아니다. 반드시 `indexer`.
   - **Config file**: `config.yaml`
   - **Deployment branch**: `mvp`  ← 지금 작업 브랜치다. 나중에 `main` 으로 옮기려면
     이 값만 바꾸면 된다.
   - **Environment variables**: **없다.** 하나도 넣지 않는다.
4. **Deploy** 를 누르고 상태가 `Healthy` 가 될 때까지 기다린다(첫 싱크는 수 분).
5. 나오는 `https://indexer.dev.envio.dev/<deployment-id>/v1/graphql` 을 적어 둔다.
   이 값이 Functions 의 `ENVIO_GRAPHQL_URL` 이다.

### 환경변수가 왜 없나

커밋된 `config.yaml` 에는 `rpc:` 절이 없다. 데이터는 Envio 의 **HyperSync** 에서
오고, 호스티드 서비스는 토큰을 알아서 넣는다. 그래서 키도 URL 도 줄 것이 없다.

`CHAIN_ID` 와 `RPC_URL` 은 **로컬 생성기·로컬 실행 전용**이다.
- `CHAIN_ID` — `pnpm indexer:config` 가 어느 배포 파일을 읽을지(기본 `10143`).
- `RPC_URL` — 로컬에서 돌릴 때만. `RPC_URL=… pnpm indexer:config` 로 다시 뽑으면
  `config.yaml` 에 rpc 소스가 붙는다. **그 판을 커밋하면 안 된다** —
  `pnpm indexer:check` 가 잡는다.

또 하나: 핸들러가 공연 메타를 읽을 때 쓰는 RPC 는 `RPC_URL` 이 없으면
`https://testnet-rpc.monad.xyz` 다. 호스티드에서 공연 생성 이벤트가 밀리면
그때 아카이브 RPC 를 `RPC_URL` 로 넣어 준다(그전엔 넣지 않는다).

## 무료 플랜의 한계

- 조직당 인덱서 **3개**
- 인덱서당 배포 **3개** (네 번째를 올리면 가장 오래된 것이 밀려난다)
- **소프트 삭제**: 7일 동안 아무도 질의하지 않거나, 처리 이벤트가 10만 건을 넘으면
  중단된다. 대시보드에서 되살릴 수 있다.
- **하드 삭제**: 30일 동안 그대로면 지워진다. 그때는 다시 배포해야 한다.

데모 전날에 한 번 질의를 날려 깨워 두는 것이 안전하다.

## 01b 재배포 뒤에 할 일

컨트랙트를 다시 배포하면 주소와 시작 블록이 전부 바뀐다. 순서는 이렇다.

```bash
# 1. contracts/deployments/10143.json 과 packages/shared/src/abi/*.json 이 갱신된 뒤
pnpm indexer:config          # config.yaml + src/vendored/* 재생성
pnpm indexer:check           # 생성물이 맞는지 확인(실패하면 1번을 안 돌린 것)
git add indexer/config.yaml indexer/src/vendored
git commit -m "chore(indexer): 01b 재배포 주소 반영"
git push origin mvp
```

**배포 브랜치에 푸시할 때마다 인덱서는 시작 블록부터 다시 인덱싱한다.** 주소가 바뀐
뒤에는 그게 맞는 동작이다 — 옛 주소의 데이터는 버려야 한다. 반대로 말하면, 의미 없는
푸시도 전체 재싱크를 부른다. 데모 직전에는 배포 브랜치를 건드리지 않는다.

## pnpm 버전

Envio 호스티드는 *"The deployment must be compatible with pnpm version 10.32.0"* 라고
말한다. 지금 저장소 루트 `package.json` 은 `"packageManager": "pnpm@10.33.0"` 이다 —
**더 새 버전**이라 lockfile 형식(`lockfileVersion: '9.0'`)이 같고 충돌하지 않는다.
`indexer/package.json` 에는 `packageManager` 핀이 없으므로 호스티드는 제 pnpm 을 쓴다.

만약 배포 로그에 pnpm 버전 관련 오류가 뜨면, 루트 핀을 건드리지 말고
`indexer/package.json` 에 `"packageManager": "pnpm@10.32.0"` 한 줄만 더한다.

## 로컬에서 돌리기

Docker 가 떠 있어야 한다(Postgres + Hasura 를 띄운다).

```bash
cd indexer
RPC_URL=https://testnet-rpc.monad.xyz pnpm dev
```

`http://localhost:8080` 에 Hasura 콘솔이 뜬다. 끝나면 `config.yaml` 을 원래대로
되돌린다(`pnpm indexer:config` — RPC_URL 없이).

## 스크립트

| 명령 | 하는 일 |
| --- | --- |
| `pnpm indexer:config` (루트) | `config.yaml` + `src/vendored/*` 재생성 |
| `pnpm indexer:check` (루트) | 생성물 드리프트 + `src/` 의 외부 import + `workspace:` 의존성 검사 |
| `pnpm codegen` | 생성기 → `envio codegen` |
| `pnpm dev` | codegen → 로컬 인덱서 (Docker 필요) |
| `pnpm test` | vitest (핸들러 + 스키마 + 자기완결성 가드) |
| `pnpm typecheck` | `tsc --noEmit` |

<!-- hosted deployment note: 2026-09-30 redeploy (Ticket 0x7E1f…51Cf) — rebuild triggered 2026-09-30 14:06 KST because the first hosted build (ae91e90) never started its fetcher -->
