import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CODE_WINDOW_SECONDS, type GateCodeWire, type GateResponseWire, type Hex } from '@monti/shared';
import { ko } from '../../shared/copy/index';

const buildGateResponse = vi.fn<() => Promise<GateResponseWire>>();
vi.mock('./buildResponse', async (orig) => ({
  ...(await orig<typeof import('./buildResponse')>()),
  buildGateResponse,
}));

const toDataURL = vi.fn<(text: string) => Promise<string>>();
vi.mock('qrcode', () => ({ default: { toDataURL } }));

const { Qr } = await import('./Qr');
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
const WIRE: GateResponseWire = { v: 1, tokenId: '7', deviceSig: `0x${'22'.repeat(64)}` as Hex };

beforeEach(() => {
  vi.setSystemTime(ISSUED_AT * 1000);
  buildGateResponse.mockReset().mockResolvedValue(WIRE);
  toDataURL.mockReset().mockResolvedValue('data:image/png;base64,QQ==');
});

describe('<Qr />', () => {
  it('draws the same bytes the NFC write would have carried', async () => {
    await act(async () => {
      render(<Qr tokenId="7" gateCode={GATE_CODE} onExpire={() => undefined} />);
    });
    const payload = toDataURL.mock.calls[0]?.[0] as string;
    expect(payload.startsWith('MONTI1:')).toBe(true);
    expect(qrToGateResponse(payload)).toEqual(WIRE);
    expect(screen.getByRole('img', { name: ko.enter.qrTitle })).toHaveAttribute('src', 'data:image/png;base64,QQ==');
  });

  it('counts the code window down, not the arm window', async () => {
    vi.setSystemTime((ISSUED_AT + 12) * 1000);
    await act(async () => {
      render(<Qr tokenId="7" gateCode={GATE_CODE} onExpire={() => undefined} />);
    });
    expect(screen.getByRole('timer')).toHaveTextContent(String(CODE_WINDOW_SECONDS - 12));
  });

  it('tells the holder when it could not be drawn at all', async () => {
    buildGateResponse.mockRejectedValue(new Error('no key'));
    await act(async () => {
      render(<Qr tokenId="7" gateCode={GATE_CODE} onExpire={() => undefined} />);
    });
    expect(screen.getByText(ko.enter.signFailed)).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });
});
