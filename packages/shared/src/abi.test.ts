import { describe, expect, it } from 'vitest';
import {
  forwarderAbi,
  identityAbi,
  organizersAbi,
  ticketAbi,
} from './abi.js';

type AbiComponent = { name?: string; type?: string; components?: AbiComponent[] };
type AbiItem = {
  type: string;
  name?: string;
  inputs?: Array<{ name?: string; indexed?: boolean }>;
  outputs?: AbiComponent[];
};

function names(abi: readonly unknown[], type: string): string[] {
  return (abi as AbiItem[]).filter((i) => i.type === type && i.name).map((i) => i.name as string);
}

function fn(abi: readonly unknown[], name: string): AbiItem | undefined {
  return (abi as AbiItem[]).find((i) => i.type === 'function' && i.name === name);
}

function event(abi: readonly unknown[], name: string): AbiItem {
  const found = (abi as AbiItem[]).find((i) => i.type === 'event' && i.name === name);
  if (!found) throw new Error(`event ${name} missing`);
  return found;
}

describe('Identity ABI', () => {
  it('carries every call and event the backend and indexer use', () => {
    expect(names(identityAbi, 'function')).toEqual(
      expect.arrayContaining([
        'register', 'rotateAccount', 'setActiveDevice', 'lockDevice', 'setKycLevel', 'setNickname',
        'accountOf', 'personOf', 'isMember', 'activeDevice', 'isLocked', 'deviceUpdatedAt',
        'kycLevelOf', 'nicknameOwner', 'nicknameOf', 'attester',
        // 01b: 회전 되돌리기(C3)
        'cancelRotation', 'rotatedAt', 'rotatedFrom', 'ROTATION_UNDO_WINDOW',
      ]),
    );
    expect(names(identityAbi, 'event')).toEqual(
      expect.arrayContaining(['Registered', 'AccountRotated', 'DeviceChanged', 'DeviceLocked', 'NicknameSet', 'KycLevelSet',
        'RotationCancelled']),
    );
  });

  it('declares register with the kycLevel argument', () => {
    const register = fn(identityAbi, 'register');
    expect(register?.inputs?.map((i) => i.name)).toEqual(['personId', 'account', 'deviceX', 'deviceY', 'kycLevel']);
  });
});

describe('Organizers ABI', () => {
  it('carries every call and event the backend and indexer use', () => {
    expect(names(organizersAbi, 'function')).toEqual(
      expect.arrayContaining(['createOrganizer', 'setAdmin', 'setManager', 'registerGate', 'openGate', 'closeGate',
        'ownerOf', 'hasPermission', 'managerOf', 'gateOf', 'gateInfo', 'isOpenGate']),
    );
    expect(names(organizersAbi, 'event')).toEqual(
      expect.arrayContaining(['OrganizerCreated', 'AdminSet', 'ManagerSet', 'OwnerTransferred',
        'GateRegistered', 'GateRevoked', 'GateOpened', 'GateClosed']),
    );
  });
});

