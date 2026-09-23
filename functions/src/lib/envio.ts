import { ENVIO_GRAPHQL_URL } from '../config.js';

/**
 * Envio(HyperIndex) 의 Hasura 엔드포인트에 GraphQL 한 번.
 *
 * **변수 타입 주의:** `schema.graphql` 의 `BigInt!` 컬럼은 Hasura 에서 `numeric` 으로 나온다.
 * `eventId` 같은 값을 `String!` 로 선언하면 Hasura 가 타입 불일치로 거절한다.
 * 값 자체는 정밀도를 잃지 않도록 **문자열로** 보낸다(자바스크립트 number 는 2^53 에서 깨진다).
 */
export async function envioQuery<T>(
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const response = await fetch(ENVIO_GRAPHQL_URL.value(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) throw new Error(`ENVIO_HTTP_${response.status}`);
  const body = (await response.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (body.errors?.length) throw new Error(`ENVIO_GRAPHQL:${body.errors[0]!.message}`);
  if (!body.data) throw new Error('ENVIO_EMPTY');
  return body.data;
}

/**
 * 커서 쪽마다 붙는 서버 쪽 필터.
 *
 * 걸러내기는 인덱서에 맡긴다 — 공연 하나를 보려고 전 공연의 티켓을 끌어오면 쪽 수가 터진다.
 */
export interface EnvioFilter {
  /** 추가 변수 선언. 예: `'$eventId: numeric!'` */
  vars: string;
  /** `id` 커서 앞에 놓일 where 절. 예: `'eventId: {_eq: $eventId}, revoked: {_eq: false}'` */
  where: string;
  /** 위 선언에 실을 값. */
  values: Record<string, unknown>;
}

/**
 * 한 쪽을 읽는 질의문과 변수. 전송을 타지 않는 순수 함수다 —
 * 커서·필터 규약이 네트워크 없이도, 전송을 가짜로 바꾼 자리에서도 그대로 검증된다.
 */
export function envioPageQuery(
  entity: string,
  fields: string,
  cursor: string,
  limit: number,
  filter?: EnvioFilter,
): { query: string; variables: Record<string, unknown> } {
  const vars = filter ? `, ${filter.vars}` : '';
  const where = filter ? `${filter.where}, ` : '';
  return {
    query: `query Page($cursor: String!, $limit: Int!${vars}) {
      rows: ${entity}(where: {${where}id: {_gt: $cursor}}, order_by: {id: asc}, limit: $limit) { ${fields} }
    }`,
    variables: { cursor, limit, ...(filter?.values ?? {}) },
  };
}

/** 커서 한 쪽. 쪽마다 멈춰 판단해야 하는 호출자(스냅샷 상한 검사)가 쓴다. */
export async function envioPageOnce<T extends { id: string }>(
  entity: string,
  fields: string,
  cursor: string,
  limit: number,
  filter?: EnvioFilter,
): Promise<T[]> {
  const { query, variables } = envioPageQuery(entity, fields, cursor, limit, filter);
  const data = await envioQuery<{ rows: T[] }>(query, variables);
  return data.rows;
}

/**
 * id 오름차순 커서 드레인. 한 쪽 읽는 방법만 받는다.
 * Hasura 는 역할마다 행 수 상한이 있으므로 한 번에 다 왔다고 믿지 않는다 —
 * 마지막 쪽이 `pageSize` 보다 짧을 때만 끝이다.
 */
export async function envioDrain<T extends { id: string }>(
  pageSize: number,
  readPage: (cursor: string) => Promise<T[]>,
): Promise<T[]> {
  const out: T[] = [];
  let cursor = '';
  for (;;) {
    const rows = await readPage(cursor);
    out.push(...rows);
    if (rows.length < pageSize) return out;
    cursor = rows[rows.length - 1]!.id;
  }
}

/** 끝까지 드레인. `envioDrain` + `envioPageOnce` 의 조합이다. */
export async function envioPage<T extends { id: string }>(
  entity: string,
  fields: string,
  pageSize = 500,
  filter?: EnvioFilter,
): Promise<T[]> {
  return envioDrain<T>(pageSize, (cursor) =>
    envioPageOnce<T>(entity, fields, cursor, pageSize, filter),
  );
}
