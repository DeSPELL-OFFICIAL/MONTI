import { describe, expect, it, vi } from 'vitest';

/**
 * The staff APK's entry point. It is a side-effecting module, so the test is what importing it
 * does — and the thing that has to happen first is `initI18n()`. Without it `useLocale()` reads
 * react-i18next's uninitialised stub, `i18n.language` is `undefined`, and every English string
 * in `staff/setup/copy.ts` is unreachable in the shipped build.
 */
const render = vi.fn();
const initI18n = vi.fn(async () => undefined);

vi.mock('react-dom/client', () => ({
  createRoot: () => ({ render, unmount: vi.fn() }),
}));
vi.mock('./shared/i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./shared/i18n')>()),
  initI18n: () => initI18n(),
}));
// The screens themselves reach for Firebase and the chain at import time; this test is about
// the entry point's order of operations, not about what it mounts.
vi.mock('./staff/StaffRoutes', () => ({ StaffRoutes: () => null }));
vi.mock('./attendee/signup/Phone', () => ({ Phone: () => null }));
vi.mock('./attendee/signup/Verify', () => ({ Verify: () => null }));

describe('staff entry point', () => {
  it('initialises i18n before it renders anything', async () => {
    document.body.innerHTML = '<div id="root"></div>';

    await import('./staffMain');
    await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(1));

    expect(initI18n).toHaveBeenCalledTimes(1);
    // Order, not just presence: rendering first would show one Korean frame to an English
    // device and leave the locale wrong for the rest of the session.
    expect(initI18n.mock.invocationCallOrder[0]).toBeLessThan(render.mock.invocationCallOrder[0]!);
  });
});
