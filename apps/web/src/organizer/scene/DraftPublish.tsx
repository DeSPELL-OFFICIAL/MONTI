import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  Alert, Button, Card, Field, OpProgress, Screen, Sheet, Spinner, Steps, StickyBar, type OpPhase,
} from '../../shared/ui';
import { fmt, useLocale } from '../../shared/i18n';
import { formatUsdCents } from '../../shared/money';
import { useDisplayName } from '../../shared/displayName';
import { useOrganizerCopy } from '../copy';
import { useMyOrgs } from '../useMyOrgs';
import { isGoodOrgName, ORG_NAME_MAX } from '../orgName';
import { useEventDraft } from '../useEventDraft';
import { SplitEditor } from '../settlement/SplitEditor';
import {
  bpsToPercent, parseSplit, serializeSplit, type RecipientRow,
} from '../settlement/settlementModel';
import { KR_REGIONS } from './regions';
import { currentPublishEnv, publishView } from './draftPublishModel';
import { usePublish } from './usePublish';

/** The worked example's ticket when the draft has no paid price to show (never on a paid draft). */
const FALLBACK_EXAMPLE_CENTS = 3_000;

/**
 * `/org/new/:draftId/publish` — the last screen of draft → 정산 규칙 → 공개 (design §5).
 *
 * Nothing before this screen touched the chain: 만들기 saved the draft, and the split rules
 * edited here are saved into the same draft (`splitJson`). 공개하기 is the one write — it opens
 * a confirm sheet that says exactly what goes public (title, kinds and prices, split rules) and
 * that none of it can be changed afterwards, then runs {@link usePublish}. Editing stays on the
 * draft: the 내용 고치기 link goes back to the creation scene, never to a published event.
 */
