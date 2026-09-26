import type { CDPSession, Page } from '@playwright/test';

/**
 * A CDP WebAuthn virtual authenticator, attached to one page's target.
 *
 * The MONTI web build makes and uses passkeys through ox (`WebAuthnP256.createCredential` and
 * `navigator.credentials.get`), pinned to RP ID `monti.despell.io`. A virtual authenticator is
 * what lets those two calls resolve with no real security key and no human touching a sensor,
 * so signup and login run headlessly. It is `ctap2` / `internal` / resident-key / UV, matching
 * a phone's platform authenticator — which is what the app's `residentKey: 'required'` and
 * `userVerification: 'required'` ask for.
 */
export interface VirtualAuthenticator {
  readonly authenticatorId: string;
  /** Export every credential the authenticator holds, to persist a persona across runs. */
  exportCredentials: () => Promise<CdpCredential[]>;
  /** Re-add credentials exported on an earlier run, so a persona can log back in. */
  importCredentials: (creds: CdpCredential[]) => Promise<void>;
  detach: () => Promise<void>;
}

/** The shape `WebAuthn.getCredentials` returns and `WebAuthn.addCredential` accepts back. */
export interface CdpCredential {
  credentialId: string;
  isResidentCredential: boolean;
  rpId?: string;
  privateKey: string;
  userHandle?: string;
  signCount: number;
  backupEligibility?: boolean;
  backupState?: boolean;
}

export async function attachAuthenticator(page: Page): Promise<VirtualAuthenticator> {
  const cdp: CDPSession = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable', { enableUI: false });
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      // Resolve the ceremony without asking the "user" to present the authenticator.
      automaticPresenceSimulation: true,
    },
  });

  return {
    authenticatorId,
    exportCredentials: async () => {
      const { credentials } = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
      return credentials as CdpCredential[];
    },
    importCredentials: async (creds) => {
      for (const credential of creds) {
        await cdp.send('WebAuthn.addCredential', { authenticatorId, credential });
      }
    },
    detach: async () => {
      await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId }).catch(() => undefined);
      await cdp.detach().catch(() => undefined);
    },
  };
}
