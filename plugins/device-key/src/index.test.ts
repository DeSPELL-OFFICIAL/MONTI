import { describe, expect, it, vi } from 'vitest';

interface RegisterOptions {
  web: () => Promise<unknown>;
}
const registerPlugin = vi.fn<(name: string, options: RegisterOptions) => unknown>(() => ({}));
vi.mock('@capacitor/core', () => ({ registerPlugin, WebPlugin: class {} }));

const { DeviceKey } = await import('./index');

describe('DeviceKey registration', () => {
  it('registers under the name the native classes declare', () => {
    expect(DeviceKey).toBeDefined();
    expect(registerPlugin.mock.calls[0]![0]).toBe('DeviceKey');
  });

  it('loads the web implementation lazily so a native build never pulls it in', async () => {
    const web = await registerPlugin.mock.calls[0]![1].web();
    expect(web).toBeInstanceOf((await import('./web')).DeviceKeyWeb);
  });
});
