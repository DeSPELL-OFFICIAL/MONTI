# MONTI 스폰서드 op 가스 비용 분석 (읽기 전용)

작성 2026-09-27 · 체인 Monad testnet(10143) · EntryPoint v0.6 · 실측 102 gwei(base 100 + tip 2)

## 0. 한 줄 요약
op 1건이 페이마스터 예치금에서 **0.16~0.27 MON** 빠진다. 비용의 **68~76%가 preVerificationGas(PVG)**
한 항목이고, PVG가 큰 이유는 (1) **Monad가 트랜잭션을 "한도(gasLimit)"로 과금**하고 (2) initCode(계정
최초 배포)가 calldata를 부풀리기 때문이다. 가장 큰 절감 레버는 **배치 → 최초 op initCode 제거 → PVG 축소** 순.

## 1. 온체인 증거 3건 (persona run, 실제 채굴)
UserOperationEvent(actualGasCost/actualGasUsed) + 번들 tx 대조. **세 tx 모두 번들 tx의 gasUsed == gasLimit**
= Monad가 사용량이 아니라 한도로 문다는 직접 증거.

| op (userOpHash) | initCode | PVG | VGL(한도) | CGL(한도) | actualGasUsed | 예치금 차감 | 번들tx@한도 | 번들러 손익 |
|---|---|---|---|---|---|---|---|---|
| createEvent 1st `0x5d9a4745…` | 있음 | 1,948,443 | 490,327 | 403,805 | 2,654,326 | **0.2707 MON** | 0.3126 | −0.042(적자) |
| createEvent 2nd `0x99b61cab…`(같은 계정) | 없음 | 1,035,594 | 186,818 | 403,805 | 1,528,040 | **0.1559 MON** | 0.1498 | +0.006(흑자) |
| claim `0x429c4352…` | 있음 | 1,935,396 | 529,741 | 279,224 | 2,531,241 | **0.2582 MON** | 0.3197 | −0.062(적자) |

## 2. op당 비용 분해 (예치금 차감 = actualGasUsed × 102 gwei)
actualGasUsed = **PVG(견적값 그대로 전액 부과)** + 계량된(verification + call + postOp). PVG만 고정이고 나머지는 실사용.

| 항목 | createEvent(initCode) | claim(initCode) | createEvent(배포됨) |
|---|---|---|---|
| PVG | 0.1987 MON (73%) | 0.1974 MON (**76%**) | 0.1056 MON (68%) |
| verification+call+postOp(계량) | 0.0720 MON | 0.0608 MON | 0.0502 MON |
| **합계(예치금 차감)** | **0.2707** | **0.2582** | **0.1559** |

- **postOp은 무시해도 됨**: `MontiPaymaster.postOp`(src 237–251)은 platform 슬롯이면 emit 1회, project
  슬롯이면 SSTORE 2회+emit ≈ 5~25k. v0.6엔 별도 `postOpGasLimit` 필드가 없고 verification 예산 안에서 계량된다.

## 3. 왜 PVG가 1.8M인가 (Monad 특수성)
- 이더리움의 PVG는 ~40~60k. Monad에서 1.8~1.9M = **약 30~40배**. 부풀린 주체는 Alchemy rundler.
- 번들 tx는 Monad에서 **한도로 과금**된다(증거 §1: gasUsed==gasLimit). 번들러는 이 한도×가격을 실제로 지불하고,
  EntryPoint가 beneficiary에게 지급하는 보상 = 각 op의 **actualGasCost**(= actualGasUsed×가격)뿐이다.
- actualGasUsed는 **PVG를 전액 포함**하므로, rundler는 "한도로 문 번들 비용"을 op가 되갚게 하려고 **PVG를 크게
  잡는다.** Monad는 블록이 ~0.3s라 rundler가 **번들당 op 1개**만 담아(§1 opsInBundle=1) 고정 오버헤드를 나눠 못
  가진다 → op마다 PVG를 크게 올린다.
- 정산 결과는 대략 손익분기: createEvent 1st·claim은 번들러가 op당 0.04~0.06 MON 적자, 배포된 op은 소폭 흑자.
  즉 **PVG가 낮아지면 예치금 차감이 그대로 줄지만, 너무 낮으면 rundler가 번들에 안 담거나 EntryPoint가 AA9x로 되돌린다.**

