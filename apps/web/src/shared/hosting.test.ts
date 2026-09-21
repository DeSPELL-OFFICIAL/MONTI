import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The hosting contract. `vercel.json` is the only place that decides how a client route,
 * the Android asset-links file and the security headers are served, and nothing in `src/`
 * can observe a mistake there — so this test is the only thing between a typo and a
 * production site that 404s every deep link or blocks its own RPC.
 *
 * The CSP is not written twice: the connect-src list is *derived* from `.env.example`, so
 * adding an endpoint to the example without widening the CSP fails here rather than in a
 * browser console after the deploy.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../..');
const WEB_ROOT = resolve(HERE, '../..');

interface HeaderRule {
  source: string;
  headers: { key: string; value: string }[];
}
interface VercelConfig {
  buildCommand: string;
  installCommand: string;
  outputDirectory: string;
  rewrites: { source: string; destination: string }[];
  headers: HeaderRule[];
}

const config = JSON.parse(readFileSync(resolve(REPO_ROOT, 'vercel.json'), 'utf8')) as VercelConfig;

function headersFor(source: string): Map<string, string> {
  const rule = config.headers.find((entry) => entry.source === source);
  if (!rule) throw new Error(`vercel.json has no headers rule for ${source}`);
  return new Map(rule.headers.map((header) => [header.key, header.value]));
}

/** `key=value` lines of an env file, comments and blanks dropped. */
function readEnvFile(path: string): Map<string, string> {
  const entries = readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#') && line.includes('='))
    .map((line) => {
      const index = line.indexOf('=');
      return [line.slice(0, index).trim(), line.slice(index + 1).trim()] as const;
    });
  return new Map(entries);
}

const envExample = readEnvFile(resolve(WEB_ROOT, '.env.example'));

/** Every URL-valued `VITE_*` key, in the shape the app actually reads it. */
const URL_KEYS = ['VITE_RPC_URLS', 'VITE_WS_URL', 'VITE_BUNDLER_URL', 'VITE_ENVIO_URL', 'VITE_IPFS_GATEWAY'] as const;

function envDerivedOrigins(): Set<string> {
  const origins = new Set<string>();
  for (const key of URL_KEYS) {
    const raw = envExample.get(key);
    if (raw === undefined || raw.length === 0) throw new Error(`.env.example is missing ${key}`);
    for (const url of raw.split(',')) {
      const trimmed = url.trim();
      if (trimmed.length > 0) origins.add(new URL(trimmed).origin);
    }
  }
  return origins;
}

/**
 * Hosts the Firebase JS SDK talks to no matter which project it is pointed at. They are not
 * in the env example because they are not configurable; they are pinned here so that dropping
 * one (and breaking sign-in, Firestore or push) is a failing test.
 *
 * The two project-scoped hosts — the auth domain and the callables host — are host wildcards
 * rather than exact origins on purpose. Both are built from `VITE_FIREBASE_PROJECT_ID`, which a
 * static response header cannot read; the example's value is a placeholder, so pinning it would
 * hand the real deployment a CSP that blocks its own sign-in. The wildcard is one DNS label
 * inside a Google-owned zone, never the bare `*`.
 */
const FIREBASE_SDK_ORIGINS = [
  'https://*.firebaseapp.com',
  'https://*.cloudfunctions.net',
  'https://identitytoolkit.googleapis.com',
  'https://securetoken.googleapis.com',
  'https://firestore.googleapis.com',
  'https://firebaseinstallations.googleapis.com',
  'https://fcmregistrations.googleapis.com',
  'https://fcm.googleapis.com',
  'https://firebasestorage.googleapis.com',
  'https://www.googleapis.com',
  'https://www.google.com',
];

function cspDirectives(): Map<string, string[]> {
  const csp = headersFor('/(.*)').get('Content-Security-Policy');
  if (csp === undefined) throw new Error('vercel.json sets no Content-Security-Policy');
  const directives = new Map<string, string[]>();
  for (const part of csp.split(';')) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    const [name, ...sources] = tokens;
    if (name !== undefined) directives.set(name, sources);
  }
  return directives;
}

describe('vercel.json build settings', () => {
  it('builds the workspace with pnpm and publishes apps/web/dist, so a fresh clone deploys', () => {
    expect(config.installCommand).toBe('pnpm install --frozen-lockfile');
    expect(config.buildCommand).toBe('pnpm --filter @monti/shared build && pnpm --filter @monti/web build');
    expect(config.outputDirectory).toBe('apps/web/dist');
  });
});

