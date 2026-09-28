import { act, renderHook, type RenderHookResult } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventDraft, StoredEventDraft } from '../shared/api/firestore';
import type { EventDraftState } from './useEventDraft';

const listEventDrafts = vi.fn();
const saveEventDraft = vi.fn();
const deleteEventDraft = vi.fn();

vi.mock('../shared/api/firestore', () => ({ listEventDrafts, saveEventDraft, deleteEventDraft }));

const {
  DRAFT_DEBOUNCE_MS, DRAFT_INTERVAL_MS, EVENT_DRAFT_KEY, MAX_EVENT_DRAFTS,
  emptyEventDraft, freshEventDraft, normalizeEventDraft, useEventDraft,
} = await import('./useEventDraft');

/**
 * A Firestore that is a list in memory. The hook resumes the newest document, keeps the
 * collection at its cap and deletes on discard, none of which can be seen in a call count
 * alone — so the fake stores what it was handed and answers the next read with it.
 */
let store: StoredEventDraft[] = [];

function seed(ids: string[], draft: Partial<EventDraft> = {}): void {
  // Newest first on the way in; the fake sorts, so the stamps run the other way.
  store = ids.map((id, index) => ({
    id, updatedAt: 1_000 - index, data: { ...draft, title: `${draft.title ?? '초안'} ${id}` },
  }));
}

function ids(): string[] {
  return [...store].sort((left, right) => right.updatedAt - left.updatedAt).map((row) => row.id);
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  store = [];
  listEventDrafts.mockImplementation(async () =>
    [...store].sort((left, right) => right.updatedAt - left.updatedAt));
  saveEventDraft.mockImplementation(async (id: string, draft: EventDraft) => {
    store = [...store.filter((row) => row.id !== id), { id, updatedAt: Date.now(), data: draft }];
  });
  deleteEventDraft.mockImplementation(async (id: string) => {
    store = store.filter((row) => row.id !== id);
  });
});

async function advance(ms: number): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

/** Lets the mount read settle, so the assertions see the draft the scene actually opened on. */
async function openDraft(orgId = '9'): Promise<RenderHookResult<EventDraftState, unknown>> {
  const view = renderHook(() => useEventDraft(orgId));
  await advance(0);
  await advance(0);
  return view;
}

