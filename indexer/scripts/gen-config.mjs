/**
 * `config.yaml` 생성기.
 *
 * 두 가지를 손으로 적지 않는다.
 *  1. **주소와 시작 블록** — `contracts/deployments/${CHAIN_ID}.json` 에서 읽는다.
 *     01b 재배포(sub-plan 01b)가 네 주소와 start_block 을 전부 바꾸므로, 배포
 *     파일을 갱신하고 이 스크립트를 다시 돌리는 것이 유일한 갱신 경로다.
 *  2. **이벤트 시그니처** — `packages/shared/src/abi/*.json` (커밋된 ABI 내보내기)
 *     에서 만든다. Envio 는 시그니처 문자열을 그대로 topic0 으로 해싱하므로
 *     `uint64` 를 `uint256` 으로 잘못 적으면 조용히 아무것도 인덱싱하지 않는다.
 *     ABI 에서 만들면 그 오타가 원천적으로 불가능하다.
 *
 * 그리고 **`src/vendored/`** 를 함께 낸다. Envio 호스티드 서비스는 루트 디렉터리로
 * `indexer/` 하나만 올려 거기서 `pnpm install` 을 돌리므로, 워크스페이스 밖
 * (`@monti/shared`, `contracts/`)을 가리키는 import 가 하나라도 있으면 배포가 깨진다.
 * 그래서 핸들러가 쓰는 세 가지 — Ticket ABI, 10143 배포 파일, `EVENT_STATUS_BY_CODE` —
 * 를 이 스크립트가 `indexer/src/vendored/*.json` 으로 복제해 커밋한다. 손으로 고치지
 * 않는다. 어긋나면 `pnpm indexer:check` 가 막는다.
 *
 * `GEN_OUT_DIR` 를 주면 `config.yaml` 과 `src/vendored/` 를 그 디렉터리 아래에 낸다 —
 * 드리프트 검사(`scripts/check-selfcontained.mjs`)가 임시 디렉터리로 다시 뽑을 때 쓴다.
 *
 * RPC_URL 을 주면 그 RPC 를 **주 데이터 소스**로 적는다. 로컬 실행용이다 —
 * Monad testnet 의 HyperSync 는 API 토큰 없이는 0/0 으로 막힌다
 * (`rate limited by server (remaining=0/0)`). 호스티드(Task 38)는 토큰이 있으므로
 * 커밋되는 config.yaml 은 RPC_URL 없이 만든 HyperSync 판이다.
 *
 * 구독 목록은 아래 CONTRACTS 가 정한다(ABI 전체가 아니다). 한 컨트랙트의 ABI 이벤트는
 * 셋 중 정확히 하나에 들어가야 한다 — `events`(구독), `reserved`(01b 가 더할 것; ABI 에
 * 아직 없으면 건너뛰고, 재내보내기 뒤에는 이 파일을 고치지 않아도 들어온다),
 * `ignored`(대응 엔티티가 없어 일부러 버리는 것). 셋 중 어디에도 없는 이벤트가 나오면
 * **던진다**: 새 이벤트가 조용히 인덱싱에서 빠지는 것이 이 스크립트가 막아야 할 사고다.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeStartBlock } from './start-block.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
/** 커밋된 `indexer/` 루트. 벤더된 ABI 소스는 임시 출력 디렉터리가 아니라 여기서 읽는다. */
const indexerRoot = join(here, '..');
/** 기본은 `indexer/`. 드리프트 검사만 임시 디렉터리로 돌린다. */
const outRoot = process.env.GEN_OUT_DIR ? resolve(process.env.GEN_OUT_DIR) : join(here, '..');
const chainId = process.env.CHAIN_ID ?? '10143';
const rpcUrl = process.env.RPC_URL ?? '';

