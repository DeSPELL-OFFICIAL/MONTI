import { BigQuery } from '@google-cloud/bigquery';
import { Storage } from '@google-cloud/storage';
import { error, info } from 'firebase-functions/logger';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { BIGQUERY_DATASET, EXPORT_BUCKET } from '../config.js';
import { envioPage } from '../lib/envio.js';

/** 매일 03:00 Asia/Seoul. 자정 직후가 아니라 세 시인 이유는 인덱서가 전날 마지막 블록까지 따라잡을 시간을 주기 위해서다. */
const SCHEDULE = '0 3 * * *';
const TIME_ZONE = 'Asia/Seoul';

/**
 * 내보낼 Envio 엔티티와 그 **스칼라** 필드. 이름과 필드는 `indexer/schema.graphql`(Task 34)의
 * 타입 정의를 그대로 따른다 — 여기가 어긋나면 Hasura 가 필드 하나 때문에 질의 전체를 거절한다.
 * `Ticket.checkIn`·`Ticket.identity` 같은 관계 필드는 다른 테이블의 사본이므로 넣지 않는다.
 */
export const EXPORT_ENTITIES = [
  { entity: 'Organizer', fields: 'id owner' },
  { entity: 'Admin', fields: 'id orgId account bits' },
  { entity: 'Manager', fields: 'id orgId account exists canApprove' },
  { entity: 'Gate', fields: 'id eventId account kx ky isOpen revoked' },
  {
    entity: 'Event',
    fields:
      'id orgId creator titleHash descHash imageCid startsAt endsAt venueHash saleStart saleEnd transferable transferCutoffSeconds maxTransfers approvalRequired category regionCode status requireKyc',
  },
  { entity: 'Tier', fields: 'id eventId idx name priceUsdCents supply minted maxPerWallet seated' },
  { entity: 'Ticket', fields: 'id eventId tier owner transfers revoked' },
  {
    entity: 'ClaimRequest',
    fields: 'id eventId requestId requester tier status tokenId requestedAt decidedAt txHash',
  },
  { entity: 'CheckIn', fields: 'id gateId ts nonceHash manual late txHash block' },
  { entity: 'Override', fields: 'id tokenId gateId approver role reason requested' },
  {
    entity: 'IdentityAccount',
    fields: 'id personId nickname kycLevel deviceX deviceY locked deviceUpdatedAt',
  },
  { entity: 'Offer', fields: 'id from commitment expiresAt status' },
] as const;

/**
 * BigQuery 로드 잡 설정. 파일 하나가 그날의 테이블 전체이므로 **덮어쓴다**(`WRITE_TRUNCATE`) —
 * append 로 두면 하루 돌 때마다 같은 행이 쌓여 어제 것과 오늘 것을 구분할 수 없게 된다.
 */
const LOAD_OPTIONS = {
  sourceFormat: 'NEWLINE_DELIMITED_JSON',
  autodetect: true,
  writeDisposition: 'WRITE_TRUNCATE',
} as const;

/**
 * `BigInt!` 컬럼은 Hasura 가 문자열로 주지만, 클라이언트 쪽에서 bigint 로 바뀐 값이 섞여 들어오면
 * `JSON.stringify` 가 TypeError 로 통째로 터진다. 십진 문자열로 낮춘다 — number 로 낮추면
 * 2^53 위의 tokenId 가 조용히 깨진다.
 */
function bigintSafe(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

/** 줄당 객체 하나, 마지막 줄에도 개행. 빈 배열은 빈 문자열이다(개행 하나짜리 파일이 아니다). */
export function toJsonl(rows: readonly unknown[]): string {
  return rows.map((row) => `${JSON.stringify(row, bigintSafe)}\n`).join('');
}

/**
 * 실행 시각이 속한 **서울 달력 날짜**(`YYYY-MM-DD`). UTC 로 계산하면 03:00 KST 실행이
 * 전날 폴더에 떨어진다(KST 자정~09:00 은 UTC 로 아직 전날이다).
 */
export function seoulDate(now: Date = new Date()): string {
  return now.toLocaleDateString('en-CA', { timeZone: TIME_ZONE });
}

/**
 * 하루 한 번 인덱서 테이블을 통째로 내려받아 `gs://{EXPORT_BUCKET}/{YYYY-MM-DD}/{entity}.jsonl`
 * 로 쓰고, 엔티티마다 BigQuery 로드 잡을 건다(스펙 §10.4 "하루 한 번 인덱서 테이블 백업").
 *
 * **절대 던지지 않는다.** 인덱서가 안 떠 있을 수도, 버킷이 아직 없을 수도 있다. 여기서 던지면
 * Cloud Scheduler 가 같은 실행을 재시도해 이미 올라간 파일을 다시 쓴다. 엔티티는 서로 독립이므로
 * 하나가 터져도 그 이름만 남기고 다음으로 간다 — 백업 하나를 못 떠서 나머지 열 개를 버리지 않는다.
 */
export const dailyExport = onSchedule(
  { schedule: SCHEDULE, timeZone: TIME_ZONE, timeoutSeconds: 540, memory: '1GiB' },
  async () => {
    const date = seoulDate();
    const bucketName = EXPORT_BUCKET.value();
    const dataset = BIGQUERY_DATASET.value();
    const storage = new Storage();
    const bigquery = new BigQuery();

    let exported = 0;
    let loaded = 0;

    for (const { entity, fields } of EXPORT_ENTITIES) {
      try {
        const rows = await envioPage<{ id: string }>(entity, fields);
        const path = `${date}/${entity}.jsonl`;
        const file = storage.bucket(bucketName).file(path);
        await file.save(toJsonl(rows), { contentType: 'application/x-ndjson' });
        exported += 1;

        // 빈 파일은 올려 두되 로드는 걸지 않는다. `autodetect` 는 볼 행이 없으면
        // 스키마를 못 만들어 잡 자체가 실패하고, 기존 테이블만 날아간다.
        if (rows.length === 0) {
          info('dailyExport.empty', { entity, date, path });
          continue;
        }

        const [job] = await bigquery.dataset(dataset).table(entity).load(file, LOAD_OPTIONS);
        loaded += 1;
        info('dailyExport.loaded', {
          entity,
          date,
          rows: rows.length,
          table: `${dataset}.${entity}`,
          jobState: job.status?.state,
        });
      } catch (cause) {
        error('dailyExport.entity', { entity, date, reason: (cause as Error).message });
      }
    }

    // 하나도 못 뜬 날은 정상 종료로 남긴다 — 인덱서가 아직 안 떠 있는 동안의 기본 상태다.
    if (exported === 0) error('dailyExport.none', { date, entities: EXPORT_ENTITIES.length });
    else info('dailyExport.done', { date, exported, loaded, entities: EXPORT_ENTITIES.length });
  },
);
