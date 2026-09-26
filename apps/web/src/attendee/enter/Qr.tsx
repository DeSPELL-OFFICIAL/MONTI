// The write fallback: the answer the tap already produced, on screen for the staff device to
// scan (spec §12). `gateResponseToQr` is base64url of the very CBOR the NDEF record carried,
// so the two hand-overs cannot drift apart.
//
// It is a fallback for a *write*, never a substitute for the tap: the payload is a device
// signature over the gate's one-time code, so it exists only once that code has been read over
// NFC. `wire` is normally the one the failed write built — re-signing would spend a second
// biometric window on the same digest, exactly when that window is most likely to be nearly
// over — and is rebuilt only if the tap never got that far.
//
// The code dies with the gate's code, not with the arm window: a `GateCode` is good for
// `CODE_WINDOW_SECONDS` from `issuedAt` and `Ticket.checkIn` refuses it after that.
import { useEffect, useState } from 'react';
import { CODE_WINDOW_SECONDS, type GateCodeWire, type GateResponseWire } from '@monti/shared';
import { Alert, Countdown, Spinner } from '../../shared/ui';
import { useCopy } from '../../shared/i18n';
import { gateResponseToQr } from '../../shared/nfc';
import { buildGateResponse, handOverEnding } from './buildResponse';
import { failureText } from './useArm';

export function Qr({
  tokenId,
  gateCode,
  wire,
  onExpire,
}: {
  tokenId: string;
  gateCode: GateCodeWire;
  /** The answer the tap built, when it got that far. */
  wire: GateResponseWire | null;
  onExpire: () => void;
}) {
  const copy = useCopy();
  const [dataUrl, setDataUrl] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    const answer = wire ? Promise.resolve(wire) : buildGateResponse(tokenId, gateCode);
    void answer
      // `qrcode` is loaded on demand so its ~15 kB gz stays out of the main chunk; the Spinner
      // below is the placeholder until the picture (or an error) is ready.
      .then(async (response) => {
        const { default: QRCode } = await import('qrcode');
        return QRCode.toDataURL(gateResponseToQr(response), { width: 320, margin: 1 });
      })
      .then((url) => {
        if (live) setDataUrl(url);
      })
      .catch((cause: unknown) => {
        // The same reason the tap would have shown. `deviceMismatch` in particular is a profile
        // step the holder can act on; "could not finish the check" is not.
        if (live) setError(handOverEnding(cause).error);
      });
    return () => {
      live = false;
    };
  }, [tokenId, gateCode, wire]);

  if (error) return <Alert tone="warn">{failureText(copy, error)}</Alert>;
  if (!dataUrl) return <Spinner />;

  const secondsLeft = Math.max(0, gateCode.issuedAt + CODE_WINDOW_SECONDS - Math.floor(Date.now() / 1000));
  return (
    <>
      <img
        src={dataUrl}
        alt={copy.enter.qrTitle}
        style={{ width: '100%', maxWidth: 320, margin: '0 auto', display: 'block' }}
      />
      <Countdown seconds={secondsLeft} onExpire={onExpire} />
    </>
  );
}
