import { describe, expect, it } from 'vitest';
import { decodeFunctionData, keccak256, parseAbi, sha256 } from 'viem';
import type { Address } from 'viem';
import {
  FORWARD_TAG,
  FORWARDER_ERRORS,
  decodeForwardRequestStruct,
  encodeExecuteCalldata,
  encodeForwardRequestStruct,
  forwardDigest,
  forwardPreimage,
  type ForwardRequest,
} from './forward.js';
import { claimAuthDigest } from './claimAuth.js';
import { deviceDigest } from './encoding.js';
import type { Hex } from './types.js';

/**
 * 고정 벡터. 값은 실제 컨트랙트(MONTI-01b 3ba353a MontiForwarder.forwardDigest)를 forge 테스트로
 * 배포·호출해 뽑았다 — viem 구현과 독립적이다. `forwarder` 는 그 테스트가 배포한 인스턴스 주소이고,
 * 다이제스트가 abi.encode 에서 address(this) 로 그 값을 쓰므로 벡터에 그대로 박는다.
 */
const VECTORS: {
  label: string;
  chainId: bigint;
  forwarder: Address;
  req: ForwardRequest;
  digest: Hex;
}[] = [
  {
    label: 'V1 all-zero, empty data',
    chainId: 10143n,
    forwarder: '0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f',
    req: {
      from: '0x0000000000000000000000000000000000000000',
      to: '0x0000000000000000000000000000000000000000',
      nonce: 0n,
      deadline: 0n,
      data: '0x',
    },
    digest: '0x1df9ceac13282a709d19542e14709de0de7a39245c5b9ed1354604f86795c4e9',
  },
  {
    label: 'V2 mid-range, selector data',
    chainId: 1n,
    forwarder: '0x2e234DAe75C793f67A35089C9d99245E1C58470b',
    req: {
      from: '0x1111111111111111111111111111111111111111',
      to: '0x2222222222222222222222222222222222222222',
      nonce: 7n,
      deadline: 1893456000n,
      data: '0xdeadbeef',
    },
    digest: '0xbd81f873a9668dca10760032204c29f28f22b4f559af48afad07f0939037d331',
  },
  {
    label: 'V3 max edges, long data',
    chainId: 84532n,
    forwarder: '0xF62849F9A0B5Bf2913b396098F7c7019b51A820a',
    req: {
      from: '0xffffffffffffffffffffffffffffffffffffffff',
      to: '0xffffffffffffffffffffffffffffffffffffffff',
      nonce: (1n << 256n) - 1n,
      deadline: (1n << 64n) - 1n,
      data: '0x0123456789abcdeffedcba9876543210',
    },
    digest: '0x14541f38f6422bdf12ab3436d439c86e130fdfa5ec8ac03f136c469cd5884657',
  },
];

describe('FORWARD_TAG', () => {
  it('is keccak256("MONTI:FORWARD:v1")', () => {
    expect(FORWARD_TAG).toBe('0x2dba07d75cb59685a255eea5097a7e4548152be220829037c69f66b1c6b473c7');
  });
});

