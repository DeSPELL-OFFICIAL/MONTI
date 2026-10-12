// @vitest-environment node
/**
 * **A NETWORK TEST**, and the staff-side twin of `src/shared/chain/deviceDigest.parity.test.ts`.
 * It reads the Ticket deployed to Monad testnet (chain 10143) over HTTP.
 *
 * Why a second one: the attendee's phone signs the digest `@monti/shared` produces, and the web
 * parity test proves *that* function agrees with the chain. The gate does not call that function
 * directly — it calls `checkInDigest` in `staff/offline/offlineVerify.ts`, which assembles the
 * input from the two things a door actually has (the code it served, the token the answer names)
 * and hands it to `deviceDigest`. Everything between those two — which fields go in, in which
 * order, and above all where `chainId` and the Ticket address come from — is staff code, and it
 * is the piece the web test cannot speak for. A gate that builds the input wrong turns every tap
 * away with a signature that "does not verify", while the attendee app and `@monti/shared` stay
 * green.
 *
 * The two words this is really about are `chainid` and the contract's own address.
 * `Ticket._deviceDigest` hashes **seven** words, and those two are filled in by the contract from
 * `block.chainid` and `address(this)` (`contracts/docs/abi-delta-01b.md` §7.2) — they are never
 * passed by the caller, so nothing in a request, a QR code or a wire type carries them. A local
 * re-implementation therefore has to *supply them from somewhere*, and every way of getting that
 * wrong produces a perfectly well-formed 32-byte digest: omit them and you have the old
 * five-word form; read them from a stale config and you have the previous deployment's; default
 * them and you have the local anvil chain. None of those fail a unit test, because a unit test
 * compares our arithmetic against our arithmetic. Only the contract knows which 32 bytes it will
 * accept. On the staff side that plumbing is `DeviceDigestDomain` — the `domain` argument below —
 * which exists precisely so the two words have one source instead of one per screen.
 *
 * Offline it **skips**, it does not fail: a transport error is a statement about the network, not
 * about this app. Only the reachability probe is caught — once the RPC answers, every assertion
 * below is a real assertion and a mismatch is a red test.
 *
 * To force it: bring the RPC in reach and run the file on its own —
 *   `fnm exec --using=22 pnpm -F web test src/staff/offline/deviceDigest.parity.test.ts`
 * A run that printed `skipped` never checked anything; the note says why.
 */
import { describe, expect, it } from 'vitest';
import { createPublicClient, http } from 'viem';
import {
  DEVICE_DIGEST_FORM,
  MONAD_TESTNET_CHAIN_ID,
  deviceDigestV2,
  ticketAbi,
  ticketAddress,
} from '@monti/shared';

import type { GateCodeWire, Hex } from '../types';
import { checkInDigest, type DeviceDigestDomain } from './offlineVerify';

/** The public endpoint the 01b redeploy was broadcast through (abi-delta-01b.md §10). */
const RPC_URL = 'https://testnet-rpc.monad.xyz';
const CHAIN_ID = 10143;
/** The v2 rc1 Ticket deployed 2026-10-12. A fixture derived against any other address is meaningless. */
const TICKET = '0x8544c531A3EF7f702fe3A64Ff20D57bA774d9edC' as const;

/** The five caller-chosen inputs of the doc's vector (§7.2, re-derived on chain in §10). */
const VECTOR = {
  tokenId: 7n,
  gateId: 3n,
  eventId: 11n,
  nonce: `0x${'11'.repeat(32)}` as Hex,
  issuedAt: 1_789_862_400n,
} as const;

/**
 * The same five inputs as the gate holds them: a code this gate served, and a token id the
 * answer claims. `kx`/`ky`/`sig` are the gate's own key and self-signature — they authenticate
 * the code to the attendee's phone and play no part in the device digest, so any well-formed
 * value does here.
 */
const VECTOR_CODE: GateCodeWire = {
  v: 1,
  gateId: '3',
  eventId: '11',
  issuedAt: 1_789_862_400,
  nonce: VECTOR.nonce,
  kx: `0x${'aa'.repeat(32)}`,
  ky: `0x${'bb'.repeat(32)}`,
  sig: `0x${'cc'.repeat(64)}`,
};

/** The two words the caller never chooses, as the gate carries them (see `configDomain`). */
const DOMAIN: DeviceDigestDomain = { chainId: BigInt(CHAIN_ID), ticket: TICKET };

/**
 * What the deployed contract answers for those five inputs — §10. It is *not* the doc's §7.2
 * digest `0xca378ab2…fe66` that `offlineVerify.test.ts` pins: that one names chain 31337 and
 * Ticket `0x7111…1111`, and cannot reappear here precisely because the contract supplies those
 * two words itself. The pair of vectors is the point — same five inputs, different domain,
 * different digest.
 */
const EXPECTED = '0xcaba7b087bd89614721b46d73391176cf543c4ec91548b62e388c968a537b505';

/** Generous, because a public testnet RPC is slow; bounded, because CI must not hang on it. */
const TIMEOUT_MS = 20_000;

function reason(cause: unknown): string {
  if (cause instanceof Error) return cause.message.split('\n')[0] ?? cause.name;
  return String(cause);
}

describe('the gate digest against the deployed Ticket', () => {
  it(
    'agrees with the live contract, with deviceDigestV2, and with what checkInDigest verifies',
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

      // (2) our seven-word re-implementation reproduces it, with the two words the caller does
      //     not choose supplied by hand — the exact thing a local test cannot verify alone.
      expect(deviceDigestV2({ ...DOMAIN, ...VECTOR })).toBe(live);

      // (3) and the bytes the gate actually verifies a tap against are those bytes. This is the
      //     staff-side assertion the web parity test cannot make: it goes through the door's own
      //     entry point, with the code and token id shaped the way a real tap delivers them, so
      //     it fails if `checkInDigest` mis-assembles the input, if it drops the `domain`, or if
      //     `DEVICE_DIGEST_FORM` still reads 'v1-fiveField' while the deployed Ticket recomputes
      //     the seven-word form. Any of those is every attendee refused at the door with nothing
      //     else going red — a half-finished flip.
      expect(
        checkInDigest({ tokenId: '7', code: VECTOR_CODE, domain: DOMAIN }),
        `DEVICE_DIGEST_FORM is '${DEVICE_DIGEST_FORM}' — the deployed Ticket verifies the ` +
          "seven-word form, so it has to be 'v2-domainSeparated'",
      ).toBe(live);
    },
    TIMEOUT_MS,
  );

  // No network: a pure check that the address the vector above was derived against is still the
  // address this build ships. A redeploy that updates the deployment record and leaves this file
  // alone should fail loudly here rather than leave a stale vector quietly passing against an
  // address nobody uses any more.
  it('names the Ticket the deployment record names, so a redeploy cannot leave this behind', () => {
    expect(ticketAddress(MONAD_TESTNET_CHAIN_ID)).toBe(TICKET);
    expect(MONAD_TESTNET_CHAIN_ID).toBe(CHAIN_ID);
  });
});
