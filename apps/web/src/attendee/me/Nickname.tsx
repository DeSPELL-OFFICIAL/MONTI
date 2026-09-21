import { useState } from 'react';
import { encodeErrorResult, keccak256, toBytes, type Hex } from 'viem';
import { Alert, Button, Field } from '../../shared/ui';
import { useCopy } from '../../shared/i18n';
import type { Copy } from '../../shared/copy/index';
import { identityAbi } from '../../shared/chain/abis';
import { readIdentity } from '../../shared/chain/reads';
import { identityOp } from '../../shared/chain/ops';
import { getAttendeeAccount } from '../../shared/chain/accounts';
import { saveUserProfile } from '../../shared/api/firestore';

const ZERO_ADDRESS = `0x${'00'.repeat(20)}`;

/**
 * Platform budget: a name change belongs to nobody's event, so the paymaster sponsors it out
 * of the platform's own allowance rather than an organiser's.
 */
const PLATFORM_ORG_ID = 0n;

/**
 * `Identity.setNickname` refuses for exactly three reasons, and they are not the same reason.
 * Length and charset never reach the chain — {@link normalizeNickname} stops them — so the two
 * left are the name being spoken for and the account not being registered at all. Anything
 * else is a bug on this side (`NicknameHashMismatch` means the hash and the string disagreed)
 * and gets the generic sentence rather than a lie about what the person typed.
 */
const REVERT_SENTENCES: ReadonlyArray<readonly [string, keyof Copy['me']]> = [
  ['NicknameTaken', 'nicknameTaken'],
  ['NotRegistered', 'nicknameNeedsAccount'],
];

/**
 * The reason an operation carried back, read structurally rather than with `instanceof
 * OpReverted`, so the branch survives a screen test that mocks `chain/ops` whole — the same
 * reason `callableFailure` does it that way.
 */
function revertReasonOf(error: unknown): Hex | undefined {
  const reason = (error as { revertReason?: unknown } | null)?.revertReason;
  return typeof reason === 'string' && reason.startsWith('0x') ? (reason as Hex) : undefined;
}

/** The selector the generated ABI gives this error, or nothing when it no longer carries it. */
function selectorOf(errorName: string): string | undefined {
  try {
    return encodeErrorResult({ abi: identityAbi, errorName }).toLowerCase();
  } catch {
    return undefined;
  }
}

function revertSentence(copy: Copy, error: unknown): string {
  const reason = revertReasonOf(error);
  if (reason === undefined) return copy.common.error;
  const selector = reason.slice(0, 10).toLowerCase();
  for (const [errorName, key] of REVERT_SENTENCES) {
    if (selectorOf(errorName) === selector) return copy.me[key];
  }
  return copy.common.error;
}

/**
 * The charset the contract's own uniqueness index assumes: one name, one spelling. Trimming
 * and lowercasing here means `Alex_01` and `alex_01` hash to the same thing, which is what
 * stops two people believing they hold different names.
 */
export function normalizeNickname(input: string): string | null {
  const value = input.trim().toLowerCase();
  return /^[a-z0-9_]{3,20}$/.test(value) ? value : null;
}

export function Nickname() {
  const copy = useCopy();
  const [value, setValue] = useState('');
  const [message, setMessage] = useState('');
  const [tone, setTone] = useState<'info' | 'error'>('info');
  const [busy, setBusy] = useState(false);

  async function save(): Promise<void> {
    const name = normalizeNickname(value);
    if (!name) {
      setTone('error');
      setMessage(copy.me.nicknameInvalid);
      return;
    }
    setBusy(true);
    setMessage('');
    try {
      const hash = keccak256(toBytes(name));
      const account = await getAttendeeAccount();
      // Asking first turns the common refusal into a sentence nobody had to wait for. It is
      // not a guarantee — somebody can take the name between this read and the send — which is
      // why `NicknameTaken` still has a sentence below.
      const owner = await readIdentity().nicknameOwner(hash);
      if (owner.toLowerCase() === account.address.toLowerCase()) {
        // The contract returns early for this, so sending would burn a sponsored operation to
        // achieve nothing.
        setTone('info');
        setMessage(copy.me.nicknameMine);
        return;
      }
      if (owner.toLowerCase() !== ZERO_ADDRESS) {
        setTone('error');
        setMessage(copy.me.nicknameTaken);
        return;
      }
      await identityOp({
        account,
        orgId: PLATFORM_ORG_ID,
        functionName: 'setNickname',
        args: [hash, name],
      });
      // Only after the chain took it: the profile copy is a convenience mirror of an on-chain
      // fact, and a mirror of something that never happened is worse than no mirror.
      await saveUserProfile({ nickname: name });
      setTone('info');
      setMessage(copy.me.nicknameSaved);
    } catch (cause) {
      setTone('error');
      setMessage(revertSentence(copy, cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <Field label={copy.me.nickname}>
        <input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder={copy.me.nicknameHint}
        />
      </Field>
      {message ? <Alert tone={tone}>{message}</Alert> : null}
      <Button onClick={() => void save()} disabled={busy}>{copy.common.save}</Button>
    </section>
  );
}
