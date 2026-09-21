/**
 * NFC 쓰기가 불가능한 기기(아이폰 브라우저 접속자)를 위한 QR 폴백 문자열의 접두사.
 * `GateResponseWire` CBOR를 base64url로 실어 `MONTI1:<body>` 형태로 만든다.
 */
export const QR_PREFIX = 'MONTI1:';
