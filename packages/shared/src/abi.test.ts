import { describe, expect, it } from 'vitest';
import {
  coinbaseFactoryAbi,
  identityAbi,
  montiPaymasterAbi,
  organizersAbi,
  ticketAbi,
} from './abi.js';

type AbiItem = { type: string; name?: string; inputs?: Array<{ name?: string; indexed?: boolean }> };

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
      ]),
    );
    expect(names(identityAbi, 'event')).toEqual(
      expect.arrayContaining(['Registered', 'AccountRotated', 'DeviceChanged', 'DeviceLocked', 'NicknameSet', 'KycLevelSet']),
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
        'balanceOfEvent', 'eventMeta', 'eventStatus', 'tiers', 'createOffer', 'cancelOffer', 'acceptOffer', 'offerOf']),
    );
    expect(names(ticketAbi, 'event')).toEqual(
      expect.arrayContaining(['EventCreated', 'EventStatusChanged', 'Claimed', 'Transfer', 'CheckedIn',
        'OverrideRequested', 'ManualOverride', 'Revoked', 'Migrated',
        'OfferCreated', 'OfferCancelled', 'OfferAccepted']),
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
});

describe('other ABIs', () => {
  it('exposes the paymaster budget calls and the Coinbase factory getAddress', () => {
    expect(names(montiPaymasterAbi, 'function')).toEqual(expect.arrayContaining(['depositPlatform', 'budgetOf']));
    expect(names(coinbaseFactoryAbi, 'function')).toEqual(expect.arrayContaining(['getAddress', 'createAccount']));
  });
});
