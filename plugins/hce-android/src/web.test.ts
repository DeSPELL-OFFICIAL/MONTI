import { HCE_AID } from '@monti/shared';
import { describe, expect, it } from 'vitest';
import { HCE_ERROR, type HcePlugin } from './definitions';
import { HceWeb } from './web';

/**
 * No mock here on purpose: this runs against the real `WebPlugin`, so the `UNAVAILABLE`
 * code the caller branches on is the one Capacitor actually attaches, not one this test
 * invented. Typing the instance as the interface also asserts the class still satisfies it.
 */
describe('HceWeb', () => {
  const plugin: HcePlugin = new HceWeb();

  it('refuses start, so no build silently claims to be emulating a card', async () => {
    await expect(plugin.start({ aid: HCE_AID })).rejects.toMatchObject({
      code: HCE_ERROR.unavailable,
    });
  });

  it('refuses setPayload', async () => {
    await expect(plugin.setPayload({ ndef: 'AA==' })).rejects.toMatchObject({
      code: HCE_ERROR.unavailable,
    });
  });

  it('refuses stop', async () => {
    await expect(plugin.stop()).rejects.toMatchObject({ code: HCE_ERROR.unavailable });
  });

  it('refuses addListener too, rather than hand back a handle that never fires', async () => {
    await expect(plugin.addListener('write', () => {})).rejects.toMatchObject({
      code: HCE_ERROR.unavailable,
    });
  });

  it('says why in the message, so an unhandled rejection is readable', async () => {
    await expect(plugin.stop()).rejects.toThrow('HCE is Android-only');
  });
});
