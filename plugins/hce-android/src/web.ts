import { WebPlugin } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';
import type { HcePlugin } from './definitions';

/**
 * There is no software fallback, deliberately. A browser cannot emulate a card, and iOS
 * hands card emulation to Apple Pay alone, so anything this class could "succeed" at would
 * be a tag that never answers — the staff would watch attendees tap a phone that is not
 * listening. Every method rejects with `UNAVAILABLE`, which is the caller's cue to show
 * the QR fallback instead of a retry.
 */
const MESSAGE = 'HCE is Android-only; this build has no card emulation.';

export class HceWeb extends WebPlugin implements HcePlugin {
  async start(): Promise<void> {
    throw this.unavailable(MESSAGE);
  }

  async setPayload(): Promise<void> {
    throw this.unavailable(MESSAGE);
  }

  async stop(): Promise<void> {
    throw this.unavailable(MESSAGE);
  }

  /** Refuses too: a listener that silently never fires is the worst failure at a gate. */
  async addListener(): Promise<PluginListenerHandle> {
    throw this.unavailable(MESSAGE);
  }
}
