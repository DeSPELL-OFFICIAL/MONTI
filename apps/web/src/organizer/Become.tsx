import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Field, Screen, Spinner } from '../shared/ui';
import { api, callableFailure } from '../shared/api/functions';
import { useOrganizerCopy, type OrganizerCopy } from './copy';

/** The five sentences this screen can end on; four of them the server named. */
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

/** The four refusals worth a sentence of their own. Everything else shares one line. */
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
  notActive: '/signup/device',
  noSignup: '/signup/phone',
};

/**
 * O0 — one name, one button, and an organisation on the other side.
 *
 * The send goes through `createOrganizerForMe` rather than this person's own account: until
 * sub-plan 01b puts `Organizers.createOrganizer` on the paymaster's allowlist an attendee
 * account has no way to pay for that write, so the server's attester sends it and names this
 * person the owner. That is also why there is no `UnsponsoredNotice` here — nothing on this
 * screen costs the organiser anything, and the notice would be a lie.
 *
 * The button locks for the whole call, and that is not decoration: the callable is **not
 * idempotent**, so a second tap is a second organisation and only the limit of three stops it.
 *
 * The name never reaches the chain and is never read back here: the server writes it to
 * `orgProfiles/{orgId}` and `useMyOrgs` reads it through `loadOrgName` on the way out.
 */
export function Become() {
  const copy = useOrganizerCopy().become;
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<BecomeProblem | ''>('');

  const trimmed = name.trim();
  const ready = isGoodName(trimmed);

  const create = async (): Promise<void> => {
    if (busy || !ready) return;
    setBusy(true);
    setProblem('');
    try {
      const { orgId } = await api.createOrganizerForMe({ name: trimmed });
      // `replace`, so Back cannot land on this form again and make a second organisation.
      // `/org` reads `?org=` and says the new one is still on its way into the indexer.
      navigate(`/org?org=${orgId}`, { replace: true });
    } catch (error) {
      const { reason } = callableFailure(error);
      // The four named refusals stay a table. Everything else — `AUTH_REQUIRED` behind the
      // session guard, a reverted send, a dropped connection — falls to this one expression,
      // which is what T-UX-8 replaces with `describeFailure(error, copy)`.
      setProblem(REASONS[reason] ?? 'failed');
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
