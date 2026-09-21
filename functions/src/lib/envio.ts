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
 * Hasura 커서 페이지네이션. id 오름차순으로 끝까지 읽는다.
 * Hasura 는 역할마다 행 수 상한이 있으므로 한 번에 다 왔다고 믿지 않는다 —
 * 마지막 쪽이 `pageSize` 보다 짧을 때만 끝이다.
 */
export async function envioPage<T extends { id: string }>(
  entity: string,
  fields: string,
  pageSize = 500,
): Promise<T[]> {
  const out: T[] = [];
  let cursor = '';
  for (;;) {
    const query = `query Page($cursor: String!, $limit: Int!) {
      rows: ${entity}(where: {id: {_gt: $cursor}}, order_by: {id: asc}, limit: $limit) { ${fields} }
    }`;
    const data = await envioQuery<{ rows: T[] }>(query, { cursor, limit: pageSize });
    out.push(...data.rows);
    if (data.rows.length < pageSize) return out;
    cursor = data.rows[data.rows.length - 1]!.id;
  }
}
