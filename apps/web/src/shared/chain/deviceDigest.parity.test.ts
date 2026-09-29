// @vitest-environment node
/**
 * **A NETWORK TEST.** It reads the Ticket deployed to Monad testnet (chain 10143) over HTTP.
 * It is the one check in this app that no amount of local arithmetic can stand in for.
 *
 * Why it exists: `Ticket.deviceDigest` hashes **seven** words, and two of them — `block.chainid`
 * and `address(this)` — are filled in by the contract, not passed by the caller
 * (`contracts/docs/abi-delta-01b.md` §7.2). A client that re-implements the formula and omits
 * either one still produces a 32-byte value, still signs it, still passes every local test, and
 * is refused at the door with `BadDeviceSignature`. The only way to know the app signs what the
 * contract verifies is to ask the contract.
 *
 * Offline it **skips**, it does not fail: a transport error is a statement about the network,
 * not about this app. Only the reachability probe is caught — once the RPC answers, every
 * assertion below is a real assertion and a mismatch is a red test.
 *
 * To force it: bring the RPC in reach and run the file on its own —
 *   `fnm exec --using=22 pnpm -F web test src/shared/chain/deviceDigest.parity.test.ts`
 * A run that printed `skipped` never checked anything; the note says why.
 */
import { describe, expect, it } from 'vitest';
import { createPublicClient, http, type Hex } from 'viem';
import { DEVICE_DIGEST_FORM, deviceDigest, deviceDigestV2, ticketAbi } from '@monti/shared';

/** The public endpoint the 01b redeploy was broadcast through (abi-delta-01b.md §10). */
const RPC_URL = 'https://testnet-rpc.monad.xyz';
const CHAIN_ID = 10143;
/** The Ticket deployed 2026-09-30. A fixture derived against any other address is meaningless. */
const TICKET = '0x7E1fdfCB3688C5b0539101cEAE6a7Ee5bD9b51Cf' as const;

/** The five caller-chosen inputs of the doc's vector (§7.2, re-derived on chain in §10). */
const VECTOR = {
  tokenId: 7n,
  gateId: 3n,
  eventId: 11n,
  nonce: '0x1111111111111111111111111111111111111111111111111111111111111111' as Hex,
  issuedAt: 1_789_862_400n,
} as const;

/**
 * What the deployed contract answers for those five inputs — §10. It is *not* the doc's §7.2
 * digest `0xca378ab2…fe66`: that one names chain 31337 and Ticket `0x7111…1111`, and cannot
 * reappear here precisely because the contract supplies those two words itself.
 */
const EXPECTED = '0x5e3dc13903f0324d285dd06664b0af93191290ecd3fa5d843737c68b39de8319';

/** Generous, because a public testnet RPC is slow; bounded, because CI must not hang on it. */
const TIMEOUT_MS = 20_000;

function reason(cause: unknown): string {
  if (cause instanceof Error) return cause.message.split('\n')[0] ?? cause.name;
  return String(cause);
}

describe('deviceDigest parity with the deployed Ticket', () => {
  it(
    'agrees with the live contract, with deviceDigestV2, and with the build-selected deviceDigest',
    async (ctx) => {
      const client = createPublicClient({
        transport: http(RPC_URL, { timeout: 12_000, retryCount: 1 }),
      });

      // The reachability probe, and the only thing this test catches. Everything after it is
      // an assertion — a reverted call or a decode failure must go red, not quietly green.
      let reportedChainId: number | null = null;
      try {
        reportedChainId = await client.getChainId();
      } catch (cause) {
        ctx.skip(`the parity check did not run: ${RPC_URL} is unreachable — ${reason(cause)}`);
      }
      if (reportedChainId === null) return; // unreachable: ctx.skip() throws.

      // Not a skip. A digest that matched against the wrong network would be worth nothing,
      // and `address(this)` alone would not catch it.
      expect(reportedChainId, `${RPC_URL} is not Monad testnet`).toBe(CHAIN_ID);

      const live = (await client.readContract({
        address: TICKET,
        abi: ticketAbi,
        functionName: 'deviceDigest',
        args: [VECTOR.tokenId, VECTOR.gateId, VECTOR.eventId, VECTOR.nonce, VECTOR.issuedAt],
      })) as Hex;

      // (1) the chain agrees with the value recorded when the 01c Ticket was deployed.
      expect(live).toBe(EXPECTED);

      const input = { chainId: BigInt(CHAIN_ID), ticket: TICKET as Hex, ...VECTOR };

      // (2) our seven-word re-implementation reproduces it, with the two words the caller does
      //     not choose supplied by hand — the exact thing a local test cannot verify alone.
      expect(deviceDigestV2(input)).toBe(live);

      // (3) and the digest this build actually signs is that one. `deviceDigest` follows
      //     `DEVICE_DIGEST_FORM`; while that line still reads `v1-fiveField` the app signs five
      //     words and every check-in is refused at the door, with nothing else going red. This
      //     is the assertion that catches a half-finished flip.
      expect(
        deviceDigest(input),
        `DEVICE_DIGEST_FORM is '${DEVICE_DIGEST_FORM}' — the deployed Ticket verifies the ` +
          "seven-word form, so it has to be 'v2-domainSeparated'",
      ).toBe(deviceDigestV2(input));
    },
    TIMEOUT_MS,
  );
});
