import { useCallback, useState } from 'react';
import { Link, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { Button, Field, Screen } from '../shared/ui';
import { fmt } from '../shared/i18n';
import { useOrganizerCopy } from './copy';
import { Dashboard } from './Dashboard';
import { Team } from './Team';
import { Gates } from './gates/Gates';
import { AcceptInvite } from './invites/Accept';
import { useWizard } from './wizard/useWizard';
import { Step1Basic } from './wizard/Step1Basic';
import { Step2When } from './wizard/Step2When';
import { Step3Tiers } from './wizard/Step3Tiers';
import { Step4Rules } from './wizard/Step4Rules';
import { Step5Staff } from './wizard/Step5Staff';
import { Step6Review } from './wizard/Step6Review';

const LAST_STEP = 6;

/**
 * The six steps, over one draft. The draft is kept on this device (`useWizard`), so a reload
 * — or an organiser who closed the tab to go and find the venue address — comes back to what
 * they had typed. Only the last step sends anything anywhere.
 */
function Wizard() {
  const copy = useOrganizerCopy().wizard;
  const navigate = useNavigate();
  const { draft, patch, reset } = useWizard();
  const [step, setStep] = useState(1);

  const onNext = useCallback(() => setStep((current) => Math.min(LAST_STEP, current + 1)), []);
  const onBack = useCallback(() => setStep((current) => Math.max(1, current - 1)), []);
  const steps = { draft, patch, onNext, onBack };

  return (
    <Screen title={copy.heading}>
      <p style={{ color: 'var(--muted)', fontSize: 13 }}>{fmt(copy.stepOf, { step })}</p>
      {step === 1 ? <Step1Basic draft={draft} patch={patch} onNext={onNext} /> : null}
      {step === 2 ? <Step2When {...steps} /> : null}
      {step === 3 ? <Step3Tiers {...steps} /> : null}
      {step === 4 ? <Step4Rules {...steps} /> : null}
      {step === 5 ? <Step5Staff {...steps} /> : null}
      {step === 6 ? (
        <Step6Review
          draft={draft}
          patch={patch}
          onBack={onBack}
          onPublished={reset}
          onDone={() => navigate('/org')}
        />
      ) : null}
      <p style={{ color: 'var(--muted)', fontSize: 13 }}>{copy.saveDraft}</p>
      <Button
        variant="ghost"
        onClick={() => {
          reset();
          setStep(1);
        }}
      >
        {copy.startOver}
      </Button>
    </Screen>
  );
}

/**
 * The way in. There is no list of an organiser's events yet: `createEvent` returns the new id
 * in its `EventCreated` log and the indexer has it a moment later, but nothing links the two
 * today (Task 29 could not, and this task does not invent a link it cannot keep). So the
 * number is typed in, which is also how an organiser arrives from a colleague's message.
 */
function OrganizerHome() {
  const copy = useOrganizerCopy();
  const navigate = useNavigate();
  const [eventId, setEventId] = useState('');
  const [orgId, setOrgId] = useState('');

  return (
    <Screen title={copy.home.title}>
      <Button onClick={() => navigate('/org/new')}>{copy.home.newEvent}</Button>

      <section>
        <h2>{copy.home.openEvent}</h2>
        <Field label={copy.home.eventId}>
          <input value={eventId} inputMode="numeric" onChange={(event) => setEventId(event.target.value)} />
        </Field>
        <Button
          disabled={!/^[0-9]+$/.test(eventId)}
          onClick={() => navigate(`/org/events/${eventId}`)}
        >
          {copy.home.open}
        </Button>
      </section>

      <section>
        <h2>{copy.home.team}</h2>
        <Field label={copy.home.orgId}>
          <input value={orgId} inputMode="numeric" onChange={(event) => setOrgId(event.target.value)} />
        </Field>
        <Button disabled={!/^[0-9]+$/.test(orgId)} onClick={() => navigate(`/org/team/${orgId}`)}>
          {copy.home.team}
        </Button>
      </section>

      <p>
        <Link to="/org/team">{copy.team.title}</Link>
      </p>
    </Screen>
  );
}

/** `Team` takes its organisation from the path so a link can carry it; typed in otherwise. */
function TeamRoute() {
  const { orgId } = useParams();
  return <Team orgId={orgId} />;
}

export function OrganizerRoutes() {
  return (
    <Routes>
      <Route index element={<OrganizerHome />} />
      <Route path="new" element={<Wizard />} />
      <Route path="events/:eventId" element={<Dashboard />} />
      <Route path="events/:eventId/gates" element={<Gates />} />
      <Route path="team" element={<Team />} />
      <Route path="team/:orgId" element={<TeamRoute />} />
      {/* Exactly where `createInvite`'s link points (functions/src/functions/invites.ts). */}
      <Route path="invite/:inviteId" element={<AcceptInvite />} />
    </Routes>
  );
}
