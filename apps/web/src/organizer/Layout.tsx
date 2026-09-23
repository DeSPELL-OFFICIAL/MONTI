import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, Route, Routes, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Alert, Button, Fab, Field, Screen, Spinner } from '../shared/ui';
import { fmt, useLocale } from '../shared/i18n';
import { formatEventDate } from '../attendee/discover/useEvents';
import { useOrganizerCopy, type OrganizerCopy } from './copy';
import { useMyOrgs, useOrgEvents } from './useMyOrgs';
import { Become } from './Become';
import { Dashboard } from './Dashboard';
import { Team } from './Team';
import { Gates } from './gates/Gates';
import { AcceptInvite } from './invites/Accept';
import { CreateEvent } from './scene/CreateEvent';
import { TicketSettings } from './scene/TicketSettings';
import { Created } from './scene/Created';
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
  // `/org/new?org=3` — the organisation picked on the home screen, so step 1's number is
  // already filled in. Only ever on the way in: the latch survives StrictMode's second run of
  // this effect, and a draft that already names an organisation is never overwritten.
  const asked = useSearchParams()[0].get('org') ?? '';
  const prefilled = useRef(false);

  useEffect(() => {
    if (prefilled.current) return;
    prefilled.current = true;
    if (asked !== '' && draft.orgId === '') patch({ orgId: asked });
  }, [asked, draft.orgId, patch]);

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
          // Straight to the new event when its log named it; otherwise the home screen, where
          // the number can be typed in (a `wait` that gave up carries no log to read).
          onDone={(eventId) => navigate(eventId === '' ? '/org' : `/org/events/${eventId}`)}
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

/** The indexer's own words for an event's state; anything else is shown exactly as it came. */
function statusLabel(status: string, labels: OrganizerCopy['home']['status']): string {
  if (status === 'Draft' || status === 'Published' || status === 'Cancelled') return labels[status];
  return status;
}

/**
 * The way in. The indexer answers who this person organises for and what those organisations
 * have put on, so both are listed here and the one main action — `만들기` — is a floating
 * button rather than a number typed into a box.
 *
 * The two number boxes stay, folded away: when the indexer is down they are the only way into
 * an event or a team, and the events list failing must not take them with it. `/org` is
 * deliberately not a tab (four tabs stay four), so the back link at the top is the way out.
 */
