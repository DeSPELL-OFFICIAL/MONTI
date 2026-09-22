import { useCallback, useEffect, useRef, useState } from 'react';
import {
  deleteEventDraft, listEventDrafts, saveEventDraft,
  type EventDraft, type EventDraftCurrency, type EventDraftTier, type StoredEventDraft,
} from '../shared/api/firestore';

/**
 * Autosave for the event creation scene.
 *
 * There are four moments a draft is written, and each covers a hole the others leave.
 * Two seconds after the last change is the ordinary one — a debounce, so a sentence being
 * typed is one write rather than thirty. Ten minutes is for the organiser who holds a single
 * field open all afternoon and never gives the debounce a quiet second. `visibilitychange`
 * and `pagehide` are the ones that actually fire on a phone: iOS Safari does not reliably
 * run `beforeunload`, which is kept anyway as the desktop backstop.
 *
 * `localStorage` holds a mirror of whatever is on screen, written on every keystroke. That is
 * the copy that survives being offline or a login that expired mid-sentence, because neither
 * of those lets a Firestore write through; Firestore is what lets the same draft be finished
 * on another device.
 */

/** One mirror per device: the scene edits one draft at a time. Not the wizard's old key. */
export const EVENT_DRAFT_KEY = 'monti.eventDraft';

export const DRAFT_DEBOUNCE_MS = 2_000;
export const DRAFT_INTERVAL_MS = 10 * 60 * 1_000;

/** Kept by the client, because a security rule cannot count the documents in a collection. */
export const MAX_EVENT_DRAFTS = 5;

/** What the security rule caps the list at, so a sixth tag is a refusal, not a message. */
const MAX_TAGS = 5;

/** The four themes the discover filter offers, and the region the wizard has always started on. */
const DEFAULT_CATEGORY = 0;
const DEFAULT_REGION = 'KR-11';

/** Named in the plan as one of the four bundled artworks; the set itself belongs to TicketArt. */
const DEFAULT_DESIGN = 'aurora';

const CURRENCIES: readonly EventDraftCurrency[] = ['free', 'MON', 'USDT', 'USDC'];

export const emptyEventDraftTier: EventDraftTier = {
  name: '', supply: 100, maxPerWallet: 1,
  currency: 'free', amount: 0,
  design: DEFAULT_DESIGN, imageCid: '',
};

export const emptyEventDraft: EventDraft = {
  orgId: '', title: '', description: '', posterCid: '',
  category: DEFAULT_CATEGORY, tags: [],
  regionCode: DEFAULT_REGION, venue: '', venueHidden: false,
  startsAt: 0, endsAt: 0, timeHidden: false,
  transferable: true, transferCutoffHours: 2, requireKyc: false,
  tiers: [emptyEventDraftTier],
  submittedOpHash: '',
};

export type EventDraftStatus = 'saved' | 'saving' | 'error';

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function count(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function currency(value: unknown): EventDraftCurrency {
  return CURRENCIES.find((known) => known === value) ?? emptyEventDraftTier.currency;
}

function toTier(raw: unknown): EventDraftTier {
  const tier = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<EventDraftTier>;
  return {
    name: text(tier.name, ''),
    supply: count(tier.supply, 0),
    maxPerWallet: count(tier.maxPerWallet, 0),
    currency: currency(tier.currency),
    amount: count(tier.amount, 0),
    design: text(tier.design, DEFAULT_DESIGN),
    imageCid: text(tier.imageCid, ''),
  };
}

/**
 * Structure only — the words are the scene's business. What is enforced here is what the
 * security rule enforces: a list of strings, at most five of them. A sixth would not be a
 * message under the field, it would be a permission error on the whole document.
 */
function toTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const tags = raw.filter((tag): tag is string => typeof tag === 'string' && tag !== '');
  return [...new Set(tags)].slice(0, MAX_TAGS);
}

/**
 * A stored draft is whatever was in Firestore or on this device, which is to say: anything.
 * Every field is read back at its own type, so a half-written or hand-edited document loses
 * the one field it broke rather than handing the publish path a string where the struct
 * wants a number.
 */
export function normalizeEventDraft(raw: unknown): EventDraft {
  const saved = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<EventDraft>;
  const tiers = Array.isArray(saved.tiers) ? saved.tiers.map(toTier) : emptyEventDraft.tiers;
  return {
    orgId: text(saved.orgId, emptyEventDraft.orgId),
    title: text(saved.title, emptyEventDraft.title),
    description: text(saved.description, emptyEventDraft.description),
    posterCid: text(saved.posterCid, emptyEventDraft.posterCid),
    category: count(saved.category, emptyEventDraft.category),
    tags: toTags(saved.tags),
    regionCode: text(saved.regionCode, emptyEventDraft.regionCode),
    venue: text(saved.venue, emptyEventDraft.venue),
    venueHidden: flag(saved.venueHidden, emptyEventDraft.venueHidden),
    startsAt: count(saved.startsAt, emptyEventDraft.startsAt),
    endsAt: count(saved.endsAt, emptyEventDraft.endsAt),
    timeHidden: flag(saved.timeHidden, emptyEventDraft.timeHidden),
    transferable: flag(saved.transferable, emptyEventDraft.transferable),
    transferCutoffHours: count(saved.transferCutoffHours, emptyEventDraft.transferCutoffHours),
    requireKyc: flag(saved.requireKyc, emptyEventDraft.requireKyc),
    tiers: tiers.length > 0 ? tiers : emptyEventDraft.tiers,
    submittedOpHash: text(saved.submittedOpHash, emptyEventDraft.submittedOpHash),
  };
}

