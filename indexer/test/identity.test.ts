import { describe, expect, it } from 'vitest';
import { TestHelpers } from 'generated';

const { Identity, Organizers, MockDb } = TestHelpers;
type MockDbT = ReturnType<typeof MockDb.createMockDb>;

// 체크섬 대문자가 섞인 주소를 일부러 쓴다. 인덱서가 저장하는 주소 id·필드는 전부
// 소문자여야 한다(Functions 쪽 질의도 소문자다) — 아래 단언들이 그걸 잡는다.
const ALICE = `0x${'Aa'.repeat(20)}`;
const alice = ALICE.toLowerCase();
const BOB = `0x${'Bb'.repeat(20)}`;
const bob = BOB.toLowerCase();
const GATE = `0x${'Cc'.repeat(20)}`;
const gateAddr = GATE.toLowerCase();

const PERSON = `0x${'aa'.repeat(32)}`;
const ZERO32 = `0x${'00'.repeat(32)}`;
const DEVICE_X = `0x${'11'.repeat(32)}`;
const DEVICE_Y = `0x${'22'.repeat(32)}`;
const NICK_HASH = `0x${'bb'.repeat(32)}`;

const T0 = 1_760_000_000;
const T1 = T0 + 86_400;

const block = (timestamp: number) => ({ block: { timestamp } });

/** Identity.register(…) 는 한 트랜잭션에서 Registered + DeviceChanged + KycLevelSet 를 낸다. */
async function signedUp(): Promise<MockDbT> {
  let mockDb = MockDb.createMockDb();
  mockDb = await Identity.Registered.processEvent({
    event: Identity.Registered.createMockEvent({
      personId: PERSON,
      account: ALICE,
      mockEventData: block(T0),
    }),
    mockDb,
  });
  mockDb = await Identity.DeviceChanged.processEvent({
    event: Identity.DeviceChanged.createMockEvent({
      account: ALICE,
      x: DEVICE_X,
      y: DEVICE_Y,
      mockEventData: block(T0),
    }),
    mockDb,
  });
  return Identity.KycLevelSet.processEvent({
    event: Identity.KycLevelSet.createMockEvent({
      account: ALICE,
      level: 1n,
      mockEventData: block(T0),
    }),
    mockDb,
  });
}