export function DraftPublish() {
  const organizer = useOrganizerCopy();
  const copy = organizer.scene.publishScreen;
  const scene = organizer.scene;
  const locale = useLocale();
  const navigate = useNavigate();
  const { draftId: wanted = '' } = useParams();
  const { draft, draftId, loading, patch, save, discard } = useEventDraft('', wanted);
  const myOrgs = useMyOrgs();
  const displayName = useDisplayName();

  const view = publishView(draft, currentPublishEnv());

  // The split rows the editor holds, seeded once from the draft. Kept here (not re-parsed every
  // render) so each row keeps its React identity while it is typed into.
  const [rows, setRows] = useState<RecipientRow[] | null>(null);
  useEffect(() => {
    if (rows !== null || loading) return;
    setRows(parseSplit(draft.splitJson, currentPublishEnv().platformAccount ?? ''));
  }, [draft.splitJson, loading, rows]);
  function changeRows(next: RecipientRow[]): void {
    setRows(next);
    patch({ splitJson: serializeSplit(next) });
  }

  // The organiser name, when this person has none yet — one line above the button (plan B-4).
  const [orgName, setOrgName] = useState('');
  const orgTyped = useRef(false);
  useEffect(() => {
    if (orgTyped.current) return;
    const prefill = draft.orgPendingName || displayName;
    if (prefill !== '') setOrgName(prefill);
  }, [displayName, draft.orgPendingName]);
  const needsOrg = !myOrgs.isLoading && myOrgs.orgs.length === 0 && draft.orgId === '';
  const orgNameWrong = needsOrg && !isGoodOrgName(orgName);

  const [confirming, setConfirming] = useState(false);
  const [checked, setChecked] = useState(false);

  const { phase, problem, publish } = usePublish({
    draft,
    draftId,
    myOrgs,
    orgName,
    patch,
    save,
    discard,
    onCreated: (created) => {
      navigate(`/org/new/done/${created.eventId}`, {
        state: {
          posterCid: created.posterCid,
          title: created.title,
          followUpFailed: created.followUpFailed,
          draftId: created.draftId,
          plan: created.plan,
          done: created.done,
        },
      });
    },
  });

  // `confirming` leaves the button pressable: that press follows the relay document of a publish
  // the relayer already broadcast, and never sends a second one.
  const working = phase === 'org' || phase === 'pinning' || phase === 'sending' || phase === 'finishing';
  const opPhase: OpPhase | null =
    phase === 'org' || phase === 'pinning' || phase === 'sending'
      ? 'saving'
      : phase === 'finishing' || (phase === 'confirming' && problem === '')
        ? 'confirming'
        : null;

  function press(): void {
    setChecked(true);
    if (orgNameWrong && !view.resuming) return;
    // A publish already sent (or landed) is followed, not re-confirmed: nothing new goes public.
    if (view.resuming) {
      void publish();
      return;
    }
    setConfirming(true);
  }

  function confirm(): void {
    setConfirming(false);
    void publish();
  }

  const region = KR_REGIONS.find((entry) => entry.code === draft.regionCode);
  const regionLabel = region ? (locale === 'en' ? region.labelEn : region.labelKo) : draft.regionCode;
  const place = draft.venueHidden || draft.venue.trim() === ''
    ? (draft.venueHidden ? fmt(copy.placeRegionOnly, { region: regionLabel }) : regionLabel)
    : draft.venue.trim();
  const date = draft.startsAt > 0
    ? new Date(draft.startsAt * 1_000).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' })
    : '';
  const tierLines = view.tiers.map((tier) => fmt(copy.tierLine, {
    name: tier.name,
    price: tier.priceUsdCents === 0 ? copy.free : formatUsdCents(tier.priceUsdCents),
  }));
  const splitLines = view.rows.map((row) => fmt(copy.splitLine, {
    name: row.name || row.tag, percent: bpsToPercent(row.bps),
  }));
  const exampleCents = view.tiers.find((tier) => tier.priceUsdCents > 0)?.priceUsdCents ?? FALLBACK_EXAMPLE_CENTS;
  const blockerText = view.blocker === 'draft' || view.blocker === 'settlementOff'
    ? copy.blockers[view.blocker]
    : '';

  const summary = (
    <dl className="publish-summary">
      <div>
        <dt>{copy.date}</dt>
        <dd>{date}</dd>
      </div>
      <div>
        <dt>{copy.place}</dt>
        <dd>{place}</dd>
      </div>
      <div>
        <dt>{copy.tiers}</dt>
        <dd>{tierLines.map((line) => <p key={line}>{line}</p>)}</dd>
      </div>
      <div>
        <dt>{copy.kyc}</dt>
        <dd>{draft.requireKyc ? copy.kycOn : copy.kycOff}</dd>
      </div>
      {view.paid ? (
        <div>
          <dt>{copy.split}</dt>
          <dd>{splitLines.map((line) => <p key={line}>{line}</p>)}</dd>
        </div>
      ) : null}
    </dl>
  );

  return (
    <Screen title={copy.title}>
      <div className="scene">
        <p>
          <Link to={`/org/new/${draftId}`}>{copy.back}</Link>
        </p>
        <Steps labels={[scene.stepCreate, scene.stepPublish]} at={1} running={working} />

        <Card title={copy.summary}>
          <h2>{draft.title.trim() || scene.resume.untitled}</h2>
          {summary}
        </Card>

        {view.paid ? (
          <Card title={copy.split} id="publish-split">
            <p className="muted">{copy.splitIntro}</p>
            {rows === null ? <Spinner /> : <SplitEditor rows={rows} onChange={changeRows} exampleCents={exampleCents} />}
          </Card>
        ) : null}

        {needsOrg && !view.resuming ? (
          <Card id="publish-org">
            <Field label={scene.org.label}>
              <input
                value={orgName}
                maxLength={ORG_NAME_MAX}
                placeholder={scene.org.placeholder}
                onChange={(event) => {
                  orgTyped.current = true;
                  setOrgName(event.target.value);
                }}
              />
            </Field>
            <p className="muted">{scene.org.help}</p>
            {checked && orgNameWrong ? <p className="problem">{scene.publishProblems.orgName}</p> : null}
          </Card>
        ) : null}

        {blockerText !== '' && !view.resuming ? <Alert tone="warn">{blockerText}</Alert> : null}
        {problem !== '' ? <Alert tone="error">{scene.publishProblems[problem]}</Alert> : null}
        {opPhase ? (
          <OpProgress
            phase={opPhase}
            onRetry={phase === 'confirming' ? () => void publish() : undefined}
            onLater={phase === 'confirming' ? () => navigate('/org') : undefined}
            laterLabel={scene.publish.checkLater}
            timeoutMessage={phase === 'confirming' ? scene.publish.stuck : undefined}
          />
        ) : null}
        <p className="muted">{copy.linkNote}</p>
        <p className="muted">{scene.tiers.feeNote}</p>
      </div>

      {confirming ? (
        <Sheet label={copy.confirmHeading} onDismiss={() => setConfirming(false)}>
          <h2>{copy.confirmHeading}</h2>
          <p><strong>{draft.title.trim()}</strong></p>
          {summary}
          <p>{copy.confirmBody}</p>
          <Button onClick={confirm}>{copy.confirm}</Button>
          <Button variant="ghost" onClick={() => setConfirming(false)}>{copy.cancel}</Button>
        </Sheet>
      ) : null}

      <StickyBar>
        <Button disabled={!view.publishable || working || confirming} onClick={press}>
          {copy.publish}
        </Button>
      </StickyBar>
    </Screen>
  );
}
