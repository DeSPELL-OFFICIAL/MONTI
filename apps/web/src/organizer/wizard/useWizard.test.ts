import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DRAFT_KEY, emptyDraft, loadDraft, normalizeDraft, useWizard } from './useWizard';

beforeEach(() => {
  localStorage.clear();
});

describe('the wizard draft survives a reload', () => {
  it('writes every change to this device and reads it back', () => {
    const first = renderHook(() => useWizard());
    act(() => first.result.current.patch({ title: '재즈 나이트', orgId: '9' }));
    act(() => first.result.current.patch({ venue: '한남동' }));

    // A reload: a second hook with no shared state, reading the same device.
    const second = renderHook(() => useWizard());
    expect(second.result.current.draft.title).toBe('재즈 나이트');
    expect(second.result.current.draft.venue).toBe('한남동');
    expect(second.result.current.draft.orgId).toBe('9');
  });

  it('clears the device when the draft is thrown away', () => {
    const { result } = renderHook(() => useWizard());
    act(() => result.current.patch({ title: '재즈 나이트' }));
    act(() => result.current.reset());
    expect(result.current.draft).toEqual(emptyDraft);
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
  });

  it('keeps working when this device refuses to store anything', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    const { result } = renderHook(() => useWizard());
    act(() => result.current.patch({ title: '재즈 나이트' }));
    expect(result.current.draft.title).toBe('재즈 나이트');
  });

  it('starts clean rather than throwing on a draft nobody can parse', () => {
    localStorage.setItem(DRAFT_KEY, '{not json');
    expect(loadDraft()).toEqual(emptyDraft);
  });
});

describe('normalizeDraft', () => {
  it('reads every field back at its own type', () => {
    const draft = normalizeDraft({
      orgId: 9, title: '재즈 나이트', category: '2', tiers: 'none', gates: ['정문', 7],
      image: { base64: 'AQID', mime: 'image/png' },
    });
    // `orgId` and `category` came back at the wrong type, so they fall back rather than
    // reaching `BigInt()` and `Number()` as something neither can take.
    expect(draft.orgId).toBe('');
    expect(draft.category).toBe(0);
    expect(draft.title).toBe('재즈 나이트');
    expect(draft.tiers).toEqual(emptyDraft.tiers);
    expect(draft.gates).toEqual(['정문']);
    expect(draft.image).toEqual({ base64: 'AQID', mime: 'image/png', fileName: '' });
  });

  it('drops an image that is missing its bytes', () => {
    expect(normalizeDraft({ image: { fileName: 'a.png' } }).image).toBeNull();
  });
});
