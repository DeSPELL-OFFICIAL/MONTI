# MONTI 디바이스 데이 런북 — 실제 스태프 폰으로 가는 전체 재배포

작성 2026-09-27 · 대상 체인 Monad testnet(10143) · RPC `https://testnet-rpc.monad.xyz`

> **왜 "전체" 재배포인가.** 01c 부분 재배포는 Ticket·Paymaster만 새로 올리고 Identity·Organizers를 유지했다.
> 그런데 `Organizers.setTicket` 은 **한 번만** 부를 수 있고 이미 옛 Ticket에 묶여 있어 **새 행사가 자기 게이트를
> 등록할 수 없다**(kept Organizers의 `registerGate` 가 옛 Ticket으로 org 조회 → `UnknownSender`). 현장에서 **실제
> 스태프 폰의 게이트 키**로 문을 열려면 네 계약(Identity·Organizers·Ticket·Paymaster)을 **모두** 새로 배포하고
> 실제 게이트 키로 시드해야 한다. 그래서 주소 4개가 전부 바뀐다. **ABI는 안 바뀐다**(01c가 이미 소비자에 반영됨).

용어: **창업자** = 폰·대시보드·승인 담당(비개발자). **에이전트/운영자** = 맥북 명령 실행 담당. 비밀값은
`/Users/moomi/Downloads/z03.Vibe_Coding/MONTI/.secrets/.env`(`DEPLOYER_PK`, `ALCHEMY_API_KEY`, `PINATA_JWT`,
`DIDIT_*`)와 서비스 계정 `monti-deployer.json` 에 있다. **어떤 값도 화면·커밋·보고서에 찍지 않는다.**

## 0. 준비물 & 잔액 체크리스트 (창업자 먼저, 에이전트 확인)

| 대상 | 주소 | 필요 잔액 | 이유 |
|---|---|---|---|
| **deployer** | `0x509ed82E0FCaE0c8A6cdE6Ddeb12eb5dc836BCf3` | **≥ 6 MON** | 배포 4건 가스 ≈1.5 + **stake 1 + deposit 1** + 시드/멤버 펀딩 ≈0.6 (deposit 상향 시 그만큼 더) |
| **attester** | `0x6af898aA4d99375839d7069431A7019a6D84C4Ed` | **≥ 2 MON** | 데모 멤버 3명 `register` 가스 |
| **paymaster deposit** | 배포 시 생성 | **예상 op 수 × 0.3 MON** | op 1건 예치금 차감 0.16(선배포)~0.27(initCode 첫 op), 최악 0.30. 동시 in-flight 1건당 ≈0.77 예약 → 데모 전 **≥ 5 MON** 권장 |

- **창업자**: Monad 테스트넷 faucet에서 위 두 주소(deployer, attester)를 목표치까지 채운다.
- **에이전트 확인**: `export R=https://testnet-rpc.monad.xyz`
  ```bash
  cast balance 0x509ed82E0FCaE0c8A6cdE6Ddeb12eb5dc836BCf3 --rpc-url $R --ether   # ≥ 6
  cast balance 0x6af898aA4d99375839d7069431A7019a6D84C4Ed --rpc-url $R --ether   # ≥ 2
  cast chain-id --rpc-url $R                                                       # 10143
  ```
- **자금 마련용 stake 회수**: 옛 PM `0xf73220…8dE4`·`0xBDDB…28B2`·`0xDa78…2539` 는 `unlockStake()` 24h 뒤
  `withdrawStake(deployer)` 로 각 1 MON 회수(예치금 1 MON은 회수 함수 없음 = 소실).

## 1. 스태프 폰에서 게이트 키 받기 (창업자 + 스태프)

1. 스태프 폰 **MONTI Staff 앱** → "휴대폰 번호로 로그인" → 번호·문자 코드 입력.
2. 로그인 후 **설치 화면(`/staff/setup`)** 에 StrongBox 게이트 키의 **게이트 계정 주소(0x…, 42자)** 와 **`kx`/`ky`
   (각 0x…, 66자)** 가 mono 글꼴로, 같은 내용의 QR(`MONTI-GATE…:` + JSON)도 뜬다.
3. 세 값을 맥북으로 옮긴다(타이핑 금지 — QR 스캔/복사). 에이전트가 변수로 받는다:
   ```bash
   export GATE_ACCOUNT=<폰_주소>
   export SEED_GATE_KX=<폰_kx>
   export SEED_GATE_KY=<폰_ky>   # KX/KY 순서 바꾸면 검증 영구 실패 — 되돌릴 수 없음
   ```
   > "게이트 키를 만들 수 없어요" = StrongBox `DIGEST_NONE` 키 생성 실패 → 앱 재설치/기기 교체.

## 2. 전체 재배포 명령 순서 (에이전트)

