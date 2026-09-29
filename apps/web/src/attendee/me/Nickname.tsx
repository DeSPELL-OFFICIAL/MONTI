import { useState } from 'react';
import { encodeFunctionData, keccak256, toBytes } from 'viem';
import { Alert, Button, Field } from '../../shared/ui';
import { useCopy } from '../../shared/i18n';
import type { Copy } from '../../shared/copy/index';
import { identityAbi } from '../../shared/chain/abis';
import { readIdentity } from '../../shared/chain/reads';
import { sendAction } from '../../shared/relay/sendAction';
import { getAttendeeAccount } from '../../shared/chain/accounts';
import { saveUserProfile } from '../../shared/api/firestore';

const ZERO_ADDRESS = `0x${'00'.repeat(20)}`;

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
 * The forwarder/contract error code a relayed `setNickname` carries on a determinate refusal, read
 * structurally off `details.code` (the frozen `{ code }` shape a `relays/{id}` doc's `error`
 * carries), so the branch survives a screen test that mocks `relay/sendAction` whole. Empty for an
 * unknown outcome — a dropped relay listener — where the name may yet have been taken, so the
 * screen says "still confirming" rather than inviting a second `setNickname`.
 */
function relayCode(error: unknown): string {
  const details = (error as { details?: unknown } | null)?.details;
  if (typeof details === 'object' && details !== null) {
    const { code } = details as { code?: unknown };
    if (typeof code === 'string') return code;
  }
  return '';
}

/** What a failed send should say, and whether it is a failure at all. */
function failure(copy: Copy, error: unknown): { tone: 'info' | 'error'; message: string } {
  const code = relayCode(error);
  if (code === '') return { tone: 'info', message: copy.me.nicknameConfirming };
  for (const [name, key] of REVERT_SENTENCES) {
    if (name === code) return { tone: 'error', message: copy.me[key] };
  }
  return { tone: 'error', message: copy.common.error };
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
        // The contract returns early for this, so sending would burn a relayed operation to
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
      // Platform action: a name change belongs to nobody's event, so the relayer sponsors it out
      // of the platform's own budget rather than an organiser's.
      await sendAction(
        'setNickname',
        'identity',
        encodeFunctionData({ abi: identityAbi, functionName: 'setNickname', args: [hash, name] }),
      );
      // Only after the chain took it: the profile copy is a convenience mirror of an on-chain
      // fact, and a mirror of something that never happened is worse than no mirror.
      await saveUserProfile({ nickname: name });
      setTone('info');
      setMessage(copy.me.nicknameSaved);
    } catch (cause) {
      const outcome = failure(copy, cause);
      setTone(outcome.tone);
      setMessage(outcome.message);
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
      <Button variant="ghost" onClick={() => void save()} disabled={busy}>{copy.common.save}</Button>
    </section>
  );
}