describe('when the draft is written', () => {
  it('collapses a burst of typing into one write two seconds after the last change', async () => {
    const view = await openDraft();

    act(() => view.result.current.patch({ title: '재' }));
    await advance(1_500);
    act(() => view.result.current.patch({ title: '재즈' }));
    await advance(1_500);
    act(() => view.result.current.patch({ title: '재즈 나이트' }));
    await advance(DRAFT_DEBOUNCE_MS - 1);
    // Three changes over three and a half seconds, and nothing has been written: the timer
    // starts again on every change, which is what makes this a debounce and not a throttle.
    expect(saveEventDraft).not.toHaveBeenCalled();

    await advance(1);
    expect(saveEventDraft).toHaveBeenCalledTimes(1);
    const [, written] = saveEventDraft.mock.calls[0] as [string, EventDraft];
    expect(written.title).toBe('재즈 나이트');
  });

  it('writes again ten minutes later with nothing further typed', async () => {
    const view = await openDraft();
    act(() => view.result.current.patch({ title: '재즈 나이트' }));
    await advance(DRAFT_DEBOUNCE_MS);
    expect(saveEventDraft).toHaveBeenCalledTimes(1);

    // The organiser who holds one field open all afternoon never gives the debounce its
    // quiet second, so the interval is the only thing that saves them.
    await advance(DRAFT_INTERVAL_MS);
    expect(saveEventDraft).toHaveBeenCalledTimes(2);
  });

  it('flushes a pending save the moment the page is hidden', async () => {
    const view = await openDraft();
    act(() => view.result.current.patch({ title: '재즈 나이트' }));

    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(saveEventDraft).toHaveBeenCalledTimes(1);

    // The debounce that was still running is cancelled, not left to write the same draft again.
    await advance(DRAFT_DEBOUNCE_MS);
    expect(saveEventDraft).toHaveBeenCalledTimes(1);
    Reflect.deleteProperty(document, 'visibilityState');
  });

  it('flushes on pagehide and on beforeunload, the two unload events that disagree', async () => {
    const first = await openDraft();
    act(() => first.result.current.patch({ title: '재즈 나이트' }));
    await act(async () => {
      window.dispatchEvent(new Event('pagehide'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(saveEventDraft).toHaveBeenCalledTimes(1);

    act(() => first.result.current.patch({ title: '재즈 나이트 2' }));
    await act(async () => {
      window.dispatchEvent(new Event('beforeunload'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(saveEventDraft).toHaveBeenCalledTimes(2);
  });

  it('writes nothing at all while the scene sits untouched', async () => {
    await openDraft();
    await advance(DRAFT_INTERVAL_MS * 2);
    expect(saveEventDraft).not.toHaveBeenCalled();
  });
});

describe('what the status line is told', () => {
  it('walks saving to saved and stamps the time it landed', async () => {
    let land = (): void => undefined;
    saveEventDraft.mockImplementation(async () => new Promise<void>((resolve) => { land = resolve; }));

    const view = await openDraft();
    expect(view.result.current.status).toBe('saved');
    expect(view.result.current.savedAt).toBe(0);

    act(() => view.result.current.patch({ title: '재즈 나이트' }));
    await advance(DRAFT_DEBOUNCE_MS);
    expect(view.result.current.status).toBe('saving');

    await act(async () => { land(); await vi.advanceTimersByTimeAsync(0); });
    expect(view.result.current.status).toBe('saved');
    expect(view.result.current.savedAt).toBeGreaterThan(0);
  });

  it('says so when the write is refused, and keeps the change for the next attempt', async () => {
    const view = await openDraft();
    saveEventDraft.mockRejectedValue(new Error('permission-denied'));

    act(() => view.result.current.patch({ title: '재즈 나이트' }));
    await advance(DRAFT_DEBOUNCE_MS);
    expect(view.result.current.status).toBe('error');

    // The change is still unsaved, so the next trigger sends it again rather than dropping it.
    saveEventDraft.mockResolvedValue(undefined);
    await act(async () => { await view.result.current.save(); });
    expect(saveEventDraft).toHaveBeenCalledTimes(2);
    expect(view.result.current.status).toBe('saved');
  });
});

describe('opening the scene', () => {
  it('resumes the newest stored draft without asking', async () => {
    seed(['newest', 'older']);
    const view = await openDraft();

    expect(view.result.current.draftId).toBe('newest');
    expect(view.result.current.draft.title).toBe('초안 newest');
    expect(view.result.current.resumed).toBe(true);
    // The route says which organisation this is, so it outranks what the document remembers.
    expect(view.result.current.draft.orgId).toBe('9');
  });

  /**
   * The resume sheet dates the draft it is asking about, and the server's clock is the one that
   * survives a phone whose own time is wrong — so `updatedAt` is what comes back, not `Date.now`.
   */
  it('dates the resumed draft by the stamp the server wrote', async () => {
    store = [{ id: 'kept', updatedAt: 1_711_000_000_000, data: { title: '지난 초안' } }];
    const view = await openDraft();
    expect(view.result.current.resumedAt).toBe(1_711_000_000_000);
  });

  it('dates a draft only this device has by the device copy, because there is nothing else', async () => {
    localStorage.setItem(EVENT_DRAFT_KEY, JSON.stringify({
      id: 'local-1', draft: { title: '오프라인에서 쓴 제목' }, at: 1_700_000_000_000,
    }));
    listEventDrafts.mockRejectedValue(new Error('offline'));

    const view = await openDraft();
    expect(view.result.current.resumedAt).toBe(1_700_000_000_000);
  });

  /**
   * T-EV-W12. `/org/new` starts a creation; an abandoned edit draft belongs to the event it
   * was opened from, and resuming it there would put 만들기 in front of somebody else's event
   * and then send `updateEventMeta` to it.
   */
  it('never carries on with an abandoned edit draft at the create entry point', async () => {
    store = [
      { id: 'edit-7', updatedAt: 2_000, data: { title: '고치던 행사', editingEventId: '7' } },
      { id: 'mine', updatedAt: 1_000, data: { title: '내 초안' } },
    ];
    const view = await openDraft();

    expect(view.result.current.draftId).toBe('mine');
    expect(view.result.current.draft.title).toBe('내 초안');

    // Nor from the device copy, which is the other way the newest draft comes back.
    localStorage.setItem(EVENT_DRAFT_KEY, JSON.stringify({
      id: 'edit-7', draft: { title: '고치던 행사', editingEventId: '7' },
    }));
    store = [];
    listEventDrafts.mockRejectedValue(new Error('offline'));
    const fresh = await openDraft();
    expect(fresh.result.current.draft.editingEventId).toBe('');
    expect(fresh.result.current.draftId).not.toBe('edit-7');
  });

  it('opens an edit draft by name, because the address asked for that one', async () => {
    store = [{ id: 'edit-7', updatedAt: 2_000, data: { title: '고치던 행사', editingEventId: '7' } }];
    const view = renderHook(() => useEventDraft('', 'edit-7'));
    await advance(0);
    await advance(0);

    expect(view.result.current.draftId).toBe('edit-7');
    expect(view.result.current.draft.editingEventId).toBe('7');
  });

  it('starts empty when this account has no draft', async () => {
    const view = await openDraft();
    // A brand-new draft carries the next-Saturday start default (T-SIMP-8); everything else is empty.
    expect(view.result.current.draft).toEqual({ ...freshEventDraft(), orgId: '9' });
    expect(view.result.current.resumed).toBe(false);
    expect(view.result.current.draftId).not.toBe('');
  });

  it('shows the device copy while Firestore is unreachable', async () => {
    localStorage.setItem(EVENT_DRAFT_KEY, JSON.stringify({
      id: 'local-1', draft: { title: '오프라인에서 쓴 제목' },
    }));
    listEventDrafts.mockRejectedValue(new Error('offline'));

    const view = await openDraft();
    expect(view.result.current.draft.title).toBe('오프라인에서 쓴 제목');
    expect(view.result.current.draftId).toBe('local-1');
  });

  it('loses only the field somebody broke by hand', () => {
    const draft = normalizeEventDraft({
      title: '재즈 나이트', category: '2', startsAt: '어제', venueHidden: 'yes',
      tags: ['재즈', 7, '재즈'], tiers: 'none', posterCid: 'bafk1',
    });
    // Everything that came back at the wrong type falls back; the rest is untouched.
    expect(draft.title).toBe('재즈 나이트');
    expect(draft.posterCid).toBe('bafk1');
    expect(draft.category).toBe(emptyEventDraft.category);
    expect(draft.startsAt).toBe(0);
    expect(draft.venueHidden).toBe(false);
    expect(draft.tags).toEqual(['재즈']);
    expect(draft.tiers).toEqual(emptyEventDraft.tiers);
  });

  it('reads a ticket kind back at its own type too', () => {
    const { tiers } = normalizeEventDraft({
      tiers: [{ name: '일반', supply: '백장', currency: '원', design: 7 }],
    });
    expect(tiers[0]).toEqual({
      name: '일반', supply: 0, maxPerWallet: 0,
      currency: 'free', amount: 0, design: 'a', imageCid: '',
    });
  });
});

/**
 * Plan section F-2. The debounce, the ten minutes and the four unload events were all already
 * here; what was missing was a way to ask for a write and be told it happened.
 */
describe('임시 저장', () => {
  it('runs the pending write now rather than two seconds from now', async () => {
    const view = await openDraft();
    act(() => view.result.current.patch({ title: '재즈 나이트' }));

    await act(async () => { await view.result.current.saveNow(); });
    expect(saveEventDraft).toHaveBeenCalledTimes(1);

    // The debounce it overtook is cancelled, not left to write the same draft again.
    await advance(DRAFT_DEBOUNCE_MS);
    expect(saveEventDraft).toHaveBeenCalledTimes(1);
  });

  it('writes even when there is nothing unsaved left, because it was pressed', async () => {
    const view = await openDraft();
    act(() => view.result.current.patch({ title: '재즈 나이트' }));
    await advance(DRAFT_DEBOUNCE_MS);
    expect(saveEventDraft).toHaveBeenCalledTimes(1);

    await act(async () => { expect(await view.result.current.saveNow()).toBe(true); });
    expect(saveEventDraft).toHaveBeenCalledTimes(2);
  });

  it('answers that it did not land, so nothing claims 저장됨 over a refusal', async () => {
    const view = await openDraft();
    act(() => view.result.current.patch({ title: '재즈 나이트' }));
    saveEventDraft.mockRejectedValue(new Error('permission-denied'));

    await act(async () => { expect(await view.result.current.saveNow()).toBe(false); });
    expect(view.result.current.status).toBe('error');
  });
});

/**
 * Plan section F-4, and the whole difference between this and `discard`: somebody who starts a
 * second event has not said the first one may be thrown away.
 */
describe('starting another draft', () => {
  it('opens a new id and leaves the stored draft exactly where it was', async () => {
    seed(['kept']);
    const view = await openDraft();
    expect(view.result.current.draftId).toBe('kept');

    await act(async () => { await view.result.current.startNew(); });

    expect(view.result.current.draftId).not.toBe('kept');
    // A brand-new draft carries the next-Saturday start default (T-SIMP-8); everything else is empty.
    expect(view.result.current.draft).toEqual({ ...freshEventDraft(), orgId: '9' });
    expect(view.result.current.resumed).toBe(false);
    expect(deleteEventDraft).not.toHaveBeenCalled();
    expect(ids()).toEqual(['kept']);
  });

  it('writes what was typed into the old draft before the id changes under it', async () => {
    seed(['kept']);
    const view = await openDraft();
    act(() => view.result.current.patch({ title: '두고 가는 초안' }));
    // Still inside the debounce: the last thing typed has not been written yet.
    expect(saveEventDraft).not.toHaveBeenCalled();

    await act(async () => { await view.result.current.startNew(); });

    // Under its own id, not the new one — which is what filing it after the switch would do.
    expect(saveEventDraft).toHaveBeenCalledWith('kept', expect.objectContaining({
      title: '두고 가는 초안',
    }));
    expect((store.find((row) => row.id === 'kept')?.data as EventDraft).title).toBe('두고 가는 초안');
  });

  it('keeps the account inside the cap by pushing the oldest out, and no more', async () => {
    seed(['d1', 'd2', 'd3', 'd4', 'd5']);
    const view = await openDraft();

    await act(async () => { await view.result.current.startNew(); });

    // One slot for the draft starting now, and the oldest is what pays for it.
    expect(deleteEventDraft).toHaveBeenCalledWith('d5');
    expect(deleteEventDraft).toHaveBeenCalledTimes(1);
    act(() => view.result.current.patch({ title: '새 행사' }));
    await advance(DRAFT_DEBOUNCE_MS);
    expect(store.length).toBeLessThanOrEqual(MAX_EVENT_DRAFTS);
  });
});

describe('throwing a draft away', () => {
  it('deletes the document, clears the device copy and opens an empty one', async () => {
    seed(['newest']);
    const view = await openDraft();
    act(() => view.result.current.patch({ title: '재즈 나이트' }));
    await advance(DRAFT_DEBOUNCE_MS);
    expect(localStorage.getItem(EVENT_DRAFT_KEY)).not.toBeNull();

    await act(async () => { await view.result.current.discard(); });

    expect(deleteEventDraft).toHaveBeenCalledWith('newest');
    expect(store).toHaveLength(0);
    expect(localStorage.getItem(EVENT_DRAFT_KEY)).toBeNull();
    // A brand-new draft carries the next-Saturday start default (T-SIMP-8); everything else is empty.
    expect(view.result.current.draft).toEqual({ ...freshEventDraft(), orgId: '9' });
    expect(view.result.current.draftId).not.toBe('newest');
    expect(view.result.current.resumed).toBe(false);
  });
});

describe('the draft cap', () => {
  it('deletes the oldest so the account never holds more than five', async () => {
    seed(['d1', 'd2', 'd3', 'd4', 'd5', 'd6']);
    const view = await openDraft();

    expect(ids()).toEqual(['d1', 'd2', 'd3', 'd4', 'd5']);
    expect(deleteEventDraft).toHaveBeenCalledWith('d6');
    expect(view.result.current.draftId).toBe('d1');
    expect(store.length).toBeLessThanOrEqual(MAX_EVENT_DRAFTS);
  });

  it('gives a new draft the oldest one slot when the account is already full', async () => {
    seed(['d1', 'd2', 'd3', 'd4', 'd5']);
    const view = await openDraft();

    // Another device wrote one while this scene was open, so discarding d1 still leaves five.
    listEventDrafts.mockImplementationOnce(async () => [
      { id: 'other', updatedAt: 2_000, data: {} },
      ...store.filter((row) => row.id !== 'd1'),
    ]);
    await act(async () => { await view.result.current.discard(); });

    // d1 went because it was discarded; d5 went to leave room for the draft starting now.
    expect(deleteEventDraft).toHaveBeenCalledWith('d1');
    expect(deleteEventDraft).toHaveBeenCalledWith('d5');
    act(() => view.result.current.patch({ title: '새 행사' }));
    await advance(DRAFT_DEBOUNCE_MS);
    expect(store.length).toBeLessThanOrEqual(MAX_EVENT_DRAFTS);
  });
});
