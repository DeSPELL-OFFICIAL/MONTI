import { describe, expect, it, vi } from 'vitest';

interface RegisterOptions {
  web: () => Promise<unknown>;
}
const registerPlugin = vi.fn<(name: string, options: RegisterOptions) => unknown>(() => ({}));

/**
 * The stub carries `unavailable` because the lazy `web` factory below actually constructs
 * `HceWeb`, and `HceWeb extends WebPlugin`. A bare `class {}` would still construct, but
 * the moment this file grew a call into the instance it would fail for the wrong reason.
 * `web.test.ts` runs the same class against the real `@capacitor/core` instead.
 */
vi.mock('@capacitor/core', () => ({
  registerPlugin,
  WebPlugin: class {
    unavailable(message: string): Error {
      return Object.assign(new Error(message), { code: 'UNAVAILABLE' });
    }
  },
}));

const { Hce } = await import('./index');

describe('Hce registration', () => {
  it('registers under the name the native class declares', () => {
    expect(Hce).toBeDefined();
    expect(registerPlugin.mock.calls[0]![0]).toBe('Hce');
  });

  it('loads the web implementation lazily so a native build never pulls it in', async () => {
    const web = await registerPlugin.mock.calls[0]![1].web();
    expect(web).toBeInstanceOf((await import('./web')).HceWeb);
  });
});
