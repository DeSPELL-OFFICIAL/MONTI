import { registerPlugin } from '@capacitor/core';
import type { DeviceKeyPlugin } from './definitions';

export * from './definitions';

export const DeviceKey = registerPlugin<DeviceKeyPlugin>('DeviceKey', {
  web: () => import('./web').then((module) => new module.DeviceKeyWeb()),
});