/** 배포 파일의 어느 키가 어느 컨트랙트인지 + 무엇을 구독하는지. */
const CONTRACTS = [
  {
    name: 'Identity',
    addressKey: 'identity',
    events: [
      'Registered',
      'AccountRotated',
      // 01b C3: 회전 되돌리기. 2026-09-23 재배포로 ABI 에 들어와 실제 구독한다.
      // `cancelRotation` 이 `AccountRotated(personId, current, msg.sender)` 를 **먼저**
      // 내므로 "현재 계정" 되돌리기는 그 핸들러가 이미 한다. 이것은 감사 로그용이다.
      'RotationCancelled',
      'DeviceChanged',
      'DeviceLocked',
      'NicknameSet',
      'KycLevelSet',
    ],
    reserved: [],
    // 어테스터 키 교체는 체인 밖 운영 사건이고 대응 엔티티가 없다.
    ignored: ['AttesterChanged'],
  },
  {
    name: 'Organizers',
    addressKey: 'organizers',
    events: [
      'OrganizerCreated',
      'AdminSet',
      'ManagerSet',
      'OwnerTransferred',
      'GateRegistered',
      'GateRevoked',
      'GateOpened',
      'GateClosed',
    ],
    reserved: [],
    ignored: [],
  },
  {
    name: 'Ticket',
    addressKey: 'ticket',
    events: [
      'EventCreated',
      'EventStatusChanged',
      'EventMetaUpdated',
      'Claimed',
      // 01c: 승인제 클레임. requestClaim → ClaimRequested 로 Pending 을 열고,
      // approveClaims → ClaimApproved(+tokenId) 로 Approved, rejectClaims/cancelRequest
      // → ClaimRejected 로 Rejected 로 닫는다. cancel 은 별도 이벤트가 없어 reject 와
      // 같은 ClaimRejected 를 낸다(Ticket.sol) — 인덱서에선 둘 다 Rejected 다.
      'ClaimRequested',
      'ClaimApproved',
      'ClaimRejected',
      'Transfer',
      'CheckedIn',
      // 01b C1: 오프라인 큐 기록. 2026-09-23 재배포로 ABI 에 들어와 실제 구독한다.
      // `CheckedIn` 과 같은 트랜잭션에 **먼저** 온다 — 입장 수는 `CheckedIn` 으로 세고,
      // 이것으로 `CheckIn.late` 를 true 로 올린다.
      'CheckedInLate',
      'OverrideRequested',
      'ManualOverride',
      'Revoked',
      'Migrated',
      'OfferCreated',
      'OfferCancelled',
      'OfferAccepted',
    ],
    reserved: [],
    // ERC-721 승인 잡음. MONTI 는 approve 경로를 쓰지 않고 엔티티도 없다.
    // `EIP712DomainChanged` 는 ERC-5267 보일러플레이트다 — 우리 Ticket 은 도메인을
    // 바꾸지 않아 실제로 나지 않는다(01b 델타 §2).
    ignored: ['Approval', 'ApprovalForAll', 'EIP712DomainChanged'],
  },
  {
    // SettlementVault — 프로그래머블 정산 레이어(설계 2026-10-01). 코어 넷과 달리 공유 ABI
    // 내보내기가 아직 없어 ABI 를 indexer/ 안에 벤더해 두고 거기서 읽는다
    // (src/vendored/settlement-vault-abi.json). 배포 파일에 `settlementVault` 키가 없으면
    // (아직 배포 전) 조용히 건너뛴다 — 코어 인덱싱은 그대로다. 키가 들어오면 그때 구독한다.
    name: 'SettlementVault',
    addressKey: 'settlementVault',
    optional: true,
    abiFile: join('src', 'vendored', 'settlement-vault-abi.json'),
    abiKey: 'abi',
    // 금고는 코어 재배포(블록 66724502)보다 **나중에** 배포되므로 자기 시작 블록이 따로 있다.
    // Envio 는 컨트랙트별 start_block 을 지원한다(evm.schema.json) — 네트워크 start_block 은
    // 코어 그대로 두고 금고만 자기 배포 블록부터 스캔한다. 배포 파일의 `settlementVaultBlock`
    // 을 쓰고, 없으면 코어 `block` 으로 안전하게 내려간다(금고는 그 전에 이벤트가 없다).
    startBlockKey: 'settlementVaultBlock',
    events: [
      'PolicySet',
      'Deposited',
      'Released',
      'NoShowSettled',
      'Refunded',
      'Paid',
      'PayoutDeferred',
      'Withdrawn',
      'TokenAllowed',
      'DepositorSet',
    ],
    reserved: [],
    // 일시정지 토글은 운영 사건이고 공개 정산 페이지가 쓰는 엔티티가 없다.
    ignored: ['PausedSet'],
  },
];

