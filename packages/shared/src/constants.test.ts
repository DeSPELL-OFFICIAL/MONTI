import { describe, expect, it } from 'vitest';
import {
  attesterAddress,
  BANNED_ATTENDEE_WORDS,
  CLOCK_SKEW_SECONDS,
  CODE_WINDOW_SECONDS,
  CREATE2_DEPLOYER_ADDRESS,
  DEVICE_COOLDOWN_SECONDS,
  ENTRY_POINT_V06_ADDRESS,
  EVENT_CHAT_MESSAGE_MAX_CHARS,
  FIREBASE_REGION,
  GATE_CODE_ROTATE_MS,
  HCE_AID,
  identityAddress,
  MONAD_TESTNET_CHAIN_ID,
  organizersAddress,
  P256_PRECOMPILE_ADDRESS,
  QR_PREFIX,
  ticketAddress,
  TRANSFER_INVITE_TTL_SECONDS,
  USER_WRITABLE_FIELDS,
  loadDeployment,
  parseDeployment,
  withGasMargin,
} from './constants.js';

describe('chain constants', () => {
  it('pins the Monad testnet id, EntryPoint v0.6 and the P-256 precompile', () => {
    expect(MONAD_TESTNET_CHAIN_ID).toBe(10143);
    expect(ENTRY_POINT_V06_ADDRESS).toBe('0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789');
    expect(P256_PRECOMPILE_ADDRESS).toBe('0x0000000000000000000000000000000000000100');
    expect(CREATE2_DEPLOYER_ADDRESS).toBe('0x4e59b44847b379578588920cA78FbF26c0B4956C');
  });
});

describe('withGasMargin', () => {
  it('multiplies by exactly 1.075 with integer math', () => {
    expect(withGasMargin(275_000n)).toBe(295_625n);
    expect(withGasMargin(440_000n)).toBe(473_000n);
    expect(withGasMargin(0n)).toBe(0n);
    expect(withGasMargin(1n)).toBe(1n);
  });

  it('rejects a negative estimate', () => {
    expect(() => withGasMargin(-1n)).toThrow('NEGATIVE_GAS_ESTIMATE');
  });
});

describe('protocol timings', () => {
  it('matches spec §7.3', () => {
    expect(GATE_CODE_ROTATE_MS).toBe(3_000);
    expect(CODE_WINDOW_SECONDS).toBe(60);
    // Both mirror Ticket.sol: `CODE_WINDOW = 60`, `CLOCK_SKEW = 5`. A phone that judges a gate
    // code by anything else either signs a code the chain will reject or refuses a good one.
    expect(CLOCK_SKEW_SECONDS).toBe(5);
    expect(DEVICE_COOLDOWN_SECONDS).toBe(604_800);
    expect(HCE_AID).toBe('D2760000850101');
    expect(QR_PREFIX).toBe('MONTI1:');
    expect(FIREBASE_REGION).toBe('us-east1');
  });

  it('pins the social limits shared by rules and server code', () => {
    expect(EVENT_CHAT_MESSAGE_MAX_CHARS).toBe(500);
    expect(TRANSFER_INVITE_TTL_SECONDS).toBe(604_800);
    expect([...USER_WRITABLE_FIELDS]).toEqual(['nickname', 'locale', 'chatOrder']);
  });
});

describe('BANNED_ATTENDEE_WORDS', () => {
  it('is the master-plan list verbatim', () => {
    expect([...BANNED_ATTENDEE_WORDS]).toEqual([
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
    ]);
  });
});

describe('deployments', () => {
  it('parses a well-formed deployment', () => {
    const parsed = parseDeployment({
      chainId: 10143,
      identity: '0x1111111111111111111111111111111111111111',
      organizers: '0x2222222222222222222222222222222222222222',
      ticket: '0x3333333333333333333333333333333333333333',
      paymaster: '0x4444444444444444444444444444444444444444',
      attester: '0x6666666666666666666666666666666666666666',
      coinbaseFactory: '0x5555555555555555555555555555555555555555',
      entryPoint: '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789',
      block: 42,
    });
    expect(parsed.chainId).toBe(10143);
    expect(parsed.block).toBe(42);
    expect(parsed.ticket).toBe('0x3333333333333333333333333333333333333333');
    expect(parsed.coinbaseFactory).toBe('0x5555555555555555555555555555555555555555');
  });

  it('rejects a malformed address and a missing block', () => {
    const good = {
      chainId: 10143,
      identity: '0x1111111111111111111111111111111111111111',
      organizers: '0x2222222222222222222222222222222222222222',
      ticket: '0x3333333333333333333333333333333333333333',
      paymaster: '0x4444444444444444444444444444444444444444',
      attester: '0x6666666666666666666666666666666666666666',
      coinbaseFactory: '0x5555555555555555555555555555555555555555',
      entryPoint: '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789',
      block: 1,
    };
    expect(() => parseDeployment({ ...good, identity: '0xnope' })).toThrow('BAD_DEPLOYMENT_FIELD:identity');
    expect(() => parseDeployment({ ...good, coinbaseFactory: undefined })).toThrow('BAD_DEPLOYMENT_FIELD:coinbaseFactory');
    expect(() => parseDeployment({ ...good, block: undefined })).toThrow('BAD_DEPLOYMENT_FIELD:block');
  });

  it('rejects a deployment whose body disagrees with the chain key it is filed under', () => {
    const filedUnder10143 = {
      chainId: 143,
      identity: '0x1111111111111111111111111111111111111111',
      organizers: '0x2222222222222222222222222222222222222222',
      ticket: '0x3333333333333333333333333333333333333333',
      paymaster: '0x4444444444444444444444444444444444444444',
      attester: '0x6666666666666666666666666666666666666666',
      coinbaseFactory: '0x5555555555555555555555555555555555555555',
      entryPoint: '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789',
      block: 1,
    };
    expect(() => parseDeployment(filedUnder10143, 10143)).toThrow('DEPLOYMENT_CHAIN_MISMATCH:10143');
    // 키를 넘기지 않으면 모양 검증만 한다 — loadDeployment 만 교차 확인을 강제한다.
    expect(parseDeployment(filedUnder10143).chainId).toBe(143);
  });

  it('loads the synced testnet deployment lazily and rejects an unknown chain', () => {
    const deployment = loadDeployment(10143);
    expect(deployment.chainId).toBe(10143);
    expect(deployment.block).toBeGreaterThanOrEqual(0);
    expect(() => loadDeployment(1)).toThrow('NO_DEPLOYMENT:1');
  });

  it('exposes address accessors that agree with the loaded deployment', () => {
    const deployment = loadDeployment();
    expect(attesterAddress()).toBe(deployment.attester);
    expect(identityAddress()).toBe(deployment.identity);
    expect(organizersAddress()).toBe(deployment.organizers);
    expect(ticketAddress()).toBe(deployment.ticket);
    expect(attesterAddress()).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});
