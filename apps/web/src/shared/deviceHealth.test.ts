import { beforeEach, describe, expect, it, vi } from 'vitest';

const KEY = { x: `0x${'aa'.repeat(32)}`, y: `0x${'bb'.repeat(32)}` };
const OTHER = { x: `0x${'cc'.repeat(32)}`, y: `0x${'dd'.repeat(32)}` };
const ZERO = { x: `0x${'00'.repeat(32)}`, y: `0x${'00'.repeat(32)}` };
const ACCOUNT = `0x${'ab'.repeat(20)}` as `0x${string}`;
const SIG = { r: `0x${'11'.repeat(32)}`, s: `0x${'22'.repeat(32)}` };

const deviceKeyCapability = vi.fn(() => 'software');
const peekDeviceKey = vi.fn(async (): Promise<typeof KEY | null> => KEY);
const signWithDeviceKey = vi.fn(async () => SIG);
const verifyDeviceSignature = vi.fn(async () => true);
vi.mock('./deviceKey', () => ({
  deviceKeyCapability,
  peekDeviceKey,
  signWithDeviceKey,
  verifyDeviceSignature,
  ATTENDEE_KEY_ALIAS: 'monti-attendee',
}));

const activeDevice = vi.fn(async () => KEY);
vi.mock('./chain/reads', () => ({ readIdentity: () => ({ activeDevice }) }));

const {
  checkDeviceKeyHealth,
  ensureDeviceHealthChecked,
  getDeviceHealth,
  markDeviceHealthy,
  resetDeviceHealth,
} = await import('./deviceHealth');

beforeEach(() => {
  resetDeviceHealth();
  deviceKeyCapability.mockReturnValue('software');
  peekDeviceKey.mockReset();
  peekDeviceKey.mockResolvedValue(KEY);
  signWithDeviceKey.mockReset();
  signWithDeviceKey.mockResolvedValue(SIG);
  verifyDeviceSignature.mockReset();
  verifyDeviceSignature.mockResolvedValue(true);
  activeDevice.mockReset();
  activeDevice.mockResolvedValue(KEY);
});

describe('checkDeviceKeyHealth', () => {
  it('is healthy when a local key exists, signs, and matches the chain', async () => {
    expect(await checkDeviceKeyHealth(ACCOUNT)).toBe('healthy');
    // The contract: one sign + one RPC read, no more.
    expect(signWithDeviceKey).toHaveBeenCalledTimes(1);
    expect(activeDevice).toHaveBeenCalledTimes(1);
  });

  it('needs recovery when there is no local key (cleared site data, new browser)', async () => {
    peekDeviceKey.mockResolvedValue(null);
    expect(await checkDeviceKeyHealth(ACCOUNT)).toBe('needs-recovery');
    // Answerable without the chain — a missing key can never be the registered one.
    expect(activeDevice).not.toHaveBeenCalled();
  });

  it('needs recovery when the key cannot sign (restored, unusable IndexedDB key)', async () => {
    signWithDeviceKey.mockRejectedValue(new Error('DeviceKeyUnavailable'));
    expect(await checkDeviceKeyHealth(ACCOUNT)).toBe('needs-recovery');
    expect(activeDevice).not.toHaveBeenCalled();
  });

  it('needs recovery when the signature does not verify against the local key', async () => {
    verifyDeviceSignature.mockResolvedValue(false);
    expect(await checkDeviceKeyHealth(ACCOUNT)).toBe('needs-recovery');
  });

  it('needs recovery when the local key is not the one the chain has on file', async () => {
    activeDevice.mockResolvedValue(OTHER);
    expect(await checkDeviceKeyHealth(ACCOUNT)).toBe('needs-recovery');
  });

  it('is unknown (never blocks) when the chain read fails', async () => {
    activeDevice.mockRejectedValue(new Error('rpc down'));
    expect(await checkDeviceKeyHealth(ACCOUNT)).toBe('unknown');
  });

  it('is unknown when the account has no device on chain yet (pending / not active)', async () => {
    activeDevice.mockResolvedValue(ZERO);
    expect(await checkDeviceKeyHealth(ACCOUNT)).toBe('unknown');
  });

  it('is unknown on native without touching the local key or the chain', async () => {
    deviceKeyCapability.mockReturnValue('native');
    expect(await checkDeviceKeyHealth(ACCOUNT)).toBe('unknown');
    expect(peekDeviceKey).not.toHaveBeenCalled();
    expect(activeDevice).not.toHaveBeenCalled();
  });

  it('needs recovery when the key store itself is unreachable', async () => {
    peekDeviceKey.mockRejectedValue(new Error('DeviceKeyUnavailable'));
    expect(await checkDeviceKeyHealth(ACCOUNT)).toBe('needs-recovery');
  });
});

describe('the device-health store', () => {
  it('asks once per account and caches the answer', async () => {
    ensureDeviceHealthChecked(ACCOUNT);
    expect(getDeviceHealth()).toBe('checking');
    await vi.waitFor(() => expect(getDeviceHealth()).toBe('healthy'));
    ensureDeviceHealthChecked(ACCOUNT);
    expect(peekDeviceKey).toHaveBeenCalledTimes(1);
  });

  it('markDeviceHealthy clears a cached needs-recovery so recovery is not re-triggered', async () => {
    peekDeviceKey.mockResolvedValue(null);
    ensureDeviceHealthChecked(ACCOUNT);
    await vi.waitFor(() => expect(getDeviceHealth()).toBe('needs-recovery'));
    markDeviceHealthy();
    expect(getDeviceHealth()).toBe('healthy');
  });
});
