import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Field, Screen, Spinner } from '../shared/ui';
import { api, callableFailure } from '../shared/api/functions';
import { describeFailure } from '../shared/errors';
import { useCopy } from '../shared/i18n';
import { useOrganizerCopy, type OrganizerCopy } from './copy';

/** The four refusals the server named, each with a sentence of its own. */
type BecomeProblem = keyof OrganizerCopy['become']['problems'];

/**
 * The server's own name rule (functions/src/functions/createOrganizer.ts), kept here so a
 * doomed request never leaves the phone. Counted in **code points**, the way the server counts
 * them: one emoji is one character on both sides, so forty emoji are a name of forty and not
 * of eighty. `BAD_NAME` is still mapped below, for the day the two rules disagree.
 */
const NAME_MIN = 2;
const NAME_MAX = 40;

/** C0 and C1 controls — exactly the set the server refuses. */
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;

function isGoodName(trimmed: string): boolean {
  const points = [...trimmed].length;
  return points >= NAME_MIN && points <= NAME_MAX && !CONTROL_RE.test(trimmed);
}

/** The four refusals worth a sentence of their own. `describeFailure` answers the rest. */
const REASONS: Readonly<Record<string, BecomeProblem>> = {
  NOT_ACTIVE: 'notActive',
  NO_SIGNUP: 'noSignup',
  ORG_LIMIT: 'limit',
  BAD_NAME: 'badName',
};

/**
 * Where a refusal that really means "your signup is not finished" sends the person. They are
 * two different steps: `NO_SIGNUP` is somebody `startSignup` has never seen, and `NOT_ACTIVE`
 * is somebody with a person record whose phone is not registered yet.
 */
const RESUME: Readonly<Partial<Record<BecomeProblem, string>>> = {
  notActive: '/signup/register',
  noSignup: '/signup/phone',
};

/**
 * O0 — one name, one button, and an organisation on the other side.
 *
 * The send goes through `createOrganizerForMe` rather than this person's own account. 01b's
 * redeploy (2026-09-23) did put `Organizers.createOrganizer` (`0x49cd9846`) on the paymaster's
 * allowlist as a Platform-billed selector, so the write is now sponsorable — but this screen
 * deliberately keeps the callable. The callable is what names this person the owner and writes
 * `orgProfiles/{orgId}` in the same breath; routing the write through the attendee's own
 * account would split those two into a pair that can half-land. There is still no
 * `UnsponsoredNotice` here: nothing on this screen costs the organiser anything.
 *
 * The button locks for the whole call, and that is not decoration: the callable is **not
 * idempotent**, so a second tap is a second organisation and only the limit of three stops it.
 *
 * The name never reaches the chain and is never read back here: the server writes it to
 * `orgProfiles/{orgId}` and `useMyOrgs` reads it through `loadOrgName` on the way out.
 */
export function Become() {
  const copy = useOrganizerCopy().become;
  // `common` is nobody's screen: an organiser is told a read failed in the same words an
  // attendee is, so this organiser screen reads the shared sentences rather than owning a
  // fifth one of its own.
  const shared = useCopy();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<BecomeProblem | ''>('');
  // The other arm has no key to hold — `describeFailure` writes the sentence from the failure
  // itself (offline, unreachable, the indexer, a reason nothing names), so the sentence is
  // what is kept. The four named refusals stay a table either way.
  const [failure, setFailure] = useState('');

  const trimmed = name.trim();
  const ready = isGoodName(trimmed);

  const create = async (): Promise<void> => {
    if (busy || !ready) return;
    setBusy(true);
    setProblem('');
    setFailure('');
    try {
      const { orgId } = await api.createOrganizerForMe({ name: trimmed });
      // `replace`, so Back cannot land on this form again and make a second organisation.
      // `/org` reads `?org=` and says the new one is still on its way into the indexer.
      navigate(`/org?org=${orgId}`, { replace: true });
    } catch (error) {
      const { reason } = callableFailure(error);
      const named = REASONS[reason];
      // Everything the table does not name — `AUTH_REQUIRED` behind the session guard, a
      // reverted send, a dropped connection, a phone with no connection at all — is
      // `describeFailure`'s to answer, in the same five steps every other screen uses.
      if (named === undefined) setFailure(describeFailure(error, shared));
      else setProblem(named);
    } finally {
      setBusy(false);
    }
  };

  const resumeTo = problem === '' ? undefined : RESUME[problem];

  return (
    <Screen title={copy.title}>
      <Field label={copy.name}>
        <input value={name} onChange={(event) => setName(event.target.value)} />
      </Field>
      <p className="muted">{copy.nameHelp}</p>

      {problem !== '' ? <Alert tone="error">{copy.problems[problem]}</Alert> : null}
      {failure !== '' ? <Alert tone="error">{failure}</Alert> : null}
      {resumeTo !== undefined ? (
        <Button variant="ghost" onClick={() => navigate(resumeTo)}>
          {copy.resume}
        </Button>
      ) : null}

      <Button disabled={busy || !ready} onClick={() => void create()}>
        {busy ? copy.working : copy.create}
      </Button>
      {busy ? <Spinner /> : null}

      <Button variant="ghost" disabled={busy} onClick={() => navigate('/org')}>
        {copy.cancel}
      </Button>
    </Screen>
  );
}
