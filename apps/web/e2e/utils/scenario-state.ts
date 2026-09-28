import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Cross-scenario state, persisted to disk so a scenario survives a Playwright worker restart.
 *
 * `10-personas.spec.ts` used to keep event ids, the persona sessions and the claim ledger in
 * `describe`-scope `let`s. When one scenario fails Playwright restarts the worker (it re-imports
 * the module), those `let`s reset to their initial values, and every later scenario read
 * `undefined`/`''` and fell over in a millisecond — "unevaluated", not a real failure
 * (task-claim-failure-report §6). Live browser contexts cannot be serialised, but the *facts* a
 * later scenario needs can: the event ids by kind, whether each is published, the persona
 * phone→uid/account map, and the claim ledger. Those live here, in `e2e/.state/scenario.json`,
 * written after each step and read at the start of each scenario. Sessions themselves are
 * reconstructed from the already-persisted per-persona passkey state (see session.ts).
 */
const STATE_DIR = 'e2e/.state';
export const SCENARIO_STATE_PATH = `${STATE_DIR}/scenario.json`;

export type EventKind = 'free' | 'soldOut' | 'approval';

export interface EventRecord {
  id: string;
  published: boolean;
  title?: string;
}

/** What we can observe per persona. `phone` is always known; `uid`/`account` are best-effort. */
export interface PersonaRecord {
  phone?: string;
  uid?: string;
  account?: string;
  signedUp?: boolean;
}

export interface ClaimRecord {
  personaId: string;
  eventId: string;
  outcome: string;
  /** Ticket rows visible in 내 티켓 after the claim, when the scenario counted them. */
  ticketCount?: number;
  at: string;
}

export interface ScenarioState {
  events: Partial<Record<EventKind, EventRecord>>;
  /** Keyed by persona id (persona-01 … persona-10). */
  personas: Record<string, PersonaRecord>;
  /** Keyed by `${personaId}:${eventId}` — the claim ledger. */
  claims: Record<string, ClaimRecord>;
}

function empty(): ScenarioState {
  return { events: {}, personas: {}, claims: {} };
}

/** Read the persisted state, or an empty scaffold if it is missing or unreadable. Never throws. */
export function loadScenarioState(): ScenarioState {
  try {
    if (!existsSync(SCENARIO_STATE_PATH)) return empty();
    const parsed = JSON.parse(readFileSync(SCENARIO_STATE_PATH, 'utf8')) as Partial<ScenarioState>;
    return {
      events: parsed.events ?? {},
      personas: parsed.personas ?? {},
      claims: parsed.claims ?? {},
    };
  } catch {
    return empty();
  }
}

/** Persist the state. A state write must never be the reason a scenario fails, so it swallows. */
export function saveScenarioState(state: ScenarioState): void {
  try {
    mkdirSync(dirname(SCENARIO_STATE_PATH), { recursive: true });
    writeFileSync(SCENARIO_STATE_PATH, JSON.stringify(state, null, 2));
  } catch {
    /* the harness prefers a scenario that ran to one that failed writing a breadcrumb */
  }
}

/** Record (or update) an event of a given kind and return the fresh state. */
export function recordEvent(kind: EventKind, rec: EventRecord): ScenarioState {
  const s = loadScenarioState();
  s.events[kind] = { ...s.events[kind], ...rec };
  saveScenarioState(s);
  return s;
}

/** Flip an already-recorded event's published flag. No-op if the event was never recorded. */
export function markPublished(kind: EventKind, published = true): void {
  const s = loadScenarioState();
  const current = s.events[kind];
  if (!current) return;
  s.events[kind] = { ...current, published };
  saveScenarioState(s);
}

/** Merge observed facts (phone, uid, account, signedUp) into a persona's record. */
export function recordPersona(personaId: string, rec: PersonaRecord): void {
  const s = loadScenarioState();
  s.personas[personaId] = { ...s.personas[personaId], ...rec };
  saveScenarioState(s);
}

/** Append a claim to the ledger, keyed by persona+event so a re-claim overwrites its own row. */
export function recordClaim(rec: ClaimRecord): void {
  const s = loadScenarioState();
  s.claims[`${rec.personaId}:${rec.eventId}`] = rec;
  saveScenarioState(s);
}

export function getEvent(kind: EventKind): EventRecord | undefined {
  return loadScenarioState().events[kind];
}

export function getClaim(personaId: string, eventId: string): ClaimRecord | undefined {
  return loadScenarioState().claims[`${personaId}:${eventId}`];
}