/** The device copy, carrying the id so it is a mirror of one document rather than a stray. */
interface MirroredDraft {
  id: string;
  draft: EventDraft;
}

function readMirror(): MirroredDraft | null {
  try {
    const raw = localStorage.getItem(EVENT_DRAFT_KEY);
    if (raw === null) return null;
    const saved = JSON.parse(raw) as { id?: unknown; draft?: unknown };
    const id = text(saved.id, '');
    return id === '' ? null : { id, draft: normalizeEventDraft(saved.draft) };
  } catch {
    // Private mode, a full quota, or a copy somebody edited by hand: start clean.
    return null;
  }
}

function writeMirror(id: string, draft: EventDraft): void {
  try {
    localStorage.setItem(EVENT_DRAFT_KEY, JSON.stringify({ id, draft }));
  } catch {
    // The scene still works for this session; only the offline proofing is lost.
  }
}

function clearMirror(): void {
  try {
    localStorage.removeItem(EVENT_DRAFT_KEY);
  } catch {
    /* private mode */
  }
}

function newDraftId(): string {
  return crypto.randomUUID();
}

/** The organisation comes from the route, so it outranks whatever the stored draft remembers. */
function withOrg(draft: EventDraft, orgId: string): EventDraft {
  return orgId === '' || draft.orgId === orgId ? draft : { ...draft, orgId };
}

/**
 * At most {@link MAX_EVENT_DRAFTS} documents survive, `room` of them held free for the draft
 * the caller is about to start. The oldest go, because the newest is the one being resumed.
 * A refused delete is swallowed: a draft too many is not worth failing the scene over.
 */
async function pruneDrafts(stored: StoredEventDraft[], room: number): Promise<void> {
  const doomed = stored.slice(Math.max(0, MAX_EVENT_DRAFTS - room));
  await Promise.all(doomed.map((entry) => deleteEventDraft(entry.id).catch(() => undefined)));
}

export interface EventDraftState {
  draft: EventDraft;
  /** The document this scene writes to. Assigned before the first keystroke, never after. */
  draftId: string;
  /** True until the newest stored draft has been read back. The fields are usable throughout. */
  loading: boolean;
  /** True when the open draft came back from storage — what `이어서 쓰는 중` is shown for. */
  resumed: boolean;
  status: EventDraftStatus;
  /** Epoch ms of the last write that landed; 0 when nothing has been written yet. */
  savedAt: number;
  patch: (next: Partial<EventDraft>) => void;
  /** Writes now if anything is unsaved. Resolves once the attempt is over, refused or not. */
  save: () => Promise<void>;
  /** Deletes the document and the device copy, and opens an empty draft in its place. */
  discard: () => Promise<void>;
}

