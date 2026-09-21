import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const isNativePlatform = vi.fn(() => false);
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform } }));

const remove = vi.fn(async () => undefined);
const addListener = vi.fn(async () => ({ remove }));
vi.mock('@capacitor/app', () => ({ App: { addListener } }));

const open = vi.fn(async () => undefined);
const close = vi.fn(async () => undefined);
vi.mock('@capacitor/browser', () => ({ Browser: { open, close } }));

const {
  KYC_CALLBACK_URL, closeHostedFlow, isKycCallback, listenDeepLink, openHostedFlow,
} = await import('./deepLink');

const RETURN_URL = 'http://localhost/me/verify?didit=done&returnTo=%2Ftickets%2F42';
const assign = vi.fn();

function native(): void {
  isNativePlatform.mockReturnValue(true);
}

beforeEach(() => {
  isNativePlatform.mockReturnValue(false);
  vi.stubGlobal('location', { href: RETURN_URL, assign });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isKycCallback', () => {
  it('matches the native return address', () => {
    expect(isKycCallback(KYC_CALLBACK_URL)).toBe(true);
    expect(isKycCallback('monti://kyc/callback?x=1')).toBe(true);
  });

  it('matches the web return marker', () => {
    expect(isKycCallback(RETURN_URL)).toBe(true);
  });

  it('ignores any other address the app is opened with', () => {
    expect(isKycCallback('http://localhost/me/verify?returnTo=%2Ftickets%2F42')).toBe(false);
    expect(isKycCallback('monti://events/42')).toBe(false);
    expect(isKycCallback('http://localhost/')).toBe(false);
  });
});

describe('openHostedFlow', () => {
  it('navigates the same tab on the web', async () => {
    await openHostedFlow('https://verify.didit.me/s/abc');
    // A new tab would take the redirect with it and never bring the person back here.
    expect(assign).toHaveBeenCalledWith('https://verify.didit.me/s/abc');
    expect(open).not.toHaveBeenCalled();
  });

  it('opens a dismissable system browser on a device', async () => {
    native();
    await openHostedFlow('https://verify.didit.me/s/abc');
    expect(open).toHaveBeenCalledWith({ url: 'https://verify.didit.me/s/abc', presentationStyle: 'popover' });
    expect(assign).not.toHaveBeenCalled();
  });
});

describe('closeHostedFlow', () => {
  it('dismisses the system browser on a device', async () => {
    native();
    await closeHostedFlow();
    expect(close).toHaveBeenCalled();
  });

  it('does nothing on the web, where there is no second window to close', async () => {
    await closeHostedFlow();
    expect(close).not.toHaveBeenCalled();
  });

  it('survives a close that the platform refuses', async () => {
    native();
    close.mockRejectedValueOnce(new Error('no browser open'));
    await expect(closeHostedFlow()).resolves.toBeUndefined();
  });
});

describe('listenDeepLink', () => {
  it('hears appUrlOpen on a device and hands back the url', async () => {
    native();
    const onUrl = vi.fn();
    const stop = await listenDeepLink(onUrl);

    expect(addListener).toHaveBeenCalledWith('appUrlOpen', expect.any(Function));
    const [, handler] = addListener.mock.calls[0] as unknown as [string, (event: { url: string }) => void];
    handler({ url: KYC_CALLBACK_URL });
    expect(onUrl).toHaveBeenCalledWith(KYC_CALLBACK_URL);

    stop();
    expect(remove).toHaveBeenCalled();
  });

  it('falls back to window focus on the web and reads the address off the tab', async () => {
    const onUrl = vi.fn();
    const stop = await listenDeepLink(onUrl);

    window.dispatchEvent(new Event('focus'));
    expect(onUrl).toHaveBeenCalledWith(RETURN_URL);
    expect(addListener).not.toHaveBeenCalled();

    stop();
    window.dispatchEvent(new Event('focus'));
    expect(onUrl).toHaveBeenCalledTimes(1);
  });
});