소스 워크트리 `MONTI-01b/contracts`(mvp-01b, 01c 포함). 비밀값 로드 + 환경:
```bash
cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/MONTI-01b/contracts
set -a; source /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/.secrets/.env; set +a   # DEPLOYER_PK 등
export R=https://testnet-rpc.monad.xyz
export ATTESTER_ADDRESS=0x6af898aA4d99375839d7069431A7019a6D84C4Ed
export ATTESTER_PK=$(firebase functions:secrets:access ATTESTER_PK --project mon-ti)   # 변수로만
export STAKE_WEI=1000000000000000000 DEPOSIT_WEI=5000000000000000000                   # 1 MON / 5 MON
export SEED_IMAGE_CID=bafkreiepv7iydmisqmk2qrht7zwfeaxtf7sljdzfbfhtthjgpovrknn754      # 데모 메타(Pinata 기핀)
cast wallet address --private-key $ATTESTER_PK   # 0x6af8…C4Ed 확인(안 맞으면 시드 8콜 뒤 NotAttester)
```
**① Deploy** — 네 계약 + stake/deposit + paymaster allow-list 시드 + `deployments/10143.json` 기록(`run()` 이 함께 함):
```bash
forge script script/Deploy.s.sol:Deploy --rpc-url $R --broadcast --slow --non-interactive --code-size-limit 131072
```
> `--gas-limit 30000000` **금지**(Monad는 한도로 과금). Ticket이 EIP-170(24,576 B) 초과 → `--non-interactive
> --code-size-limit 131072` 없으면 forge 확인 프롬프트에서 멈춤.

**② Seed** — JSON에서 주소 읽어 **실제 게이트 키**로 org·행사·게이트·데모 티켓 생성. 전체 재배포라 `SEED_REUSE_ORG`
는 **끈 채(기본)** → 새 Organizers에 `createOrganizer`+`registerGate`+`openGate` 실행:
```bash
forge script script/Seed.s.sol:Seed --rpc-url $R --broadcast --slow --non-interactive --code-size-limit 131072
# 콘솔: orgId / eventId / gateId / gateAccount / member×3 = tokenId
```
**③ allow-list · 게이트 검증** — JSON의 새 주소를 변수로:
```bash
T=<새_ticket>; P=<새_paymaster>; O=<새_organizers>
cast call $P "allowedSelector(bytes4)(bool)" 0x09406344 --rpc-url $R   # claim=true
cast call $P "allowedSelector(bytes4)(bool)" 0x85563044 --rpc-url $R   # requestClaim=true (01c)
cast call $O "isOpenGate(uint256,address)(bool)" 1 $GATE_ACCOUNT --rpc-url $R   # true 여야 문 열림
```
**④ deployments 동기화** — Deploy가 쓴 `contracts/deployments/10143.json`(주소4+`block`, 옛 세트는 `previous[]`
자동 보존)을 소비자로 반영: `pnpm --filter @monti/shared sync:deployments`

## 3. 소비자 플립 체크리스트 (에이전트) — **이번엔 주소만 바뀐다**

01b→01c 때와 달리 **ABI 재생성·`DEVICE_DIGEST_FORM` 뒤집기·`STRUCT_SHAPES` 변경 없음.** 소비자는 이미 01c ABI를
쓰고 주소는 런타임 `VITE_ADDR_*` 로 읽어 픽스처 재파생도 자동. 바꿀 것은 **주소 4개**뿐:

| 위치 | 키 | 값 |
|---|---|---|
| `packages/shared/src/deployments/10143.json` | identity/organizers/ticket/paymaster/block | 2-④에서 동기화 |
| Vercel web (prod+preview) | `VITE_ADDR_IDENTITY`/`_ORGANIZERS`/`_TICKET`/`_PAYMASTER` | 새 주소 4개 |
| `functions/.env` (backend) | `CHAIN_ID`/`RPC_URL`/`ENVIO_GRAPHQL_URL`(4-⑤) | 10143 / RPC / 새 인덱서 |
| staff `apps/web/.env.*` | 동일한 `VITE_ADDR_*` 4개 | 새 주소 4개 |

```bash
for K in IDENTITY ORGANIZERS TICKET PAYMASTER; do
  vercel env rm VITE_ADDR_$K production -y; vercel env rm VITE_ADDR_$K preview -y; done
# 이어서 vercel env add VITE_ADDR_<K> production / preview (값은 stdin, 화면 미출력). 반영은 다음 배포부터.
```

## 4. 인덱서 재빌드 절차 (창업자 대시보드 + 에이전트)

1. **에이전트** — 새 주소·시작 블록으로 config 재생성(핵심 키는 `block`; 미분류 이벤트면 일부러 실패=가드):
   `cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/MONTI-prod && pnpm indexer:config`
2. **창업자** — Envio Cloud는 **무료 플랜 배포 최대 3개**. 새 배포 전에 **가장 오래된 배포 삭제**(롤백 대비 라이브는 가능하면 유지).
3. **에이전트** — `envio-release` 브랜치를 mvp-backend 커밋으로 **fast-forward** 해 재빌드 트리거(push마다 id 변함):
   `git push origin mvp-backend:envio-release`