describe('Identity handlers', () => {
  it('creates an IdentityAccount on Registered with a lowercase id and zero device keys', async () => {
    const after = await Identity.Registered.processEvent({
      event: Identity.Registered.createMockEvent({
        personId: PERSON,
        account: ALICE,
        mockEventData: block(T0),
      }),
      mockDb: MockDb.createMockDb(),
    });

    expect(after.entities.IdentityAccount.get(ALICE)).toBeUndefined();
    expect(after.entities.IdentityAccount.get(alice)).toEqual({
      id: alice,
      personId: PERSON,
      nickname: undefined,
      kycLevel: 0,
      deviceX: ZERO32,
      deviceY: ZERO32,
      locked: false,
      deviceUpdatedAt: 0n,
    });
  });

  it('raises kycLevel to 1 on KycLevelSet', async () => {
    const after = await signedUp();
    expect(after.entities.IdentityAccount.get(alice)?.kycLevel).toBe(1);
  });

  it('ignores KycLevelSet for an account it never saw registered', async () => {
    const after = await Identity.KycLevelSet.processEvent({
      event: Identity.KycLevelSet.createMockEvent({ account: BOB, level: 1n, mockEventData: block(T0) }),
      mockDb: MockDb.createMockDb(),
    });
    expect(after.entities.IdentityAccount.get(bob)).toBeUndefined();
  });

  it('fills the device keys on DeviceChanged and records deviceUpdatedAt', async () => {
    const after = await signedUp();
    const stored = after.entities.IdentityAccount.get(alice);
    expect(stored?.deviceX).toBe(DEVICE_X);
    expect(stored?.deviceY).toBe(DEVICE_Y);
    expect(stored?.deviceUpdatedAt).toBe(BigInt(T0));
  });

  it('locks and unlocks the row on DeviceLocked', async () => {
    let mockDb = await signedUp();
    mockDb = await Identity.DeviceLocked.processEvent({
      event: Identity.DeviceLocked.createMockEvent({ account: ALICE, locked: true, mockEventData: block(T1) }),
      mockDb,
    });
    expect(mockDb.entities.IdentityAccount.get(alice)?.locked).toBe(true);

    const after = await Identity.DeviceLocked.processEvent({
      event: Identity.DeviceLocked.createMockEvent({ account: ALICE, locked: false, mockEventData: block(T1) }),
      mockDb,
    });
    expect(after.entities.IdentityAccount.get(alice)?.locked).toBe(false);
  });

  it('stores the nickname on NicknameSet', async () => {
    const mockDb = await signedUp();
    const after = await Identity.NicknameSet.processEvent({
      event: Identity.NicknameSet.createMockEvent({
        account: ALICE,
        nicknameHash: NICK_HASH,
        nickname: 'alex',
        mockEventData: block(T0),
      }),
      mockDb,
    });
    expect(after.entities.IdentityAccount.get(alice)?.nickname).toBe('alex');
  });

  it('moves the person and the handle on AccountRotated, leaving the new account without a device', async () => {
    const after = await rotatedAway();

    // 새 계정: 사람·닉네임·kyc 는 따라오지만 기기는 아니다. rotateAccount 는
    // _devices[newAccount] 를 건드리지 않으므로 체인 위에서도 0 이다.
    expect(after.entities.IdentityAccount.get(bob)).toEqual({
      id: bob,
      personId: PERSON,
      nickname: 'alex',
      kycLevel: 1,
      deviceX: ZERO32,
      deviceY: ZERO32,
      locked: false,
      deviceUpdatedAt: 0n,
    });

    // 밀려난 계정: 행은 남되(Ticket.migrate 가 아직 찾는다) 핸들은 잃고,
    // 01b 의 rotateAccount 가 함께 낸 DeviceLocked(old, true) 로 잠겨 있다.
    const previous = after.entities.IdentityAccount.get(alice);
    expect(previous?.nickname).toBeUndefined();
    expect(previous?.deviceX).toBe(DEVICE_X);
    expect(previous?.locked).toBe(true);
  });

  // 01b `RotationCancelled(personId, account)` 는 이 저장소의 ABI 에 아직 없다.
  // 그럴 필요도 없다: cancelRotation 은 AccountRotated(personId, current, msg.sender)
  // 를 **먼저** 내고 RotationCancelled 를 뒤에 낸다(MONTI-01b Identity.sol:160-162).
  // 아래가 그 시퀀스다 — 되돌린 계정의 기기와 잠금이 제 것으로 남아야 한다.
  it('restores the pushed-aside account when the 01b cancelRotation replays AccountRotated', async () => {
    const rotated = await rotatedAway();
    const after = await Identity.AccountRotated.processEvent({
      event: Identity.AccountRotated.createMockEvent({
        personId: PERSON,
        oldAccount: BOB,
        newAccount: ALICE,
        mockEventData: block(T1 + 60),
      }),
      mockDb: rotated,
    });

    expect(after.entities.IdentityAccount.get(alice)).toEqual({
      id: alice,
      personId: PERSON,
      nickname: 'alex',
      kycLevel: 1,
      deviceX: DEVICE_X,
      deviceY: DEVICE_Y,
      // cancelRotation 은 잠금을 일부러 풀지 않는다(Identity.sol:132-134).
      // 여기서 false 로 덮으면 문 앞에서 DENY 날 계정을 통과로 보여 주게 된다.
      locked: true,
      deviceUpdatedAt: BigInt(T0),
    });
    expect(after.entities.IdentityAccount.get(bob)?.nickname).toBeUndefined();
  });
});

/** register → setNickname → 01b rotateAccount(= AccountRotated + DeviceLocked(old,true)). */
async function rotatedAway(): Promise<MockDbT> {
  let mockDb = await signedUp();
  mockDb = await Identity.NicknameSet.processEvent({
    event: Identity.NicknameSet.createMockEvent({
      account: ALICE,
      nicknameHash: NICK_HASH,
      nickname: 'alex',
      mockEventData: block(T0),
    }),
    mockDb,
  });
  mockDb = await Identity.AccountRotated.processEvent({
    event: Identity.AccountRotated.createMockEvent({
      personId: PERSON,
      oldAccount: ALICE,
      newAccount: BOB,
      mockEventData: block(T1),
    }),
    mockDb,
  });
  return Identity.DeviceLocked.processEvent({
    event: Identity.DeviceLocked.createMockEvent({ account: ALICE, locked: true, mockEventData: block(T1) }),
    mockDb,
  });
}