/** ABI 이벤트 하나를 Envio 가 받는 사람이 읽을 수 있는 시그니처로. */
function signatureOf(abiEvent) {
  const args = abiEvent.inputs.map((input) => {
    if (input.type.startsWith('tuple')) {
      throw new Error(
        `[gen-config] ${abiEvent.name} 의 인자 ${input.name} 이 tuple 이다. ` +
          '튜플 시그니처는 손으로 펼쳐야 한다 — 이 스크립트를 고치세요.',
      );
    }
    return `${input.type}${input.indexed ? ' indexed' : ''} ${input.name}`;
  });
  return `${abiEvent.name}(${args.join(', ')})`;
}

/**
 * 컨트랙트의 ABI 를 읽는다. 기본은 커밋된 공유 ABI 내보내기(packages/shared/src/abi).
 * `abiFile` 이 있으면 indexer/ 안의 벤더 소스에서 읽는다 — 아직 공유로 내보내지 않은
 * SettlementVault 용이다. 임시 출력 디렉터리가 아니라 커밋된 indexerRoot 에서 읽어야
 * 드리프트 검사(GEN_OUT_DIR 로 다시 뽑기)도 같은 소스를 본다.
 */
async function loadContractAbi(contract) {
  if (contract.abiFile) {
    const path = join(indexerRoot, contract.abiFile);
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    return { abi: contract.abiKey ? parsed[contract.abiKey] : parsed, path };
  }
  const path = join(repoRoot, 'packages', 'shared', 'src', 'abi', `${contract.name}.json`);
  return { abi: JSON.parse(await readFile(path, 'utf8')), path };
}

function eventsOf(contractName, abi, path, wanted, reserved, ignored) {
  const byName = new Map(
    abi.filter((item) => item.type === 'event').map((item) => [item.name, item]),
  );

  const lines = [];
  for (const name of wanted) {
    const abiEvent = byName.get(name);
    if (!abiEvent) {
      throw new Error(
        `[gen-config] ${contractName}.${name} 이 커밋된 ABI 에 없다 (${path}). ` +
          'ABI 를 다시 내보냈거나 이름이 바뀌었다면 이 스크립트의 EVENTS 를 고치세요.',
      );
    }
    lines.push(signatureOf(abiEvent));
  }

  const skipped = [];
  for (const name of reserved) {
    const abiEvent = byName.get(name);
    if (abiEvent) lines.push(signatureOf(abiEvent));
    else skipped.push(name);
  }

  // 분류되지 않은 ABI 이벤트는 조용히 빠지는 대신 여기서 멈춘다. 01b 가 이벤트를
  // 더하고 ABI 를 다시 내보내면, 구독할지 버릴지 결정하기 전까지 config 가 안 나온다.
  const classified = new Set([...wanted, ...reserved, ...ignored]);
  const unclassified = [...byName.keys()].filter((name) => !classified.has(name));
  if (unclassified.length > 0) {
    throw new Error(
      `[gen-config] ${contractName} ABI 에 분류되지 않은 이벤트가 있다: ` +
        `${unclassified.join(', ')} (${path}). 이 스크립트의 CONTRACTS 에서 ` +
        'events(구독) / reserved(01b 대기) / ignored(버림) 중 하나에 넣으세요.',
    );
  }
  return { lines, skipped };
}

// 배포 파일 경로. 기본은 contracts/deployments/${chainId}.json; DEPLOYMENT_FILE 로 덮으면 그
// 파일을 읽는다(gen-config 테스트가 금고 유/무 배포를 먹일 때 쓴다).
const deploymentPath = process.env.DEPLOYMENT_FILE
  ? resolve(process.env.DEPLOYMENT_FILE)
  : join(repoRoot, 'contracts', 'deployments', `${chainId}.json`);
const deployment = JSON.parse(await readFile(deploymentPath, 'utf8'));