4. **창업자** — 배포가 초록이 되면 **새 엔드포인트 id** 전달(`…/dev.hyperindex.xyz/<id>/v1/graphql` 무료 / `indexer.hyperindex.xyz` 유료).
5. **에이전트** — 새 URL을 `functions/.env` `ENVIO_GRAPHQL_URL` + Vercel `VITE_ENVIO_URL`(prod+preview)에 넣고 재배포:
   ```bash
   export GOOGLE_APPLICATION_CREDENTIALS=/Users/moomi/Downloads/z03.Vibe_Coding/MONTI/.secrets/monti-deployer.json
   fnm exec --using=22 pnpm --filter monti-functions run deploy   # firebase deploy --only functions
   vercel --prod --scope despells-projects                        # MONTI-web → monti.despell.io
   ```
   > 두 인덱서 호스트(dev/paid) 모두 이미 CSP `connect-src` 에 있어 URL만 바꾸면 됨.

## 5. 계정 초기화 (창업자 승인 + 에이전트)

새 Identity엔 옛 패스키 계정이 전부 죽음. **테스트 계정만** 즉시 파기(체인 미접촉):
```bash
export GOOGLE_APPLICATION_CREDENTIALS=/Users/moomi/Downloads/z03.Vibe_Coding/MONTI/.secrets/monti-deployer.json
export DIDIT_API_KEY=$(firebase functions:secrets:access DIDIT_API_KEY --project mon-ti)
fnm exec --using=22 pnpm --filter monti-functions exec tsx scripts/reset-persons.ts --all         # 드라이런
# 창업자 "지워" 확인 후:
fnm exec --using=22 pnpm --filter monti-functions exec tsx scripts/reset-persons.ts --all --yes
```
- 지우는 것: Didit 세션·persons(개인정보 필드만, status=deleted)·users·passkeys·devices·phoneIndex·Auth 사용자·주인 잃은 `eventDrafts/{uid}/drafts/*`.
- **Firebase 테스트 번호는 유지**(+821000000001~10, 코드 123456 — SMS 없이 로그인, harness용).
- 삭제 후 **창업자·테스터는 새 계약에서 재가입**(초안은 uid 바뀌어 복구 불가).

## 6. 검증 순서 (에이전트 harness + 창업자 폰)

1. **에이전트 — 페르소나 harness 축소 통과**(프로덕션 대상, 예치금 절약):
   ```bash
   cd /Users/moomi/Downloads/z03.Vibe_Coding/MONTI/MONTI-prod
   E2E_APPROVAL=1 fnm exec --using=22 pnpm -F web e2e e2e/tests/01-public-surface.spec.ts   # 표면 먼저
   E2E_APPROVAL=1 fnm exec --using=22 pnpm -F web e2e                                        # a/b/c/d 핵심
   ```
   기대: 가입→KYC→행사 생성→claim→(승인제 d) 승인→발급 초록. 실패 시 `e2e/.artifacts/`·`.report/` 확인.
2. **창업자 — 실제 폰 수동 1회**: 가입 → KYC(Didit) → 행사 만들기(+**발행** 버튼까지) → claim → 스태프 앱 **NFC 탭**
   → 입장 기록 확인. 승인제면 신청→관리자 승인→입장까지.
   > 탭 전 스태프 "게이트 무장" + 관객 "무장", `isOpenGate` true(2-③) 필요.

## 7. 롤백 (문제 시)

- **주소 되돌리기**: `deployments/10143.json` `previous[0]` 에 직전 세트(현재 라이브 identity `0x961a…8133` /
  organizers `0xa88C…81F0` / ticket `0x40D9…7AFA` / paymaster `0xf732…8dE4`). 이 4개를 `VITE_ADDR_*`·`functions/.env`·공유 JSON에 복원.
- **web 즉시 롤백**: Vercel 대시보드 → 직전 프로덕션 배포 **Instant Rollback**.
- **functions 롤백**: 옛 주소·옛 `ENVIO_GRAPHQL_URL` 로 `functions/.env` 복원 후 `run deploy` 재실행.
- **인덱서**: Envio 릴리스 브랜치를 직전 커밋으로 되돌려 재빌드(id 다시 바뀜 → URL 재주입).
- reset-persons는 **되돌릴 수 없음** — 6단계 검증 전에는 `--yes` 금지.

## 8. 소요 시간 & 담당

| 단계 | 담당 | 예상 |
|---|---|---|
| 0 준비물·잔액·faucet | 창업자(에이전트 확인) | 20분 |
| 1 게이트 키 받기 | 창업자+스태프 | 10분 |
| 2 전체 재배포(Deploy+Seed+검증) | 에이전트 | 15분 |
| 3 소비자 env 플립 | 에이전트 | 15분 |
| 4 인덱서 재빌드 | 창업자+에이전트 | 30분 |
| 5 계정 초기화 | 창업자 승인+에이전트 | 5분 |
| 6 검증(harness+수동 폰) | 에이전트+창업자 | 35분 |
| 7 롤백 | (필요 시) | 10~15분 |

**정상 진행 코어 ≈ 90분, 준비·검증 포함 총 ≈ 2시간**(Envio 재빌드 대기·faucet 지연 시 +30~60분).
