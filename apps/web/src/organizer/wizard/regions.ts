/**
 * ISO-3166-2:KR. `EventMeta.regionCode` is `keccak256(<code>)` on chain, never the label, so
 * the codes below are what the wizard hashes and `attendee/discover/useEvents.ts` hashes back
 * to filter on. A code that is not in this list would hash to something no filter can produce,
 * which is why `validateDraft` refuses one.
 */
export const KR_REGIONS: ReadonlyArray<{ code: string; labelKo: string; labelEn: string }> = [
  { code: 'KR-11', labelKo: '서울', labelEn: 'Seoul' },
  { code: 'KR-26', labelKo: '부산', labelEn: 'Busan' },
  { code: 'KR-27', labelKo: '대구', labelEn: 'Daegu' },
  { code: 'KR-28', labelKo: '인천', labelEn: 'Incheon' },
  { code: 'KR-29', labelKo: '광주', labelEn: 'Gwangju' },
  { code: 'KR-30', labelKo: '대전', labelEn: 'Daejeon' },
  { code: 'KR-31', labelKo: '울산', labelEn: 'Ulsan' },
  { code: 'KR-50', labelKo: '세종', labelEn: 'Sejong' },
  { code: 'KR-41', labelKo: '경기', labelEn: 'Gyeonggi' },
  { code: 'KR-42', labelKo: '강원', labelEn: 'Gangwon' },
  { code: 'KR-43', labelKo: '충북', labelEn: 'North Chungcheong' },
  { code: 'KR-44', labelKo: '충남', labelEn: 'South Chungcheong' },
  { code: 'KR-45', labelKo: '전북', labelEn: 'North Jeolla' },
  { code: 'KR-46', labelKo: '전남', labelEn: 'South Jeolla' },
  { code: 'KR-47', labelKo: '경북', labelEn: 'North Gyeongsang' },
  { code: 'KR-48', labelKo: '경남', labelEn: 'South Gyeongsang' },
  { code: 'KR-49', labelKo: '제주', labelEn: 'Jeju' },
];

export const REGION_CODES: ReadonlySet<string> = new Set(KR_REGIONS.map((region) => region.code));