describe('vercel.json SPA rewrite', () => {
  // Every path the client router owns. A server that answers 404 here is a broken invite link.
  const CLIENT_ROUTES = [
    '/',
    '/i/inv_abc123',
    '/tickets',
    '/tickets/inbox',
    '/tickets/42',
    '/tickets/42/transfer',
    '/tickets/42/enter',
    '/me',
    '/me/verify',
    '/chats',
    '/chats/7',
    '/org/events',
    '/org/events/7/dashboard',
    '/staff/5',
  ];

  it('sends every client route to the app entry', () => {
    expect(config.rewrites).toHaveLength(1);
    const [rewrite] = config.rewrites;
    expect(rewrite?.destination).toBe('/index.html');
    const matcher = new RegExp(`^${rewrite?.source}$`);
    for (const route of CLIENT_ROUTES) {
      expect(matcher.test(route), `${route} is not covered by the SPA rewrite`).toBe(true);
    }
  });
});

describe('the Android asset-links file', () => {
  const assetLinksPath = resolve(WEB_ROOT, 'public/.well-known/assetlinks.json');

  it('is published, as JSON, from .well-known', () => {
    expect(existsSync(assetLinksPath)).toBe(true);
    expect(headersFor('/.well-known/assetlinks.json').get('Content-Type')).toBe('application/json');
  });

  it('claims both Android apps and carries the fingerprint placeholder', () => {
    const statements = JSON.parse(readFileSync(assetLinksPath, 'utf8')) as {
      relation: string[];
      target: { namespace: string; package_name: string; sha256_cert_fingerprints: string[] };
    }[];
    const packages = statements.map((statement) => statement.target.package_name);
    expect(packages).toEqual(['app.monti', 'app.monti.staff']);
    for (const statement of statements) {
      expect(statement.target.namespace).toBe('android_app');
      expect(statement.relation).toContain('delegate_permission/common.handle_all_urls');
      // The founder's signing key does not exist yet; the placeholder has to stay loud.
      expect(statement.target.sha256_cert_fingerprints).toEqual(['REPLACE_WITH_SIGNING_CERT_SHA256']);
    }
    // Passkeys on Android read this relation; without it the attendee app cannot sign in.
    expect(statements[0]?.relation).toContain('delegate_permission/common.get_login_creds');
  });

  it('publishes no Apple association file, because iOS is out of scope', () => {
    expect(existsSync(resolve(WEB_ROOT, 'public/.well-known/apple-app-site-association'))).toBe(false);
    expect(JSON.stringify(config)).not.toContain('apple-app-site-association');
  });
});

describe('security headers', () => {
  it('sets the four headers the attendee app depends on', () => {
    const headers = headersFor('/(.*)');
    // WebAuthn inside the served page: without this, passkey sign-in throws NotAllowedError.
    expect(headers.get('Permissions-Policy')).toContain('publickey-credentials-get=(self)');
    expect(headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(headers.get('Content-Security-Policy')).toBeDefined();
  });

  it('never opens a directive to every origin', () => {
    // A bare `*` and a scheme-only source (`https:`) are the same mistake wearing two hats.
    for (const [name, sources] of cspDirectives()) {
      for (const forbidden of ['*', 'https:', 'http:', 'data:*', "'unsafe-eval'"]) {
        expect(sources, `${name} must not allow every origin`).not.toContain(forbidden);
      }
    }
  });

  it('allows exactly the origins the env example names, plus the fixed Firebase hosts', () => {
    const connectSrc = cspDirectives().get('connect-src');
    expect(connectSrc).toBeDefined();
    const expected = new Set<string>(["'self'", ...envDerivedOrigins(), ...FIREBASE_SDK_ORIGINS]);
    expect(new Set(connectSrc)).toEqual(expected);
  });

  it('locks the page down by default', () => {
    const directives = cspDirectives();
    expect(directives.get('default-src')).toEqual(["'self'"]);
    expect(directives.get('object-src')).toEqual(["'none'"]);
    expect(directives.get('frame-ancestors')).toEqual(["'none'"]);
    expect(directives.get('base-uri')).toEqual(["'self'"]);
  });
});
