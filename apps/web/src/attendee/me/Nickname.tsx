import { useState } from 'react';
import { Alert, Button, Field } from '../../shared/ui';
import { useCopy } from '../../shared/i18n';
import type { Copy } from '../../shared/copy/index';
import { api } from '../../shared/api/functions';
import { rememberNickname } from '../../shared/api/nicknames';
import { getAttendeeAccount } from '../../shared/chain/accounts';

/**
 * `setNickname`'s refusals (`details.code`), each a different sentence. Length and charset are
 * stopped here first by {@link normalizeNickname}, but the server re-checks them
 * (`NICKNAME_INVALID`). Anything else gets the generic sentence rather than a guess.
 */
const REFUSAL_SENTENCES: ReadonlyMap<string, keyof Copy['me']> = new Map([
  ['NICKNAME_TAKEN', 'nicknameTaken'],
  ['NICKNAME_INVALID', 'nicknameInvalid'],
  ['NO_PERSON', 'nicknameNeedsAccount'],
]);

function refusalCode(error: unknown): string {
  const details = (error as { details?: unknown } | null)?.details;
  if (typeof details === 'object' && details !== null) {
    const { code } = details as { code?: unknown };
    if (typeof code === 'string') return code;
  }
  return '';
}

/**
 * The charset the server's uniqueness index assumes: one name, one spelling. Trimming and
 * lowercasing here means `Alex_01` and `alex_01` are the same name, which is what stops two
 * people believing they hold different names.
 */
export function normalizeNickname(input: string): string | null {
  const value = input.trim().toLowerCase();
  return /^[a-z0-9_]{3,20}$/.test(value) ? value : null;
}

/**
 * The nickname field (P5). The name is held by the server (`nicknames/{name}`), unique across
 * everybody, and saved with one `setNickname` call — the server also mirrors it to the profile.
 */
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
      const saved = await api.setNickname({ nickname: name });
      try {
        rememberNickname((await getAttendeeAccount()).address, saved.nickname);
      } catch {
        // Only a convenience for this device's own screens; the server already holds the name.
      }
      setTone('info');
      setMessage(copy.me.nicknameSaved);
    } catch (cause) {
      const key = REFUSAL_SENTENCES.get(refusalCode(cause));
      setTone('error');
      setMessage(key ? copy.me[key] : copy.common.error);
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
