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
 * RPC_URL 을 주면 그 RPC 를 **주 데이터 소스**로 적는다. 로컬 실행용이다 —
 * Monad testnet 의 HyperSync 는 API 토큰 없이는 0/0 으로 막힌다
 * (`rate limited by server (remaining=0/0)`). 호스티드(Task 38)는 토큰이 있으므로
 * 커밋되는 config.yaml 은 RPC_URL 없이 만든 HyperSync 판이다.
 *
 * 구독 목록은 아래 EVENTS 가 정한다(ABI 전체가 아니다 — `Approval`·`ApprovalForAll`
 * 처럼 엔티티가 없는 ERC-721 잡음은 인덱싱하지 않는다). RESERVED 는 01b 번들이
 * 더할 이벤트로, ABI 에 아직 없으면 조용히 건너뛰고 ABI 재내보내기(01b Task 13)
 * 뒤에는 이 파일을 고치지 않아도 config 에 들어온다.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
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
      'DeviceChanged',
      'DeviceLocked',
      'NicknameSet',
      'KycLevelSet',
    ],
    // 01b C3: 회전 되돌리기. AccountRotated 도 함께 나므로 "현재 계정" 로직은
    // 그대로고, 이것은 감사 로그용이다.
    reserved: ['RotationCancelled'],
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
  },
  {
    name: 'Ticket',
    addressKey: 'ticket',
    events: [
      'EventCreated',
      'EventStatusChanged',
      'EventMetaUpdated',
      'Claimed',
      'Transfer',
      'CheckedIn',
      'OverrideRequested',
      'ManualOverride',
      'Revoked',
      'Migrated',
      'OfferCreated',
      'OfferCancelled',
      'OfferAccepted',
    ],
    // 01b C1: 오프라인 큐 기록. CheckedIn 과 같은 트랜잭션에 함께 온다 —
    // 입장 수는 CheckedIn 으로 세고, 이것으로 CheckIn.late 를 true 로 올린다.
    reserved: ['CheckedInLate'],
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

async function eventsOf(contractName, wanted, reserved) {
  const path = join(repoRoot, 'packages', 'shared', 'src', 'abi', `${contractName}.json`);
  const abi = JSON.parse(await readFile(path, 'utf8'));
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
  return { lines, skipped };
}

const deployment = JSON.parse(
  await readFile(join(repoRoot, 'contracts', 'deployments', `${chainId}.json`), 'utf8'),
);

const contractBlocks = [];
const networkBlocks = [];
const pending = [];
for (const contract of CONTRACTS) {
  const address = deployment[contract.addressKey];
  if (!address) {
    throw new Error(`[gen-config] 배포 파일에 "${contract.addressKey}" 키가 없다.`);
  }
  const { lines, skipped } = await eventsOf(contract.name, contract.events, contract.reserved);
  pending.push(...skipped.map((name) => `${contract.name}.${name}`));

  contractBlocks.push(
    [
      `  - name: ${contract.name}`,
      '    handler: src/EventHandlers.ts',
      '    events:',
      ...lines.map((line) => `      - event: ${line}`),
    ].join('\n'),
  );
  networkBlocks.push(
    [`      - name: ${contract.name}`, '        address:', `          - "${address}"`].join('\n'),
  );
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

const config = `# 생성 파일. 직접 고치지 말고 scripts/gen-config.mjs 를 고치세요.
# 주소·start_block 은 contracts/deployments/${chainId}.json, 이벤트 시그니처는
# packages/shared/src/abi/*.json 에서 나온다. 갱신은 \`pnpm indexer:config\`.
# 로컬 실행은 RPC_URL=… pnpm indexer:config 로 rpc 소스를 붙여 다시 만든다.
name: monti
description: MONTI on-chain index (Monad ${chainId})
schema: schema.graphql
contracts:
${contractBlocks.join('\n')}
networks:
  - id: ${deployment.chainId}
    start_block: ${deployment.block}
${rpcBlock}    contracts:
${networkBlocks.join('\n')}
`;

await writeFile(join(here, '..', 'config.yaml'), config, 'utf8');
console.log(
  `[gen-config] chain ${deployment.chainId}, start_block ${deployment.block}, ` +
    `source ${rpcUrl ? `rpc ${rpcUrl}` : 'hypersync'}`,
);
if (pending.length > 0) {
  console.log(`[gen-config] 01b 대기 이벤트(ABI 에 아직 없음): ${pending.join(', ')}`);
}
