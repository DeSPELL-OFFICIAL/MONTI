import { registerPlugin } from '@capacitor/core';
import type { HcePlugin } from './definitions';

export * from './definitions';
export * from './base64';

export const Hce = registerPlugin<HcePlugin>('Hce', {
  web: () => import('./web').then((module) => new module.HceWeb()),
});
