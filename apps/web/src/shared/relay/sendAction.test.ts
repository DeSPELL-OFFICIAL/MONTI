import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Hex } from '@monti/shared';
import type { RelayView } from '../api/firestore';

const relayAction = vi.fn();
const buildForwardRequest = vi.fn();
const watchRelay = vi.fn<(id: string, onChange: (r: RelayView | null) => void, onError: (e: unknown) => void) => () => void>();

vi.mock('../api/functions', async (orig) => ({
  ...(await orig<typeof import('../api/functions')>()),
  api: { relayAction },
}));
vi.mock('./buildForwardRequest', () => ({ buildForwardRequest }));
vi.mock('../api/firestore', () => ({ watchRelay }));

const { sendAction } = await import('./sendAction');
const { CallableError } = await import('../api/functions');

const DATA = '0xdeadbeef' as Hex;
const BUILT = {
  req: { from: `0x${'ab'.repeat(20)}`, to: `0x${'33'.repeat(20)}`, nonce: '0', deadline: '1', data: DATA },
  deviceSig: `0x${'cd'.repeat(64)}` as Hex,
  kind: 'createEvent',
};

function badNonceError(nonce: string): unknown {
  return new CallableError('failed-precondition', 'BAD_NONCE', { code: 'BAD_NONCE', nonce });
}

beforeEach(() => {
  buildForwardRequest.mockReset().mockResolvedValue(BUILT);
  relayAction.mockReset();
  watchRelay.mockReset().mockReturnValue(() => undefined);
});

describe('sendAction', () => {
  it('builds, calls relayAction, and returns the result on a confirmed answer', async () => {
    relayAction.mockResolvedValue({ relayId: 'r1', status: 'confirmed', result: { eventId: '42' } });
    const result = await sendAction('createEvent', 'ticket', DATA);
    expect(buildForwardRequest).toHaveBeenCalledWith({ to: 'ticket', data: DATA, kind: 'createEvent', nonce: undefined });
    expect(relayAction).toHaveBeenCalledWith({ req: BUILT.req, deviceSig: BUILT.deviceSig, kind: BUILT.kind });
    expect(result).toEqual({ eventId: '42' });
    expect(watchRelay).not.toHaveBeenCalled();
  });

  it('follows the relay doc when the answer is sent, returning the settled result', async () => {
    relayAction.mockResolvedValue({ relayId: 'r1', status: 'sent' });
    watchRelay.mockImplementation((_id, onChange) => {
      onChange({ status: 'confirmed', result: { gateId: '7' } });
      return () => undefined;
    });
    const result = await sendAction('registerGate', 'organizers', DATA);
    expect(watchRelay).toHaveBeenCalledWith('r1', expect.any(Function), expect.any(Function));
    expect(result).toEqual({ gateId: '7' });
  });

  it('rejects with the relay doc error code when the sent action fails', async () => {
    relayAction.mockResolvedValue({ relayId: 'r1', status: 'sent' });
    watchRelay.mockImplementation((_id, onChange) => {
      onChange({ status: 'failed', error: { code: 'TX_REVERT', message: 'reverted' } });
      return () => undefined;
    });
    await expect(sendAction('publishEvent', 'ticket', DATA)).rejects.toMatchObject({
      code: 'failed-precondition',
      message: 'TX_REVERT',
    });
  });

  it('rebuilds with the reported nonce and retries once on BAD_NONCE', async () => {
    relayAction
      .mockRejectedValueOnce(badNonceError('12'))
      .mockResolvedValueOnce({ relayId: 'r2', status: 'confirmed', result: { eventId: '9' } });
    const result = await sendAction('createEvent', 'ticket', DATA);
    expect(buildForwardRequest).toHaveBeenNthCalledWith(1, { to: 'ticket', data: DATA, kind: 'createEvent', nonce: undefined });
    expect(buildForwardRequest).toHaveBeenNthCalledWith(2, { to: 'ticket', data: DATA, kind: 'createEvent', nonce: 12n });
    expect(relayAction).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ eventId: '9' });
  });

  it('retries BAD_NONCE only once, then surfaces a second one', async () => {
    relayAction.mockRejectedValue(badNonceError('12'));
    await expect(sendAction('createEvent', 'ticket', DATA)).rejects.toMatchObject({ message: 'BAD_NONCE' });
    expect(relayAction).toHaveBeenCalledTimes(2);
  });

  it('does not retry a non-BAD_NONCE refusal', async () => {
    relayAction.mockRejectedValue(new CallableError('failed-precondition', 'TARGET_NOT_ALLOWED', { code: 'TARGET_NOT_ALLOWED' }));
    await expect(sendAction('createEvent', 'ticket', DATA)).rejects.toMatchObject({ message: 'TARGET_NOT_ALLOWED' });
    expect(relayAction).toHaveBeenCalledTimes(1);
  });
});
