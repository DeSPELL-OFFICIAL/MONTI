import { test, expect } from '@playwright/test';
import { ADMIN } from '../fixtures/personas';
import { closePersona, ensureAccount, openPersona } from '../utils/session';

/**
 * The de-risk run: one persona, the whole first-time signup, against production. It proves the
 * four things everything else depends on — Firebase test-number phone auth (invisible
 * reCAPTCHA), the WebAuthn virtual authenticator, the on-chain identity registration, and the
 * session it leaves behind — before any scenario spends more on-chain operations on them.
 */
test('smoke: admin signs up end to end', async ({ browser }) => {
  const session = await openPersona(browser, ADMIN);
  try {
    await ensureAccount(session);
    // Signed in and on 탐색: the FAB and the tab bar are both here for a real session.
    await session.page.goto('/');
    await expect(session.page.getByRole('button', { name: '만들기', exact: true })).toBeVisible({ timeout: 30_000 });
  } finally {
    await closePersona(session);
  }
});