const contractBlocks = [];
const networkBlocks = [];
const pending = [];
for (const contract of CONTRACTS) {
  const address = deployment[contract.addressKey];
  if (!address) {
    // optional 컨트랙트(= 금고)는 배포 전이면 조용히 건너뛴다. 코어 넷은 반드시 있어야 하므로
    // 없으면 예전처럼 크게 실패한다.
    if (contract.optional) {
      console.log(
        `[gen-config] ${contract.name} 미배포 — 배포 파일에 "${contract.addressKey}" 키가 없어 건너뛴다.`,
      );
      continue;
    }
    throw new Error(`[gen-config] 배포 파일에 "${contract.addressKey}" 키가 없다.`);
  }
  const { abi, path } = await loadContractAbi(contract);
  const { lines, skipped } = eventsOf(
    contract.name,
    abi,
    path,
    contract.events,
    contract.reserved,
    contract.ignored,
  );
  pending.push(...skipped.map((name) => `${contract.name}.${name}`));

  contractBlocks.push(
    [
      `  - name: ${contract.name}`,
      '    handler: src/EventHandlers.ts',
      '    events:',
      ...lines.map((line) => `      - event: ${line}`),
    ].join('\n'),
  );

  // 금고처럼 startBlockKey 가 있는 컨트랙트만 자기 start_block 을 단다. 배포 파일에 그 블록이
  // 있으면 그 값, 없으면 코어 `block` 으로 안전하게 내려간다. 코어 넷은 네트워크 start_block 을
  // 그대로 쓴다(컨트랙트 start_block 없음).
  const networkLines = [
    `      - name: ${contract.name}`,
    '        address:',
    `          - "${address}"`,
  ];
  if (contract.startBlockKey) {
    const contractStart = deployment[contract.startBlockKey] ?? deployment.block;
    networkLines.push(`        start_block: ${contractStart}`);
  }
  networkBlocks.push(networkLines.join('\n'));
}

// RPC 를 주 소스로 쓸 때만 나온다. 없으면 HyperSync 가 소스다.
// 공개 Monad testnet RPC 는 eth_getLogs 를 100블록으로 제한한다(-32614).
// 그 위로 올라가지 못하게 시작 간격과 천장을 둘 다 100으로 묶는다.
const rpcBlock = rpcUrl
  ? `    rpc:
      - url: ${rpcUrl}
        for: sync
        initial_block_interval: 100
        interval_ceiling: 100
`
  : '';

// start_block 규칙은 scripts/start-block.mjs 에 있다: 주소를 유지한 이전 배포만 시작 블록을
// 되돌린다(01c 처럼 Identity·Organizers 를 두고 Ticket 만 교체하는 경우). 전면 재배포는 자기
// 블록에서 시작한다 — 옛 주소는 config 에 없어 스캔되지 않고 그 구간엔 새 주소의 이벤트가 없다.
const { startBlock, kept: keptPrevious } = computeStartBlock(deployment);
console.log(
  keptPrevious.length > 0
    ? `[gen-config] start_block ${startBlock}: 주소를 유지한 이전 배포 ` +
        `${keptPrevious.map((p) => `블록 ${p.block}`).join(', ')} 까지 되돌림`
    : `[gen-config] start_block ${startBlock}: 전면 재배포 — 유지된 계약이 없어 자기 블록에서 시작`,
);

const config = `# 생성 파일. 직접 고치지 말고 scripts/gen-config.mjs 를 고치세요.
# 주소·start_block 은 contracts/deployments/${chainId}.json, 이벤트 시그니처는
# packages/shared/src/abi/*.json 에서 나온다. 갱신은 \`pnpm indexer:config\`.
# 로컬 실행은 RPC_URL=… pnpm indexer:config 로 rpc 소스를 붙여 다시 만든다.
name: monti
description: MONTI on-chain index (Monad ${chainId})
schema: schema.graphql
# \`CheckIn.txHash\` 와 \`Override.id\`(= txHash-logIndex) 가 트랜잭션 해시를 쓴다.
# field_selection 없이는 \`event.transaction\` 이 **빈 객체**라 해시를 읽을 수 없다
# (Envio 기본값). 해시 하나만 고른다 — 고른 필드마다 동기화가 느려진다.
field_selection:
  transaction_fields:
    - hash
contracts:
${contractBlocks.join('\n')}
networks:
  - id: ${deployment.chainId}
    start_block: ${startBlock}
${rpcBlock}    contracts:
${networkBlocks.join('\n')}
`;

