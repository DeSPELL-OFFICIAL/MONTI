import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { Capacitor } from '@capacitor/core';

/** Native return address; the custom scheme is registered in the app shell. */
export const KYC_CALLBACK_URL = 'monti://kyc/callback';

/**
 * The web has no custom scheme, so the hosted flow returns to `/me/verify?didit=done&returnTo=…`
 * instead. Both return addresses are an obligation on the `startKyc` callable — it picks one per
 * platform when it creates the session; nothing on this side can set them.
 */
export const KYC_WEB_MARKER = 'didit';
export const KYC_WEB_MARKER_DONE = 'done';

/**
 * The return address handed to the hosted flow. Native keeps the custom scheme the app shell
 * registered — the server picks that one by itself — so nothing is sent for it. The web has no
 * scheme: the person comes back as a plain page load on the verification screen, marked, still
 * carrying where they were going. The server checks the origin and nothing else
 * (`functions/src/lib/kycSession.ts` assertCallbackUrl), so the path and the query survive.
 */
export function kycCallbackUrl(returnTo: string): string | undefined {
  if (Capacitor.isNativePlatform()) return undefined;
  const query = `${KYC_WEB_MARKER}=${KYC_WEB_MARKER_DONE}&returnTo=${encodeURIComponent(returnTo)}`;
  return `${window.location.origin}/me/verify?${query}`;
}

/** True for either return address: the native deep link, or the web marker. */
export function isKycCallback(url: string): boolean {
  return url.includes('kyc/callback') || url.includes(`${KYC_WEB_MARKER}=${KYC_WEB_MARKER_DONE}`);
}

/**
 * Native gets a system browser the app can dismiss. The web must navigate the SAME tab:
 * `Browser.open` there is `window.open`, and a hosted page that redirects a second tab back to
 * `/me/verify` leaves the original tab waiting for a return that never arrives.
 */
export async function openHostedFlow(url: string): Promise<void> {
  if (!Capacitor.isNativePlatform()) {
    window.location.assign(url);
    return;
  }
  await Browser.open({ url, presentationStyle: 'popover' });
}

/** Dismisses the system browser once the deep link has brought the app back. Native only. */
export async function closeHostedFlow(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  await Browser.close().catch(() => undefined);
}

/**
 * Resolves a remover. Native hears `appUrlOpen`; on the web the return is a normal navigation, so
 * the focus listener is only a second chance — the screen reads the marker off its own query
 * string on mount.
 */
export async function listenDeepLink(onUrl: (url: string) => void): Promise<() => void> {
  if (!Capacitor.isNativePlatform()) {
    const handler = () => onUrl(window.location.href);
    window.addEventListener('focus', handler);
    return () => window.removeEventListener('focus', handler);
  }
  const listener = await App.addListener('appUrlOpen', (event) => onUrl(event.url));
  return () => void listener.remove();
}
