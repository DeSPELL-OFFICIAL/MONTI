import {
  encodeForwardRequestStruct,
  forwardDigest,
  forwardPreimage,
  joinRs,
  P256_HALF_ORDER,
  type ForwardRequest,
  type ForwardRequestWire,
  type Hex,
} from '@monti/shared';
import { parseAbi } from 'viem';
import { getConfig } from '../config';
import { getPublicClient } from '../chain/client';
import { getAttendeeAccount } from '../chain/accounts';
import { ATTENDEE_KEY_ALIAS, deviceKeyCapability, signWithDeviceKey } from '../deviceKey';

/** How long an unsent forward request lives before `MontiForwarder` refuses it (design §1: ~10 min). */
export const FORWARD_DEADLINE_SECONDS = 10 * 60;

/**
 * The three contracts `MontiForwarder` is allowed to forward to. Each maps one-for-one onto a key
 * of {@link AppConfig.addresses}, so resolving the on-chain target is a single lookup.
 */
export type RelayTarget = 'ticket' | 'organizers' | 'identity';

export interface BuildForwardRequestParams {
  /** Which allowed contract the calldata runs against. */
  to: RelayTarget;
  /** The target function calldata — `from` is NOT part of it; `execute` appends the sender. */
  data: Hex;
  /** The action tag the relayer routes on (e.g. `createEvent`), passed straight through. */
  kind: string;
  /**
   * The forwarder nonce to sign, when the caller already holds a fresh one — a BAD_NONCE retry
   * passes `details.nonce`. Omitted, it is read from the chain: `MontiForwarder.nonces(from)`.
   */
  nonce?: bigint;
}

export interface BuiltForwardRequest {
  /** The `ForwardRequest` tuple as JSON-safe strings — exactly what `relayAction` takes. */
  req: ForwardRequestWire;
  /** The device key's P-256 signature over {@link forwardDigest}: `0x` + 128 hex (r‖s). */
  deviceSig: Hex;
  /** Echoed back so the caller hands the callable one object. */
  kind: string;
}

// Minimal fragment for the one view this needs; B2 swaps it for the generated `MontiForwarder` ABI.
const FORWARDER_NONCES_ABI = parseAbi(['function nonces(address account) view returns (uint256)']);

/** `MontiForwarder.nonces(from)`: the per-account single sequence a `ForwardRequest` must carry. */
function readForwarderNonce(forwarder: Hex, account: Hex): Promise<bigint> {
  return getPublicClient().readContract({
    address: forwarder,
    abi: FORWARDER_NONCES_ABI,
    functionName: 'nonces',
    args: [account],
  }) as Promise<bigint>;
}

/**
 * Builds and signs one ERC-2771 relay request (design §1). The device key must produce a P-256
 * signature over the 32-byte {@link forwardDigest} — what `MontiForwarder` recomputes and checks.
 * The two backends need different bytes to get there, exactly as {@link buildClaimAuth} does: the
 * secure element (`native`) signs the digest **raw**, while the browser's WebCrypto key
 * (`software`) hashes what it is handed, so it is given the {@link forwardPreimage} whose SHA-256
 * is that digest. Handing the WebCrypto signer the digest would sign `sha256(digest)` and the
 * forwarder would reject it with `BadDeviceSignature`. `s` must land in the low half or Solady's
 * verifier rejects it; `chainId` and the forwarder address come from config, so a signature is
 * bound to this chain and this deployment and cannot be replayed elsewhere.
 */
export async function buildForwardRequest(params: BuildForwardRequestParams): Promise<BuiltForwardRequest> {
  const config = getConfig();
  const forwarder = config.addresses.forwarder;
  const from = (await getAttendeeAccount()).address as Hex;
  const to = config.addresses[params.to];
  const nonce = params.nonce ?? (await readForwarderNonce(forwarder, from));
  const deadline = BigInt(Math.floor(Date.now() / 1000) + FORWARD_DEADLINE_SECONDS);
  const req: ForwardRequest = { from, to, nonce, deadline, data: params.data };
  const chainId = BigInt(config.chainId);
  // The digest is what the chain verifies; the preimage is the bytes whose SHA-256 is that digest.
  const digest = forwardDigest(chainId, forwarder, req);
  const preimage = forwardPreimage(chainId, forwarder, req);
  // A raw signer (secure element) signs the digest as-is; WebCrypto hashes its input, so it takes
  // the preimage. Either way r‖s is a P-256 signature over `digest`.
  const message = deviceKeyCapability() === 'native' ? digest : preimage;
  const { r, s } = await signWithDeviceKey(message, { alias: ATTENDEE_KEY_ALIAS });
  // Solady's P256.verifySignature rejects the high half outright; refuse it before it leaves,
  // exactly as buildClaimAuth does, so the sender never gets an unexplainable revert.
  if (BigInt(s) > P256_HALF_ORDER) throw new Error('HIGH_S');
  return { req: encodeForwardRequestStruct(req), deviceSig: joinRs(r, s), kind: params.kind };
}
