import { useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { Alert, Button, Card, OpProgress, Screen, StickyBar, Steps, SuccessCheck, posterUrl } from '../../shared/ui';
import { useCopy } from '../../shared/i18n';
import { readTicket } from '../../shared/chain/reads';
import { useOrganizerCopy } from '../copy';
import { publishEvent, type LifecycleProblem } from '../lifecycle';
import { forgetEventDraft } from '../useEventDraft';
import { followUpsDone, runFollowUps, type FollowUpResult } from './followUps';
import type { CreatedEvent } from './usePublish';

/** Big enough to scan off a phone held up across a table, small enough to be a few kilobytes. */
const QR_WIDTH = 320;

/**
 * What SCENE 2 hands over when the event exists. It travels in the navigation rather than
 * being read back, because by the time this screen opens the draft has been deleted and the
 * indexer has not seen the event yet — both of the places the title and the poster lived.
 *
 * Every field is optional here: somebody may have opened this address directly, or come back
 * to it from history, and a missing poster must not cost them the publish and the link.
 */
type Handover = Partial<Omit<CreatedEvent, 'eventId'>>;

const ALL_SAVED: FollowUpResult = { artSaved: true, venueSaved: true };

/**
 * The publish (Draft → Published) this screen now runs itself, so completion and sharing are one
 * screen with no navigation between them (T-SIMP-6). `saving` is the wait; only at `done` — the
 * event is public — do the share link and the QR appear, in place.
 */
type PublishState = 'idle' | 'saving' | 'done';

export function Created() {
  const scene = useOrganizerCopy().scene;
  const life = useOrganizerCopy().lifecycle;
  const common = useCopy().common;
  const copy = scene.done;
  const { eventId = '' } = useParams();
  const handed = (useLocation().state ?? {}) as Handover;
  const [dataUrl, setDataUrl] = useState('');
  const [copied, setCopied] = useState('');
  // What the publish path managed to write. Nothing handed over means nothing was missing —
  // somebody opened this address from history, and there is no draft left to repair.
  const [saved, setSaved] = useState<FollowUpResult>(handed.done ?? ALL_SAVED);
  const [retrying, setRetrying] = useState(false);
  // Publishing is the whole point of this screen now: it starts idle, and the link and the QR
  // stay hidden until it reaches `done`.
  const [publishing, setPublishing] = useState<PublishState>('idle');
  const [problem, setProblem] = useState<LifecycleProblem | ''>('');
  const published = publishing === 'done';
  const plan = handed.plan;
  const missing = plan !== undefined && !followUpsDone(plan, saved);

  // The address an attendee would open, absolute — it is going into a message or onto a poster.
  const link = `${window.location.origin}/events/${eventId}`;

  useEffect(() => {
    let live = true;
    // `qrcode` is loaded on demand so it is not part of the main chunk; the QR image is drawn
    // ready ahead of time and simply revealed with the link once the event is public.
    void import('qrcode')
      .then(({ default: QRCode }) => QRCode.toDataURL(link, { width: QR_WIDTH, margin: 1 }))
      .then((url) => {
        if (live) setDataUrl(url);
      })
      // A QR that would not draw costs the picture and nothing else: the address is on screen
      // in full either way, and it is the address that is the answer.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [link]);

  /**
   * Runs only the writes that have not landed, against the id the event already has. Both
   * callables replace their document rather than merging, so pressing this twice is the same
   * as pressing it once — and the draft, which is the only place the hidden venue still
   * exists, is not deleted until they have both gone through.
   */
  async function retry(): Promise<void> {
    if (plan === undefined) return;
    setRetrying(true);
    const next = await runFollowUps(plan, saved);
    setSaved(next);
    if (followUpsDone(plan, next) && handed.draftId) {
      await forgetEventDraft(handed.draftId).catch(() => undefined);
    }
    setRetrying(false);
  }

  /**
   * 지금 공개하기 — Draft → Published, run right here so the share link appears on the very same
   * screen with no navigation (T-SIMP-6). The organisation is read off the chain, not the indexer,
   * because the paymaster is paid per organisation and an indexer running behind would name the
   * wrong one. `publishEvent` replaces rather than adds, so a second press after a timeout is safe.
   */
  async function goPublic(): Promise<void> {
    if (publishing === 'saving') return;
    setProblem('');
    setPublishing('saving');
    const orgId = await readTicket().eventOrg(BigInt(eventId)).catch(() => null);
    if (orgId === null || orgId === 0n) {
      setPublishing('idle');
      setProblem('failed');
      return;
    }
    const result = await publishEvent(BigInt(eventId), orgId);
    if (result.state === 'done') {
      setPublishing('done');
    } else {
      setPublishing('idle');
      setProblem(result.problem);
    }
  }

  async function copyLink(): Promise<void> {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(copy.copied);
    } catch {
      // A browser without clipboard permission, or an insecure origin. The address is right
      // there to select by hand, so this says that rather than pretending it worked.
      setCopied(copy.copyFailed);
    }
  }

  return (
    <Screen title={copy.title}>
      <div className="scene">
        {/* 2단계 헤더: 만들기는 끝났고 공개가 이 화면에서 이어진다(계획 §2b). */}
        <Steps labels={[scene.stepCreate, scene.stepPublish]} at={1} />
        <SuccessCheck />
        {handed.posterCid ? (
          <div className="poster-card">
            <div className="poster-card__filled">
              <img src={posterUrl(handed.posterCid)} alt="" />
            </div>
          </div>
        ) : null}
        <h2>{handed.title || copy.untitled}</h2>

        {/* Independent of publishing: the two follow-up writes may have missed, and the retry that
            repairs them lives on this screen — pressing it again is safe. */}
        {missing ? (
          <>
            <Alert tone="warn">{copy.artFailed}</Alert>
            <Button variant="ghost" disabled={retrying} onClick={() => void retry()}>
              {retrying ? copy.retryWorking : copy.retry}
            </Button>
          </>
        ) : null}
        {!missing && handed.followUpFailed ? <p className="muted">{copy.retryDone}</p> : null}

        {published ? (
          <>
            {/* 되돌아가기 0: the very screen the publish ran on now carries the link and the QR. */}
            <Alert tone="info">{copy.nowPublic}</Alert>
            <Card title={copy.link}>
              <p className="event-link">{link}</p>
              {copied !== '' ? <p className="muted">{copied}</p> : null}
              {dataUrl !== '' ? <img className="event-qr" src={dataUrl} alt={copy.qr} /> : null}
            </Card>
            <p>
              <Link to={`/events/${eventId}`}>{copy.view}</Link>
            </p>
          </>
        ) : (
          <>
            {/* Before it is public the link and the QR are deliberately absent: an address nobody
                can open yet is a false promise, and `claim` refuses anything but Published. */}
            {/* 공개 전 상태는 입력창처럼 보이던 info 박스가 아니라 상태 칩으로 읽힌다(visual R1-9). */}
            <p>
              <span className="badge">{copy.notYetPublic}</span>
            </p>
            {publishing === 'saving' ? (
              <OpProgress phase="saving" />
            ) : (
              // 안심어: 공개도 무료고, 어려운 건 MONTI가 대신 처리한다(T-SIMP-6). 주행동은 하단 바로.
              <p className="muted">{common.montiHandles}</p>
            )}
            {problem !== '' ? <Alert tone="error">{life[problem]}</Alert> : null}
          </>
        )}

        <p>
          <Link to={`/org/events/${eventId}`}>{copy.manage}</Link>
        </p>
        <p>
          <Link to="/org">{copy.home}</Link>
        </p>

        {/* 주행동은 하단 바로 내려가 화면 아래 절반이 비지 않게 한다(visual R1-5): 공개 전에는 지금
            공개하기(공개 중에는 잠김), 공개 뒤에는 링크 복사. */}
        <StickyBar>
          {published ? (
            <Button onClick={() => void copyLink()}>{copy.copy}</Button>
          ) : (
            <Button
              onClick={() => void goPublic()}
              disabled={publishing === 'saving'}
            >
              {copy.publishNow}
            </Button>
          )}
        </StickyBar>
      </div>
    </Screen>
  );
}
