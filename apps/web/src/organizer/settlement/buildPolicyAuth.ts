import {
  buildPolicyDigest,
  joinRs,
  P256_HALF_ORDER,
  type Hex,
  type PolicyInput,
} from '@monti/shared';
import { getConfig } from '../../shared/config';
import { getAttendeeAccount } from '../../shared/chain/accounts';
import { readPolicyNonce } from '../../shared/chain/settlementReads';
import { ATTENDEE_KEY_ALIAS, deviceKeyCapability, signWithDeviceKey } from '../../shared/deviceKey';

/** How long an unsigned policy authorisation lives before the vault refuses it (same ~10m as a claim). */
export const SET_POLICY_DEADLINE_SECONDS = 10 * 60;

/** One split row as the organiser editor holds it, ready for `relaySetPolicy`. */
export interface PolicyRecipientForm {
  account: Hex;
  bps: number;
  reason: string;
  tag: string;
}

export interface BuiltPolicy {
  /** The `policy` field `api.relaySetPolicy` takes — recipients by role with the platform mirror. */
  policy: { recipients: PolicyRecipientForm[]; platformBps: number };
  /** The organiser's replay counter and the deadline the device key signed, JSON-safe. */
  auth: { nonce: string; deadline: string };
  /** The device key's P-256 signature over the settlement digest: `0x` + 128 hex (r‖s). */
  deviceSig: Hex;
}

export interface BuildPolicyParams {
  eventId: string;
  recipients: PolicyRecipientForm[];
  platformBps: number;
  /** The fresh nonce a BAD_NONCE retry already holds; read from the vault when omitted. */
  nonce?: bigint;
}

/**
 * Builds and signs one `setPolicy` authorisation (settlement design §1/§3). The device key must
 * produce a P-256 signature over the 32-byte digest `SettlementVault.setPolicyDigest` recomputes —
 * and, exactly as {@link buildClaimAuth}/{@link buildForwardRequest} do, the two key backends need
 * different bytes to get there: the secure element (`native`) signs the digest raw, while the
 * browser's WebCrypto key (`software`) hashes what it is handed, so it is given the preimage whose
 * SHA-256 is that digest. `policyHash` is `hashPolicy` over the on-chain recipient shape, so the
 * reasons and tags here hash the same bytes the vault stores; `s` must land in the low half or
 * Solady's verifier rejects it, and `chainId`/vault address bind the signature to this deployment.
 */
export async function buildPolicyAuth(params: BuildPolicyParams): Promise<BuiltPolicy> {
  const config = getConfig();
  const vault = config.addresses.settlementVault;
  if (vault === undefined) throw new Error('SETTLEMENT_DISABLED');
  const organizer = (await getAttendeeAccount()).address as Hex;
  const eventId = BigInt(params.eventId);
  const nonce = params.nonce ?? (await readPolicyNonce(organizer));
  const deadline = BigInt(Math.floor(Date.now() / 1000) + SET_POLICY_DEADLINE_SECONDS);
  const policyInput: PolicyInput = {
    recipients: params.recipients.map((r) => ({ account: r.account, bps: r.bps, reason: r.reason, tag: r.tag })),
    platformBps: params.platformBps,
  };
  const { preimage, digest } = buildPolicyDigest(policyInput, {
    chainId: BigInt(config.chainId),
    vault,
    eventId,
    nonce,
    deadline,
  });
  const message = deviceKeyCapability() === 'native' ? digest : preimage;
  const { r, s } = await signWithDeviceKey(message, { alias: ATTENDEE_KEY_ALIAS });
  if (BigInt(s) > P256_HALF_ORDER) throw new Error('HIGH_S');
  return {
    policy: { recipients: params.recipients, platformBps: params.platformBps },
    auth: { nonce: nonce.toString(), deadline: deadline.toString() },
    deviceSig: joinRs(r, s),
  };
}
