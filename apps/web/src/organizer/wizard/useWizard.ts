import { useCallback, useState } from 'react';
import type { PreparedImage, WizardDraft, WizardTier } from './buildEventMeta';

/** One draft per device. Six steps is long enough that a reload must not cost the typing. */
export const DRAFT_KEY = 'monti.wizard';

export const emptyDraft: WizardDraft = {
  orgId: '', title: '', description: '', image: null,
  venue: '', regionCode: 'KR-11', category: 0,
  startsAt: 0, endsAt: 0, saleStart: 0, saleEnd: 0,
  transferable: true, transferCutoffHours: 2, maxTransfers: 3, approvalRequired: false,
  requireKyc: false,
  tiers: [{ name: '', supply: 100, maxPerWallet: 2, seated: false }],
  gates: [],
  submittedOpHash: '',
};

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function count(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function toTier(raw: unknown): WizardTier {
  const tier = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<WizardTier>;
  return {
    name: text(tier.name, ''),
    supply: count(tier.supply, 0),
    maxPerWallet: count(tier.maxPerWallet, 0),
    seated: flag(tier.seated, false),
  };
}

function toImage(raw: unknown): PreparedImage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const image = raw as Partial<PreparedImage>;
  if (typeof image.base64 !== 'string' || typeof image.mime !== 'string') return null;
  return { base64: image.base64, mime: image.mime, fileName: text(image.fileName, '') };
}

/**
 * A stored draft is whatever was in `localStorage`, which is to say: anything. Every field is
 * read back at its own type, so a half-written or hand-edited entry loses the field it broke
 * rather than handing `buildEventMeta` a string where the struct wants a number.
 */
export function normalizeDraft(raw: unknown): WizardDraft {
  const saved = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<WizardDraft>;
  const tiers = Array.isArray(saved.tiers) ? saved.tiers.map(toTier) : emptyDraft.tiers;
  return {
    orgId: text(saved.orgId, emptyDraft.orgId),
    title: text(saved.title, emptyDraft.title),
    description: text(saved.description, emptyDraft.description),
    image: toImage(saved.image),
    venue: text(saved.venue, emptyDraft.venue),
    regionCode: text(saved.regionCode, emptyDraft.regionCode),
    category: count(saved.category, emptyDraft.category),
    startsAt: count(saved.startsAt, emptyDraft.startsAt),
    endsAt: count(saved.endsAt, emptyDraft.endsAt),
    saleStart: count(saved.saleStart, emptyDraft.saleStart),
    saleEnd: count(saved.saleEnd, emptyDraft.saleEnd),
    transferable: flag(saved.transferable, emptyDraft.transferable),
    transferCutoffHours: count(saved.transferCutoffHours, emptyDraft.transferCutoffHours),
    maxTransfers: count(saved.maxTransfers, emptyDraft.maxTransfers),
    approvalRequired: flag(saved.approvalRequired, emptyDraft.approvalRequired),
    requireKyc: flag(saved.requireKyc, emptyDraft.requireKyc),
    tiers: tiers.length > 0 ? tiers : emptyDraft.tiers,
    gates: Array.isArray(saved.gates) ? saved.gates.filter((gate): gate is string => typeof gate === 'string') : [],
    submittedOpHash: text(saved.submittedOpHash, emptyDraft.submittedOpHash),
  };
}

export function loadDraft(): WizardDraft {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    return raw === null ? emptyDraft : normalizeDraft(JSON.parse(raw));
  } catch {
    // Private mode, a full quota, or a draft somebody edited by hand: start clean.
    return emptyDraft;
  }
}

function saveDraft(draft: WizardDraft): void {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // The wizard still works for this session; only the reload-proofing is lost.
  }
}

export interface WizardState {
  draft: WizardDraft;
  patch: (next: Partial<WizardDraft>) => void;
  reset: () => void;
}

export function useWizard(): WizardState {
  const [draft, setDraft] = useState<WizardDraft>(loadDraft);

  const patch = useCallback((next: Partial<WizardDraft>): void => {
    setDraft((prev) => {
      const merged = { ...prev, ...next };
      saveDraft(merged);
      return merged;
    });
  }, []);

  const reset = useCallback((): void => {
    try {
      localStorage.removeItem(DRAFT_KEY);
    } catch {
      /* private mode */
    }
    setDraft(emptyDraft);
  }, []);

  return { draft, patch, reset };
}
