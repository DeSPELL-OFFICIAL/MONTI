// The hand-over for a phone that cannot write: the same bytes, on screen, for the staff device
// to scan (spec §12). Nothing about the answer changes — `gateResponseToQr` is base64url of the
// very CBOR the NDEF record would have carried, so the two paths cannot drift apart.
//
// The code on screen dies with the gate's code, not with the arm window: a `GateCode` is good
// for `CODE_WINDOW_SECONDS` from `issuedAt` and `Ticket.checkIn` refuses it after that, so the
// countdown here is measured from the code the reader emitted.
import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { CODE_WINDOW_SECONDS, type GateCodeWire } from '@monti/shared';
import { Alert, Countdown, Spinner } from '../../shared/ui';
import { useCopy } from '../../shared/i18n';
import { gateResponseToQr } from '../../shared/nfc';
import { buildGateResponse } from './buildResponse';

export function Qr({
  tokenId,
  gateCode,
  onExpire,
}: {
  tokenId: string;
  gateCode: GateCodeWire;
  onExpire: () => void;
}) {
  const copy = useCopy();
  const [dataUrl, setDataUrl] = useState('');
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    void buildGateResponse(tokenId, gateCode)
      .then((wire) => QRCode.toDataURL(gateResponseToQr(wire), { width: 320, margin: 1 }))
      .then((url) => {
        if (live) setDataUrl(url);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [tokenId, gateCode]);

  if (failed) return <Alert tone="warn">{copy.enter.signFailed}</Alert>;
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