await mkdir(outRoot, { recursive: true });
await writeFile(join(outRoot, 'config.yaml'), config, 'utf8');
console.log(
  `[gen-config] chain ${deployment.chainId}, start_block ${startBlock}, ` +
    `source ${rpcUrl ? `rpc ${rpcUrl}` : 'hypersync'}`,
);
if (pending.length > 0) {
  console.log(`[gen-config] 01b 대기 이벤트(ABI 에 아직 없음): ${pending.join(', ')}`);
}

// ─────────────────────────── src/vendored/ ───────────────────────────

/** 생성물 JSON 은 주석을 달 수 없다. 첫 키가 그 자리를 대신한다. */
const DO_NOT_EDIT = (source) =>
  `generated by scripts/gen-config.mjs from ${source}; do not edit`;

const vendorDir = join(outRoot, 'src', 'vendored');
await mkdir(vendorDir, { recursive: true });

async function writeVendored(name, source, payload) {
  const body = { _generated: DO_NOT_EDIT(source), ...payload };
  await writeFile(join(vendorDir, name), `${JSON.stringify(body, null, 2)}\n`, 'utf8');
}

// 1. Ticket ABI — 핸들러는 `eventMeta`·`tiers` 만 읽지만, 조각을 골라 담으면 01b 가
//    튜플을 바꿀 때 무엇을 다시 골라야 하는지가 숨는다. 통째로 복제하는 쪽이 싸다.
const ticketAbiSource = 'packages/shared/src/abi/Ticket.json';
const ticketAbi = JSON.parse(
  await readFile(join(repoRoot, 'packages', 'shared', 'src', 'abi', 'Ticket.json'), 'utf8'),
);
await writeVendored('ticket-abi.json', ticketAbiSource, { abi: ticketAbi });

// 2. 배포 파일 — config.yaml 의 주소·start_block 과 **같은 파일**에서 나온다.
//    핸들러는 `ticket` 만 쓰지만 체인 확인(`chainId`)과 감사 목적으로 전부 싣는다.
await writeVendored('deployment.json', `contracts/deployments/${chainId}.json`, { deployment });

// 3. EVENT_STATUS_BY_CODE — `packages/shared/src/types.ts` 의 한 줄에서 뽑는다.
//    모양이 바뀌면 조용히 빈 배열을 내는 대신 여기서 던진다.
const typesSource = 'packages/shared/src/types.ts';
const typesText = await readFile(
  join(repoRoot, 'packages', 'shared', 'src', 'types.ts'),
  'utf8',
);
const statusMatch = typesText.match(/export const EVENT_STATUS_BY_CODE = \[([\s\S]*?)\] as const;/);
if (!statusMatch) {
  throw new Error(
    `[gen-config] ${typesSource} 에서 EVENT_STATUS_BY_CODE 선언을 찾지 못했다. ` +
      '선언 모양이 바뀌었다면 이 스크립트의 정규식을 고치세요.',
  );
}
const byCode = statusMatch[1]
  .split(',')
  .map((part) => part.trim())
  .filter(Boolean)
  .map((part) => {
    const quoted = part.match(/^'([^']*)'$|^"([^"]*)"$/);
    if (!quoted) {
      throw new Error(`[gen-config] EVENT_STATUS_BY_CODE 원소를 읽지 못했다: ${part}`);
    }
    return quoted[1] ?? quoted[2];
  });
if (byCode.length === 0) {
  throw new Error(`[gen-config] ${typesSource} 의 EVENT_STATUS_BY_CODE 가 비어 있다.`);
}
await writeVendored('event-status.json', typesSource, { byCode });

console.log(
  `[gen-config] vendored ${byCode.length} status codes, ${ticketAbi.length} Ticket ABI items, ` +
    `deployment ${deployment.ticket}`,
);
