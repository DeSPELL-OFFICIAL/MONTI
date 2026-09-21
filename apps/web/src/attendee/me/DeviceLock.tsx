import { useEffect, useState } from 'react';
import { Alert, Button } from '../../shared/ui';
import { useCopy } from '../../shared/i18n';
import { api } from '../../shared/api/functions';
import { readIdentity } from '../../shared/chain/reads';
import { useSession } from '../../shared/session';

/**
 * The immediate half of the device policy (spec §9.3): one call and the door stops accepting
 * this phone. The chain is the record of whether it is locked — the server deliberately writes
 * nothing to Firestore about it — so this screen asks the chain on arrival rather than
 * remembering an answer from last time.
 */
export function DeviceLock() {
  const copy = useCopy();
  const session = useSession();
  const [locked, setLocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const account = session.account;
    if (!account) return;
    let live = true;
    void readIdentity()
      .isLocked(account)
      .then((value) => {
        if (live) setLocked(value);
      })
      // A read that did not answer is not "unlocked"; the button below is still the way out.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [session.account]);

  async function lock(): Promise<void> {
    setBusy(true);
    setError('');
    try {
      // `{ alreadyLocked: true }` comes back without a hash and means the chain was already
      // locked. Both shapes are the same outcome for the person reading this screen.
      await api.lockDevice();
      setLocked(true);
    } catch {
      setError(copy.me.lockFailed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h2>{copy.me.lockDevice}</h2>
      <p>{copy.me.lockBody}</p>
      {locked ? (
        <>
          <Alert tone="warn">{copy.me.locked}</Alert>
          <p>{copy.me.unlockGuide}</p>
        </>
      ) : null}
      {error ? <Alert tone="error">{error}</Alert> : null}
      {busy ? <p>{copy.me.lockWorking}</p> : null}
      <Button variant="danger" onClick={() => void lock()} disabled={busy || locked}>
        {copy.me.lockCta}
      </Button>
    </section>
  );
}
