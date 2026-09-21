import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';

export const KYC_CALLBACK_URL = 'monti://kyc/callback';

/** Resolves a remover. On the web the callback arrives as a normal navigation instead. */
export async function listenDeepLink(onUrl: (url: string) => void): Promise<() => void> {
  if (!Capacitor.isNativePlatform()) {
    const handler = () => onUrl(window.location.href);
    window.addEventListener('focus', handler);
    return () => window.removeEventListener('focus', handler);
  }
  const listener = await App.addListener('appUrlOpen', (event) => onUrl(event.url));
  return () => void listener.remove();
}
