/**
 * base32 CIDv1 59자. `bafy`(dag-pb) 또는 `bafk`(raw leaf — Pinata v3 가 작은 파일에 주는 것)로
 * 시작한다. 씨앗 스크립트(`contracts/script/Seed.s.sol`)가 체인에 넣기 전에 요구하는 모양과 같다 —
 * CIDv0(`Qm…`)를 그대로 흘려보내면 나중에 `createEvent` 가 이유 없이 거절당한다.
 *
 * **한 곳에만 둔다.** 핀하는 쪽(`organizer.ts`)과 CID 를 받아 저장하는 쪽(`eventArt.ts`)이
 * 각자 정규식을 들고 있으면, 한쪽만 고쳐진 날 저장은 통과하고 화면에서만 깨진다.
 */
export const CID_RE = /^baf[ky][a-z2-7]{55}$/;
