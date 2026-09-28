import { vi } from 'vitest';
import type { TicketArtSource } from '../../src/shared/ui';

/**
 * The stand-in for `eventArt/{eventId}` in tests. `EventDetail` reads the ticket picture for its
 * hero through `loadEventArt`, which in jsdom would reach real Firestore; every EventDetail test
 * shares this one mock so none of them has to know the read is there. It answers `[]` — no stored
 * art, the ordinary case for an event that never went through `saveEventArt` — so the hero falls
 * back to the poster. A test that wants a picture arms it with `loadEventArt.mockResolvedValueOnce`.
 */
export const loadEventArt = vi.fn<(eventId: string) => Promise<TicketArtSource[]>>(async () => []);