export function useEventDraft(orgId: string, wantedId?: string): EventDraftState {
  const [mirrored] = useState(readMirror);
  // `/org/new/<id>` names the document to open — coming back from SCENE 2, or resuming from
  // another tab. The device copy is only the right thing to show when it mirrors *that*
  // document; for any other id the fields start empty and the read below fills them.
  const [opened] = useState(() =>
    (wantedId === undefined || mirrored?.id === wantedId ? mirrored : null));
  const [draft, setDraft] = useState<EventDraft>(() =>
    withOrg(opened?.draft ?? emptyEventDraft, orgId));
  // The id is minted here rather than after the round trip, so a draft typed into while
  // Firestore is still answering already knows which document it is the mirror of.
  const [draftId, setDraftId] = useState<string>(() => opened?.id ?? wantedId ?? newDraftId());
  const [loading, setLoading] = useState(true);
  const [resumed, setResumed] = useState(false);
  const [status, setStatus] = useState<EventDraftStatus>('saved');
  const [savedAt, setSavedAt] = useState(0);

  const draftRef = useRef(draft);
  const idRef = useRef(draftId);
  /**
   * The id whose *contents* are on screen, which is not always {@link idRef}: opening
   * `/org/new/<id>` with no device copy of that draft mints the id first and reads the fields
   * a moment later. `''` means nothing has been opened, so the read below always lands.
   */
  const openedIdRef = useRef(opened?.id ?? '');
  const orgRef = useRef(orgId);
  /** Unsaved changes are waiting. Set on every change, cleared by a write that landed. */
  const dirtyRef = useRef(false);
  /** This session changed something. An untouched scene has no document worth creating. */
  const touchedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const liveRef = useRef(true);
  /** Writes run one after another, so a ten-minute tick cannot race the debounce it overtook. */
  const chainRef = useRef<Promise<void>>(Promise.resolve());

  const clearTimer = useCallback((): void => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const writeNow = useCallback(async (force: boolean): Promise<void> => {
    if (!touchedRef.current) return;
    if (!dirtyRef.current && !force) return;
    const id = idRef.current;
    const body = draftRef.current;
    dirtyRef.current = false;
    if (liveRef.current) setStatus('saving');
    try {
      await saveEventDraft(id, body);
      if (!liveRef.current) return;
      setStatus('saved');
      setSavedAt(Date.now());
    } catch {
      // The write did not land — offline, or a login that expired. The change is still
      // unsaved, so the next trigger tries it again rather than dropping it.
      dirtyRef.current = true;
      if (liveRef.current) setStatus('error');
    }
  }, []);

  const runSave = useCallback((force: boolean): Promise<void> => {
    clearTimer();
    chainRef.current = chainRef.current.then(() => writeNow(force));
    return chainRef.current;
  }, [clearTimer, writeNow]);

  const patch = useCallback((next: Partial<EventDraft>): void => {
    const merged = { ...draftRef.current, ...next };
    draftRef.current = merged;
    // The device copy is written here, synchronously, and not two seconds later: this is the
    // copy that has to be right at the instant the tab is closed.
    writeMirror(idRef.current, merged);
    setDraft(merged);
    touchedRef.current = true;
    dirtyRef.current = true;
    clearTimer();
    timerRef.current = setTimeout(() => { void runSave(false); }, DRAFT_DEBOUNCE_MS);
  }, [clearTimer, runSave]);

  const discard = useCallback(async (): Promise<void> => {
    clearTimer();
    dirtyRef.current = false;
    touchedRef.current = false;
    const gone = idRef.current;
    clearMirror();
    const fresh = withOrg(emptyEventDraft, orgRef.current);
    draftRef.current = fresh;
    if (liveRef.current) {
      setDraft(fresh);
      setResumed(false);
      setStatus('saved');
      setSavedAt(0);
    }
    try {
      await deleteEventDraft(gone);
    } catch {
      // The document stays. A draft nobody wanted is a smaller loss than one nobody can get
      // back, and the next open resumes it rather than losing an afternoon of typing.
    }
    let stored: StoredEventDraft[] = [];
    try {
      stored = await listEventDrafts();
    } catch {
      /* offline: the cap is kept the next time this account is online */
    }
    await pruneDrafts(stored, 1);
    const next = newDraftId();
    idRef.current = next;
    openedIdRef.current = next;
    if (liveRef.current) setDraftId(next);
  }, [clearTimer]);

  useEffect(() => {
    orgRef.current = orgId;
  }, [orgId]);

  useEffect(() => {
    liveRef.current = true;
    void (async () => {
      let stored: StoredEventDraft[] = [];
      try {
        stored = await listEventDrafts();
      } catch {
        // Offline, or a login that expired between the scene opening and this read. The
        // device copy is already on screen and the next write decides the rest.
      }
      if (!liveRef.current) return;
      // The named document when the route named one; otherwise whichever was written last.
      const newest = wantedId === undefined
        ? stored[0]
        : stored.find((entry) => entry.id === wantedId);
      if (newest !== undefined && !touchedRef.current && newest.id !== openedIdRef.current) {
        // Another device got further than this one. Typing that has already happened here
        // outranks it, which is why `touchedRef` is asked first.
        const resumedDraft = withOrg(normalizeEventDraft(newest.data), orgRef.current);
        draftRef.current = resumedDraft;
        idRef.current = newest.id;
        openedIdRef.current = newest.id;
        writeMirror(newest.id, resumedDraft);
        setDraft(resumedDraft);
        setDraftId(newest.id);
      }
      setResumed(opened !== null || newest !== undefined);
      setLoading(false);
      // Nothing is being added here — the resumed draft is one of these — so the whole cap
      // is available to keep.
      await pruneDrafts(stored, 0);
    })();
    return () => {
      liveRef.current = false;
      // Leaving for SCENE 2 must not cost the last two seconds of typing.
      void runSave(false);
      clearTimer();
    };
  }, [clearTimer, opened, runSave, wantedId]);

  useEffect(() => {
    const tick = setInterval(() => { void runSave(true); }, DRAFT_INTERVAL_MS);
    return () => clearInterval(tick);
  }, [runSave]);

  useEffect(() => {
    const flush = (): void => { void runSave(false); };
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') flush();
    };
    // The write is asynchronous and a page being torn down may not live to see it finish;
    // the device copy written on every keystroke is what makes that survivable.
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('beforeunload', flush);
    };
  }, [runSave]);

  const save = useCallback((): Promise<void> => runSave(false), [runSave]);

  return { draft, draftId, loading, resumed, status, savedAt, patch, save, discard };
}