describe('Ticket ABI', () => {
  it('carries every call the backend uses, including the ones added late', () => {
    expect(names(ticketAbi, 'function')).toEqual(
      expect.arrayContaining(['ownerOf', 'balanceOf', 'eventOf', 'tierOf', 'eventOrg', 'checkInOf',
        'balanceOfEvent', 'eventMeta', 'eventStatus', 'tiers', 'createOffer', 'cancelOffer', 'acceptOffer', 'offerOf',
        // 01b: 오프라인 큐 flush, EIP-712 오퍼 다이제스트, 7워드 기기 다이제스트, 두 상수, 계정 회전 이관
        'checkInForLate', 'offerDigest', 'eip712Domain', 'deviceDigest', 'LATE_WINDOW', 'MIGRATE_DELAY', 'migrate']),
    );
    expect(names(ticketAbi, 'event')).toEqual(
      expect.arrayContaining(['EventCreated', 'EventStatusChanged', 'Claimed', 'Transfer', 'CheckedIn',
        'OverrideRequested', 'ManualOverride', 'Revoked', 'Migrated',
        'OfferCreated', 'OfferCancelled', 'OfferAccepted',
        // 01b: 늦은 체크인은 CheckedIn 에 더해서 나온다 — 입장 수를 셀 때 두 번 세면 안 된다.
        'CheckedInLate']),
    );
  });

  // abi-delta-01b §5. 같은 셀렉터, 두 번 바뀐 튜플. nonceHash 가 ts 앞으로 옮겨 가
  // ts+manual+late 가 한 슬롯을 쓴다. Solidity 는 필드 이름으로 읽어 눈치채지 못했지만
  // viem 과 Envio 는 위치로 디코드한다 — 이 순서가 틀리면 조용히 잘못 읽는다.
  it('pins the checkInOf return tuple component order', () => {
    const checkInOf = fn(ticketAbi, 'checkInOf');
    expect(checkInOf?.outputs?.[0]?.type).toBe('tuple');
    expect(checkInOf?.outputs?.[0]?.components?.map((c) => c.name)).toEqual([
      'gateId',
      'nonceHash',
      'ts',
      'manual',
      'late',
    ]);
  });

  it('matches sub-plan 01 offer event signatures exactly', () => {
    // OfferCreated(uint256 indexed tokenId, address indexed from, bytes32 recipientCommitment, uint64 expiresAt)
    const created = event(ticketAbi, 'OfferCreated');
    expect(created.inputs?.map((i) => [i.name, i.indexed])).toEqual([
      ['tokenId', true],
      ['from', true],
      ['recipientCommitment', false],
      ['expiresAt', false],
    ]);

    // OfferAccepted(uint256 indexed tokenId, address indexed from, address indexed to)
    const accepted = event(ticketAbi, 'OfferAccepted');
    expect(accepted.inputs?.map((i) => [i.name, i.indexed])).toEqual([
      ['tokenId', true],
      ['from', true],
      ['to', true],
    ]);
  });

  /**
   * 01b reordered `checkInOf`'s return tuple and kept the selector (`0xdb7b7d7e`). Solidity reads
   * the struct by field name and never noticed; viem and Envio decode **positionally**. This is
   * the one change in the bundle no compiler anywhere can catch, so it is pinned exactly — not
   * with arrayContaining, which would pass on the old order just as happily.
   */
  it('returns checkInOf as exactly gateId, nonceHash, ts, manual, late — in that order', () => {
    const checkInOf = fn(ticketAbi, 'checkInOf');
    expect(checkInOf?.outputs).toHaveLength(1);
    expect(checkInOf?.outputs?.[0]?.components?.map((c) => c.name)).toEqual([
      'gateId',
      'nonceHash',
      'ts',
      'manual',
      'late',
    ]);
  });

  /** CheckedInLate(uint256 indexed tokenId, uint256 indexed gateId, uint64 issuedAt, uint64 ts). */
  it('declares CheckedInLate with exactly its four fields and their indexed flags', () => {
    const late = event(ticketAbi, 'CheckedInLate');
    expect(late.inputs?.map((i) => i.name)).toEqual(['tokenId', 'gateId', 'issuedAt', 'ts']);
    expect(late.inputs?.map((i) => i.indexed)).toEqual([true, true, false, false]);
  });
});

describe('MontiForwarder ABI', () => {
  it('carries execute/nonces/forwardDigest and every custom error relayAction maps', () => {
    expect(names(forwarderAbi, 'function')).toEqual(
      expect.arrayContaining(['execute', 'nonces', 'forwardDigest']),
    );
    expect(names(forwarderAbi, 'event')).toEqual(expect.arrayContaining(['Forwarded']));
    expect(names(forwarderAbi, 'error')).toEqual(
      expect.arrayContaining([
        'TargetNotAllowed',
        'Expired',
        'BadNonce',
        'NotMember',
        'DeviceLocked',
        'BadDeviceSignature',
      ]),
    );
  });

  /**
   * The hand-signed shim declared Forwarded with three fields; the deployed event has four
   * (a trailing `selector`), so the shim's topic hash never matched a real log. The generated ABI
   * pins the four-field shape parseEventLogs decodes against.
   */
  it('declares Forwarded with from, to, nonce, selector — in that order', () => {
    const forwarded = event(forwarderAbi, 'Forwarded');
    expect(forwarded.inputs?.map((i) => i.name)).toEqual(['from', 'to', 'nonce', 'selector']);
    expect(forwarded.inputs?.map((i) => i.indexed)).toEqual([true, true, false, false]);
  });
});