## 4. 한도 vs 사용 격차는 누가 부담하나
- **페이마스터 예치금** = actualGasCost = actualGasUsed×가격(= PVG 전액 + 계량분). 한도의 VGL/CGL 패딩은
  **직접 차감하지 않는다**(계량분만 문다). → 7.5% 버퍼·150k VGL 하한을 낮춰도 예치금은 거의 안 줄고, 번들 tx 한도만
  줄어 **번들러 부담만 덜어준다**(간접적으로 rundler가 PVG를 낮출 여지).
- **번들러**(Alchemy)가 한도−사용 격차를 흡수한다(§1의 −0.04~−0.06). 테스트넷이라 지금은 문제없지만 메인넷에선
  번들러가 이 적자를 PVG를 더 올려 메꿀 수 있다.

## 5. 레버 (절감 / 리스크)
| # | 레버 | op당 절감 | 리스크 |
|---|---|---|---|
| **(f)** | **배치**(executeBatch로 여러 콜을 1 op) | 회피한 op마다 ~0.26 MON. approveClaims(uint256[])는 이미 컨트랙트 배치 → 웹이 직렬 op를 보내지 말 것 | 낮음. 배치가 커지면 CGL↑(한도 과금이므로 계량분만 증가) |
| **(a)(b)** | **최초 op의 initCode 제거**(가입 시 계정 선배포) | ~0.11 MON/op(0.27→0.16, **−42%**). PVG 1.95M→1.04M, VGL 490k→187k | 낮음. **단 실제로 선배포돼야 실현**된다 |
| **(d)** | **PVG 축소**(자체 rundler의 pvg 오버라이드 / estimate state override) | PVG가 68~76%이므로 15~25% 낮추면 ~0.03~0.05 MON/op | **높음**: 너무 낮으면 "accepted, never bundled" 재발 또는 AA9x(preVerificationGas too low) |
| (c) | VGL/CGL 패딩·150k 하한 축소 | 예치금엔 거의 0(간접만) | AA23 out-of-gas — 문서상 이미 겪음. **건드리지 말 것** |
| (e) | paymaster postOp 최적화 | ~0 | 무의미 |

### initCode 확인 결과 (task의 핵심 질문)
- 웹은 **eth_getCode로 배포 여부를 확인한다**: `account.getFactoryArgs()`(sendSponsoredOp.ts:202) → viem
  2.38 `toSmartAccount.getFactoryArgs`가 `isDeployed()`→`getCode`를 호출해 **배포된 계정엔 initCode를 붙이지
  않는다.** 증거 §1의 createEvent 2nd(같은 계정, initCode 없음)가 이를 확증.
- **그러나 claim(0x429c4352)은 아직 initCode를 달고 있다** = 참석자 계정이 **가입 시 선배포되지 않고 첫 claim에서
  자기배포** 중. 레버 (a)(b)의 0.11 MON 절감은 **가입 단계에 계정 배포 op을 추가해야 실현된다**(현재 미실현).

## 6. 예산 규칙 (테스트넷)
- **op당 예산**: 배포된 계정 op 0.16 MON, 최초/미배포 op 0.27 MON → **최악 0.30, 혼합 평균 ~0.20 MON**
  (관측 3.34 MON / 15 op ≈ 0.22와 일치).
- **100 op당**: 약 **20~30 MON** 소진.
- **in-flight prefund**(검증 시 예약, maxFee 202 gwei): (CGL + 3×VGL + PVG)×202gwei = createEvent-initCode
  **0.77 MON**, claim-initCode 0.77 MON, 배포된 op 0.40 MON. **동시 in-flight N건이면 예치금 > N×0.77 MON**
  이어야 AA31/precheck 실패(‑32000)를 피한다. 데모 전 플랫폼 예치금 **≥ 5 MON** 권장(현재 새 PM `0xf732…` ≈2.30 MON).

## 7. 메인넷 추정 (가정 명시)
- Monad 메인넷 미가동(지식컷 기준) → 가스가격 미확정. **가정: base fee가 테스트넷과 같은 100 gwei로 고정**되면
  MON 표기 비용은 동일(0.16~0.27 MON/op). 실화폐 비용 = op당 MON × MON 시세.
- 예) 0.20 MON/op × (MON=$Y) = **$0.20·Y / op**. base fee가 더 낮게 설정되면 그 비율만큼 감소.
- 메인넷 리스크: 번들러가 흡수하던 한도−사용 적자(§4)를 PVG 인상으로 전가할 수 있어 **op당 비용이 지금보다 오를 수 있음** → 레버 (f)(a)(b) 선적용 권장.
