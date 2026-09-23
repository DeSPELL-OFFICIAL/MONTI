import { describe, expect, it } from 'vitest';
import {
  coinbaseFactoryAbi,
  identityAbi,
  montiPaymasterAbi,
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
        // 01b: the rotation undo (C3). `rotatedFrom` is the flag, `rotatedAt` only the timestamp.
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
        // 01b: the offline flush, the two digests clients must agree with, and the two windows.
        'checkInLate', 'offerDigest', 'eip712Domain', 'deviceDigest', 'LATE_WINDOW', 'MIGRATE_DELAY', 'migrate']),
    );
    expect(names(ticketAbi, 'event')).toEqual(
      expect.arrayContaining(['EventCreated', 'EventStatusChanged', 'Claimed', 'Transfer', 'CheckedIn',
        'OverrideRequested', 'ManualOverride', 'Revoked', 'Migrated',
        'OfferCreated', 'OfferCancelled', 'OfferAccepted',
        // 01b: emitted *alongside* CheckedIn on the late path — never instead of it.
        'CheckedInLate']),
    );
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

describe('MontiPaymaster ABI', () => {
  /**
   * 01b made the sponsored-selector table writable after deployment. The kill switch and the two
   * views that read it back are what an operator uses to take a selector off sponsorship without a
   * redeploy, so they belong in the same net as everything else the app calls.
   */
  it('carries the per-selector allow list the 01b kill switch reads and writes', () => {
    expect(names(montiPaymasterAbi, 'function')).toEqual(
      expect.arrayContaining(['setAllowed', 'argWordOf', 'argKindOf', 'allowedSelector']),
    );
    expect(names(montiPaymasterAbi, 'event')).toEqual(expect.arrayContaining(['SelectorAllowed']));
  });
});

describe('other ABIs', () => {
  it('exposes the paymaster budget calls and the Coinbase factory getAddress', () => {
    expect(names(montiPaymasterAbi, 'function')).toEqual(expect.arrayContaining(['depositPlatform', 'budgetOf']));
    expect(names(coinbaseFactoryAbi, 'function')).toEqual(expect.arrayContaining(['getAddress', 'createAccount']));
  });
});