function OrganizerHome() {
  const copy = useOrganizerCopy();
  const locale = useLocale();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [eventId, setEventId] = useState('');
  const [orgId, setOrgId] = useState('');

  const { orgs, isLoading: orgsLoading, refetch: refetchOrgs } = useMyOrgs();
  // The choice lives in the address, so a reload keeps it and `/org?org=<new id>` can land on
  // one — which is exactly how an organiser arrives from `주최사 만들기`.
  const asked = params.get('org') ?? '';
  const selected = orgs.find((org) => org.orgId === asked) ?? orgs[0];
  // An organisation the callable already numbered but the indexer has not listed yet.
  const pending = !orgsLoading && asked !== '' && !orgs.some((org) => org.orgId === asked);

  // Every organisation is asked for at once: somebody who organises for two of them wants one
  // list, and switching between them then costs no round trip. Only the chosen one is shown.
  const orgIds = useMemo(() => orgs.map((org) => org.orgId), [orgs]);
  const { events, isLoading: eventsLoading, isError: eventsError, refetch: refetchEvents } = useOrgEvents(orgIds);
  const mine = selected === undefined ? [] : events.filter((event) => event.orgId === selected.orgId);

  return (
    <Screen title={copy.home.title}>
      <p>
        <Link to="/">{copy.home.backToDiscover}</Link>
      </p>

      <section>
        <h2>{copy.home.orgs}</h2>
        {orgsLoading ? <Spinner /> : null}

        {pending ? (
          <>
            <p className="muted">{copy.home.orgPending}</p>
            <Button variant="ghost" onClick={refetchOrgs}>
              {copy.home.retry}
            </Button>
          </>
        ) : null}

        {!orgsLoading && !pending && orgs.length === 0 ? (
          <>
            <p className="muted">{copy.home.orgsEmpty}</p>
            <p>
              <Link to="/org/become">{copy.home.become}</Link>
            </p>
          </>
        ) : null}

        {selected !== undefined ? (
          <>
            {/* One organisation needs no picker: its name is the whole answer. */}
            {orgs.length === 1 ? (
              <p>{selected.name}</p>
            ) : (
              <Field label={copy.home.org}>
                <select value={selected.orgId} onChange={(event) => setParams({ org: event.target.value })}>
                  {orgs.map((org) => (
                    <option key={org.orgId} value={org.orgId}>
                      {org.name}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <p>
              <Link to={`/org/team/${selected.orgId}`}>{copy.home.team}</Link>
            </p>
            {!selected.canCreateEvent ? <Alert tone="warn">{copy.home.noPermission}</Alert> : null}
          </>
        ) : null}
      </section>

      <section>
        <h2>{copy.home.events}</h2>
        {eventsLoading ? <Spinner /> : null}

        {eventsError ? (
          <>
            <Alert tone="error">{copy.home.eventsFailed}</Alert>
            <Button variant="ghost" onClick={refetchEvents}>
              {copy.home.retry}
            </Button>
          </>
        ) : null}

        {!eventsLoading && !eventsError && selected !== undefined && mine.length === 0 ? (
          <p className="muted">{copy.home.eventsEmpty}</p>
        ) : null}

        <ul className="event-list">
          {mine.map((event) => (
            <li key={event.id}>
              <Link to={`/org/events/${event.id}`}>{fmt(copy.home.eventFallback, { id: event.id })}</Link>
              <span className="muted"> {statusLabel(event.status, copy.home.status)}</span>
              <p className="muted">{formatEventDate(event.startsAt, locale)}</p>
            </li>
          ))}
        </ul>
      </section>

      {/* Folded, not deleted: the indexer being down is exactly when this is needed. */}
      <details>
        <summary>{copy.home.manual}</summary>
        <Field label={copy.home.eventId}>
          <input value={eventId} inputMode="numeric" onChange={(event) => setEventId(event.target.value)} />
        </Field>
        <Button disabled={!/^[0-9]+$/.test(eventId)} onClick={() => navigate(`/org/events/${eventId}`)}>
          {copy.home.open}
        </Button>

        <Field label={copy.home.orgId}>
          <input value={orgId} inputMode="numeric" onChange={(event) => setOrgId(event.target.value)} />
        </Field>
        <Button disabled={!/^[0-9]+$/.test(orgId)} onClick={() => navigate(`/org/team/${orgId}`)}>
          {copy.home.team}
        </Button>
      </details>

      <Fab
        label={copy.home.create}
        disabled={selected === undefined || !selected.canCreateEvent}
        onClick={() => navigate(selected === undefined ? '/org/new' : `/org/new?org=${selected.orgId}`)}
      />
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
      {/* Where `주최사 만들기` lands — the organiser home's empty state, the explore FAB
          and the profile section all point here (`useOrganizerEntry`). */}
      <Route path="become" element={<Become />} />
      {/* The creation scene. `/org/new` starts one (or carries on with the newest draft) and
          `/org/new/<draftId>` opens a named one — which is what SCENE 2's back link uses. */}
      <Route path="new" element={<CreateEvent />} />
      {/* Static beats dynamic in the router's ranking, so this is not a draft id. The six-step
          wizard stays reachable here until T-EV-W10 deletes it; nothing links to it. */}
      <Route path="new/old" element={<Wizard />} />
      {/* Where `행사 만들기` lands. Static again, so it is not a draft id. */}
      <Route path="new/done/:eventId" element={<Created />} />
      <Route path="new/:draftId" element={<CreateEvent />} />
      <Route path="new/:draftId/tickets" element={<TicketSettings />} />
      <Route path="events/:eventId" element={<Dashboard />} />
      <Route path="events/:eventId/gates" element={<Gates />} />
      <Route path="team" element={<Team />} />
      <Route path="team/:orgId" element={<TeamRoute />} />
      {/* Exactly where `createInvite`'s link points (functions/src/functions/invites.ts). */}
      <Route path="invite/:inviteId" element={<AcceptInvite />} />
    </Routes>
  );
}
