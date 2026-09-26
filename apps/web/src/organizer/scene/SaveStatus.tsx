import { useEffect, useState } from 'react';
import { fmt } from '../../shared/i18n';
import { useOrganizerCopy } from '../copy';
import type { EventDraftStatus } from '../useEventDraft';
import { timeAgo } from './relativeTime';

/** The relative time is re-read twice a minute, which is finer than the words it produces. */
const TICK_MS = 30_000;

/**
 * The left half of the sticky bar. `savedAt` being 0 is not "saved a long time ago" — it is a
 * scene nobody has typed into yet, which has no document and needs none, so it says what will
 * happen rather than claiming something was stored.
 *
 * The wording of the span itself is {@link timeAgo}'s, shared with the resume sheet: the two
 * are dating the same draft and must never disagree about when it was last written.
 */
export function SaveStatus({ status, savedAt }: { status: EventDraftStatus; savedAt: number }) {
  const copy = useOrganizerCopy().scene;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  if (status === 'saving') return <>{copy.saving}</>;
  if (status === 'error') return <>{copy.saveFailed}</>;
  if (savedAt === 0) return <>{copy.saveAuto}</>;
  return <>{fmt(copy.savedAgo, { ago: timeAgo(Math.max(now, savedAt) - savedAt, copy) })}</>;
}