describe('forwardDigest', () => {
  for (const v of VECTORS) {
    it(`matches the contract-derived vector: ${v.label}`, () => {
      expect(forwardDigest(v.chainId, v.forwarder, v.req)).toBe(v.digest);
    });
  }

  it('is sha256 of forwardPreimage, the bytes a verifier that hashes internally is handed', () => {
    const v = VECTORS[0]!;
    // abi.encode of (bytes32, uint256, address, address, address, uint256, uint64, bytes32) is eight words.
    // The eighth word is keccak256(data); for empty data it is the well-known keccak256("").
    const preimage = forwardPreimage(v.chainId, v.forwarder, v.req);
    expect(preimage).toBe(
      '0x' +
        FORWARD_TAG.slice(2) +
        (10143).toString(16).padStart(64, '0') +
        '5615deb798bb3e4dfa0139dfa1b3d433cc23b72f'.padStart(64, '0') +
        '0'.repeat(64) + // from
        '0'.repeat(64) + // to
        '0'.repeat(64) + // nonce
        '0'.repeat(64) + // deadline
        'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470', // keccak256("")
    );
    expect(keccak256('0x')).toBe('0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
    expect(sha256(preimage)).toBe(v.digest);
  });

  it('binds keccak256(data): changing only data changes the digest', () => {
    const v = VECTORS[1]!;
    const other = forwardDigest(v.chainId, v.forwarder, { ...v.req, data: '0xdeadbeff' });
    expect(other).not.toBe(v.digest);
  });

  it('rejects a malformed forwarder address', () => {
    expect(() => forwardDigest(1n, '0x1234' as Address, VECTORS[1]!.req)).toThrow('BAD_FORWARDER_ADDRESS');
  });

  it('rejects odd-length data', () => {
    expect(() => forwardDigest(1n, VECTORS[1]!.forwarder, { ...VECTORS[1]!.req, data: '0xabc' as Hex })).toThrow(
      'BAD_DATA',
    );
  });
});

describe('encodeForwardRequestStruct / decodeForwardRequestStruct', () => {
  it('round-trips through the JSON-safe wire form', () => {
    for (const v of VECTORS) {
      const wire = encodeForwardRequestStruct(v.req);
      expect(JSON.parse(JSON.stringify(wire))).toEqual(wire); // JSON-safe: no bigint leaks
      expect(decodeForwardRequestStruct(wire)).toEqual(v.req);
    }
  });

  it('serializes bigints as decimal strings in struct order', () => {
    const wire = encodeForwardRequestStruct(VECTORS[1]!.req);
    expect(wire).toEqual({
      from: '0x1111111111111111111111111111111111111111',
      to: '0x2222222222222222222222222222222222222222',
      nonce: '7',
      deadline: '1893456000',
      data: '0xdeadbeef',
    });
  });

  it('rejects a non-decimal nonce on decode', () => {
    expect(() => decodeForwardRequestStruct({ ...encodeForwardRequestStruct(VECTORS[1]!.req), nonce: '0x7' })).toThrow(
      'BAD_DECIMAL',
    );
  });
});

describe('encodeExecuteCalldata', () => {
  it('round-trips through the minimal execute ABI', () => {
    const v = VECTORS[1]!;
    const deviceSig = ('0x' + '11'.repeat(32) + '22'.repeat(32)) as Hex; // r||s, 64 bytes
    const calldata = encodeExecuteCalldata(v.req, deviceSig);
    const abi = parseAbi([
      'function execute((address from,address to,uint256 nonce,uint64 deadline,bytes data) req, bytes deviceSig) returns (bytes)',
    ]);
    const { functionName, args } = decodeFunctionData({ abi, data: calldata });
    expect(functionName).toBe('execute');
    expect(args[0]).toEqual({
      from: v.req.from,
      to: v.req.to,
      nonce: v.req.nonce,
      deadline: v.req.deadline,
      data: v.req.data,
    });
    expect(args[1]).toBe(deviceSig);
  });
});

describe('FORWARDER_ERRORS', () => {
  it('lists the six execute-path custom errors in order', () => {
    expect(FORWARDER_ERRORS).toEqual([
      'TargetNotAllowed',
      'Expired',
      'BadNonce',
      'NotMember',
      'DeviceLocked',
      'BadDeviceSignature',
    ]);
  });
});

describe('domain separation', () => {
  it('a forward digest never equals the claim-auth or check-in digest of the same numbers', () => {
    const chainId = 10143n;
    const addr = '0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f' as Address;
    const fwd = forwardDigest(chainId, addr, {
      from: addr,
      to: addr,
      nonce: 1n,
      deadline: 1n,
      data: '0x',
    });
    const claim = claimAuthDigest(chainId, addr, {
      eventId: 1n,
      tier: 0,
      account: addr,
      nonce: 1n,
      deadline: 1n,
    });
    const checkIn = deviceDigest({
      chainId,
      ticket: addr,
      tokenId: 1n,
      gateId: 1n,
      eventId: 1n,
      nonce: ('0x' + '00'.repeat(32)) as Hex,
      issuedAt: 1n,
    });
    expect(fwd).not.toBe(claim);
    expect(fwd).not.toBe(checkIn);
    // ...and the two other paths are themselves distinct (the purpose tag is what separates them).
    expect(claim).not.toBe(checkIn);
  });
});