describe('Organizers handlers', () => {
  it('stores the owner lowercased on OrganizerCreated and moves it on OwnerTransferred', async () => {
    let mockDb = await Organizers.OrganizerCreated.processEvent({
      event: Organizers.OrganizerCreated.createMockEvent({ orgId: 1n, owner: ALICE }),
      mockDb: MockDb.createMockDb(),
    });
    expect(mockDb.entities.Organizer.get('1')).toEqual({ id: '1', owner: alice });

    mockDb = await Organizers.OwnerTransferred.processEvent({
      event: Organizers.OwnerTransferred.createMockEvent({ orgId: 1n, from: ALICE, to: BOB }),
      mockDb,
    });
    expect(mockDb.entities.Organizer.get('1')).toEqual({ id: '1', owner: bob });
  });

  it('stores the permission bits on AdminSet under a lowercase composite id', async () => {
    const after = await Organizers.AdminSet.processEvent({
      event: Organizers.AdminSet.createMockEvent({ orgId: 1n, admin: ALICE, bits: 7n }),
      mockDb: MockDb.createMockDb(),
    });
    expect(after.entities.Admin.get(`1-${ALICE}`)).toBeUndefined();
    expect(after.entities.Admin.get(`1-${alice}`)).toEqual({
      id: `1-${alice}`,
      orgId: 1n,
      account: alice,
      bits: 7n,
    });
  });

  it('stores manager flags on ManagerSet', async () => {
    let mockDb = await Organizers.ManagerSet.processEvent({
      event: Organizers.ManagerSet.createMockEvent({
        orgId: 1n,
        manager: ALICE,
        exists: true,
        canApprove: true,
      }),
      mockDb: MockDb.createMockDb(),
    });
    expect(mockDb.entities.Manager.get(`1-${alice}`)).toEqual({
      id: `1-${alice}`,
      orgId: 1n,
      account: alice,
      exists: true,
      canApprove: true,
    });

    // exists false 가 제거다 — 행을 지우지 않고 끈다.
    mockDb = await Organizers.ManagerSet.processEvent({
      event: Organizers.ManagerSet.createMockEvent({
        orgId: 1n,
        manager: ALICE,
        exists: false,
        canApprove: false,
      }),
      mockDb,
    });
    expect(mockDb.entities.Manager.get(`1-${alice}`)?.exists).toBe(false);
  });

  it('records a gate as open only after GateOpened', async () => {
    let mockDb = await registeredGate();
    expect(mockDb.entities.Gate.get('3')).toEqual({
      id: '3',
      eventId: 11n,
      account: gateAddr,
      kx: DEVICE_X,
      ky: DEVICE_Y,
      isOpen: false,
      revoked: false,
    });

    mockDb = await Organizers.GateOpened.processEvent({
      event: Organizers.GateOpened.createMockEvent({ gateId: 3n }),
      mockDb,
    });
    expect(mockDb.entities.Gate.get('3')?.isOpen).toBe(true);

    mockDb = await Organizers.GateClosed.processEvent({
      event: Organizers.GateClosed.createMockEvent({ gateId: 3n }),
      mockDb,
    });
    expect(mockDb.entities.Gate.get('3')?.isOpen).toBe(false);
  });

  it('shuts the gate as well as revoking it on GateRevoked', async () => {
    let mockDb = await registeredGate();
    mockDb = await Organizers.GateOpened.processEvent({
      event: Organizers.GateOpened.createMockEvent({ gateId: 3n }),
      mockDb,
    });
    const after = await Organizers.GateRevoked.processEvent({
      event: Organizers.GateRevoked.createMockEvent({ gateId: 3n }),
      mockDb,
    });
    expect(after.entities.Gate.get('3')?.revoked).toBe(true);
    expect(after.entities.Gate.get('3')?.isOpen).toBe(false);
  });

  it('ignores a gate flag for a gate it never saw registered', async () => {
    const after = await Organizers.GateOpened.processEvent({
      event: Organizers.GateOpened.createMockEvent({ gateId: 99n }),
      mockDb: MockDb.createMockDb(),
    });
    expect(after.entities.Gate.get('99')).toBeUndefined();
  });
});

async function registeredGate(): Promise<MockDbT> {
  return Organizers.GateRegistered.processEvent({
    event: Organizers.GateRegistered.createMockEvent({
      gateId: 3n,
      eventId: 11n,
      gateAccount: GATE,
      kx: DEVICE_X,
      ky: DEVICE_Y,
    }),
    mockDb: MockDb.createMockDb(),
  });
}
