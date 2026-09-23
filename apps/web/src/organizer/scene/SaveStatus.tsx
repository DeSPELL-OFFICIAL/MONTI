import { useEffect, useState } from 'react';
import { fmt } from '../../shared/i18n';
import { useOrganizerCopy } from '../copy';
import type { EventDraftStatus } from '../useEventDraft';

/** The relative time is re-read twice a minute, which is finer than the words it produces. */
const TICK_MS = 30_000;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** Under a minute is `방금`; the hook's own debounce is two seconds, so that is nearly always it. */
function ago(savedAt: number, now: number, copy: { savedNow: string; savedAgo: string; agoMinutes: string; agoHours: string }): string {
  const since = Math.max(0, now - savedAt);
  if (since < MINUTE_MS) return copy.savedNow;
  const unit = since < HOUR_MS
    ? fmt(copy.agoMinutes, { count: Math.floor(since / MINUTE_MS) })
    : fmt(copy.agoHours, { count: Math.floor(since / HOUR_MS) });
  return fmt(copy.savedAgo, { ago: unit });
}

/**
 * The left half of the sticky bar. `savedAt` being 0 is not "saved a long time ago" — it is a
 * scene nobody has typed into yet, which has no document and needs none, so it says what will
 * happen rather than claiming something was stored.
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
  return <>{ago(savedAt, Math.max(now, savedAt), copy)}</>;
}
