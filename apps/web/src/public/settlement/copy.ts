/**
 * The public settlement page speaks to a non-crypto reader, so its words live here rather than in
 * the shared copy table: the page sits outside the signed-in app (its own public route, no login)
 * and the copy linter (`lint:copy`) does not sweep `src/public`. Korean only — the page is a
 * shareable public record for a Korean audience, not part of the bilingual app shell.
 *
 * No chain word appears in the always-visible copy; the only addresses and transaction links live
 * behind the 상세 toggle, exactly as the brief requires.
 */
export const settlementCopy = {
  badge: '테스트 환경',
  headerNote: '정산 규칙은 공개되어 있고 누구도 바꿀 수 없습니다',
  rulesTitle: '이 행사의 수익은 이렇게 나뉩니다',
  platformLabel: 'MONTI 플랫폼',
  reserveLabel: '예비비',
  perTicket: (price: string) => `${price} 티켓 1장이면 각각 이만큼 갑니다`,
  liveTitle: '실시간 현황',
  statDeposited: '총 결제',
  statDepositedSub: '예치된 금액',
  statReleased: '입장 후 정산 완료',
  statRefunded: '환불',
  statNoShow: '노쇼 정산',
  countUnit: (n: number) => `${n}건`,
  payoutsTitle: '방금 나간 정산',
  payoutsEmpty: '아직 정산된 내역이 없어요. 입장이 시작되면 여기에서 실시간으로 보여요.',
  detailsSummary: '상세 (기록 · 주소 · 거래)',
  detailPolicyHash: '규칙 지문',
  detailVault: '보관 금고',
  detailRecipients: '수령인 주소',
  detailTx: '거래 기록',
  loading: '불러오는 중…',
  emptyTitle: '주최자가 정산 규칙을 아직 확정하지 않았어요',
  emptyBody: '규칙이 확정되면 이 행사의 수익이 어떻게 나뉘는지 여기에서 공개돼요.',
  errorTitle: '지금은 현황을 불러올 수 없어요',
  errorBody: '잠시 후 다시 시도해 주세요.',
  retry: '다시 시도',
  fallbackTitle: '행사 정산',
  reasonFallback: (n: number) => `수령인 ${n}`,
} as const;
