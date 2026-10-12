import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CODE_WINDOW_SECONDS, type GateCodeWire, type GateResponseWire, type Hex } from '@monti/shared';
import { en } from '../../shared/copy/index';

const buildGateResponse = vi.fn<() => Promise<GateResponseWire>>();
vi.mock('./buildResponse', async (orig) => ({
  ...(await orig<typeof import('./buildResponse')>()),
  buildGateResponse,
}));

const toDataURL = vi.fn<(text: string) => Promise<string>>();
vi.mock('qrcode', () => ({ default: { toDataURL } }));

const { Qr } = await import('./Qr');
const { HandOverError } = await import('./buildResponse');
const { qrToGateResponse } = await import('../../shared/nfc');

const ISSUED_AT = 1_790_000_000;
const GATE_CODE: GateCodeWire = {
  v: 1,
  gateId: '3',
  eventId: '11',
  issuedAt: ISSUED_AT,
  nonce: `0x${'11'.repeat(32)}` as Hex,
  kx: `0x${'00'.repeat(32)}`,
  ky: `0x${'00'.repeat(32)}`,
  sig: `0x${'00'.repeat(64)}`,
};
const WIRE: GateResponseWire = {
  v: 2,
  tokenId: '7',
  nonce: `0x${'11'.repeat(32)}` as Hex,
  deviceSig: `0x${'22'.repeat(64)}` as Hex,
};

beforeEach(() => {
  vi.setSystemTime(ISSUED_AT * 1000);
  buildGateResponse.mockReset().mockResolvedValue(WIRE);
  toDataURL.mockReset().mockResolvedValue('data:image/png;base64,QQ==');
});

describe('<Qr />', () => {
  it('draws the same bytes the NFC write would have carried', async () => {
    await act(async () => {
      render(<Qr tokenId="7" gateCode={GATE_CODE} wire={WIRE} onExpire={() => undefined} />);
    });
    const payload = toDataURL.mock.calls[0]?.[0] as string;
    expect(payload.startsWith('MONTI1:')).toBe(true);
    expect(qrToGateResponse(payload)).toEqual(WIRE);
    expect(screen.getByRole('img', { name: en.enter.qrTitle })).toHaveAttribute('src', 'data:image/png;base64,QQ==');
  });

  it('reuses the answer the tap already built instead of signing again', async () => {
    await act(async () => {
      render(<Qr tokenId="7" gateCode={GATE_CODE} wire={WIRE} onExpire={() => undefined} />);
    });
    // A second signature would spend a second biometric window on the same digest, exactly
    // when that window is most likely to be nearly over.
    expect(buildGateResponse).not.toHaveBeenCalled();
  });

  it('builds one only when the tap never got that far', async () => {
    await act(async () => {
      render(<Qr tokenId="7" gateCode={GATE_CODE} wire={null} onExpire={() => undefined} />);
    });
    expect(buildGateResponse).toHaveBeenCalledWith('7', GATE_CODE);
  });

  it('counts the code window down, not the arm window', async () => {
    vi.setSystemTime((ISSUED_AT + 12) * 1000);
    await act(async () => {
      render(<Qr tokenId="7" gateCode={GATE_CODE} wire={WIRE} onExpire={() => undefined} />);
    });
    expect(screen.getByRole('timer')).toHaveTextContent(String(CODE_WINDOW_SECONDS - 12));
  });

  it('names the reason it could not be drawn, not a generic one', async () => {
    // `deviceMismatch` is the one failure the holder can act on — a profile step — so it must
    // not read as "could not finish the check".
    buildGateResponse.mockRejectedValue(new HandOverError('deviceMismatch'));
    await act(async () => {
      render(<Qr tokenId="7" gateCode={GATE_CODE} wire={null} onExpire={() => undefined} />);
    });
    expect(screen.getByText(en.enter.deviceMismatch)).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('falls back to the generic sentence for a failure it cannot name', async () => {
    buildGateResponse.mockRejectedValue(new Error('bridge died'));
    await act(async () => {
      render(<Qr tokenId="7" gateCode={GATE_CODE} wire={null} onExpire={() => undefined} />);
    });
    expect(screen.getByText(en.enter.signFailed)).toBeInTheDocument();
  });
});
