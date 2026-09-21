/**
 * NFC 쓰기가 불가능한 기기(아이폰 브라우저 접속자)를 위한 QR 폴백 문자열의 접두사.
 * `GateResponseWire` CBOR를 base64url로 실어 `MONTI1:<body>` 형태로 만든다.
 */
export const QR_PREFIX = 'MONTI1:';

/**
 * 관객 화면 카피에 등장하면 안 되는 금지어 목록(스펙 §3.2).
 * 매칭 규칙은 `copy-lint.ts`가 결정한다:
 * - 한글 낱말은 부분 문자열로 매칭한다.
 * - 영어 낱말은 단어 경계(`\bword\b`)로 매칭해 `tokenId`·`gasLimit`·`chainId` 같은 식별자를 흘려보낸다.
 * - `NFT`만 예외로, ASCII지만 부분 문자열로(대소문자 무시) 매칭한다.
 * 모든 매칭은 대소문자를 무시한다.
 */
export const BANNED_ATTENDEE_WORDS: readonly string[] = [
  '지갑',
  'NFT',
  '민팅',
  '가스',
  '체인',
  '토큰',
  '트랜잭션',
  'wallet',
  'mint',
  'gas',
  'chain',
  'token',
  'transaction',
  'blockchain',
  'monad',
];
