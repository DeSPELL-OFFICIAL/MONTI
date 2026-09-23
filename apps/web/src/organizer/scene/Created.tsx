import { useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import QRCode from 'qrcode';
import { Alert, Button, Screen } from '../../shared/ui';
import { gatewayUrl } from '../../shared/envio/ipfs';
import { useOrganizerCopy } from '../copy';
import type { CreatedEvent } from './usePublish';

/** Big enough to scan off a phone held up across a table, small enough to be a few kilobytes. */
const QR_WIDTH = 320;

/**
 * What SCENE 2 hands over when the event exists. It travels in the navigation rather than
 * being read back, because by the time this screen opens the draft has been deleted and the
 * indexer has not seen the event yet — both of the places the title and the poster lived.
 *
 * Every field is optional here: somebody may have opened this address directly, or come back
 * to it from history, and a missing poster must not cost them the link and the QR.
 */
type Handover = Partial<Omit<CreatedEvent, 'eventId'>>;

export function Created() {
  const copy = useOrganizerCopy().scene.done;
  const { eventId = '' } = useParams();
  const handed = (useLocation().state ?? {}) as Handover;
  const [dataUrl, setDataUrl] = useState('');
  const [copied, setCopied] = useState('');

  // The address an attendee would open, absolute — it is going into a message or onto a poster.
  const link = `${window.location.origin}/events/${eventId}`;

  useEffect(() => {
    let live = true;
    void QRCode.toDataURL(link, { width: QR_WIDTH, margin: 1 })
      .then((url) => {
        if (live) setDataUrl(url);
      })
      // A QR that would not draw costs the picture and nothing else: the address is on screen
      // in full either way, and it is the address that is the answer.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [link]);

  async function copyLink(): Promise<void> {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(copy.copied);
    } catch {
      // A browser without clipboard permission, or an insecure origin. The address is right
      // there to select by hand, so this says that rather than pretending it worked.
      setCopied(copy.copyFailed);
    }
  }

  return (
    <Screen title={copy.title}>
      <div className="scene">
        {handed.posterCid ? (
          <div className="poster-card">
            <div className="poster-card__filled">
              <img src={gatewayUrl(handed.posterCid)} alt="" />
            </div>
          </div>
        ) : null}
        <h2>{handed.title || copy.untitled}</h2>

        {/* The one thing an organiser has to be told, and it is not good news: `createEvent`
            makes a Draft, and `claim` refuses anything that is not Published. */}
        <Alert tone="info">{copy.notYetPublic}</Alert>
        {handed.followUpFailed ? <Alert tone="warn">{copy.artFailed}</Alert> : null}

        <section>
          <h2>{copy.link}</h2>
          <p className="event-link">{link}</p>
          <Button variant="ghost" onClick={() => void copyLink()}>
            {copy.copy}
          </Button>
          {copied !== '' ? <p className="muted">{copied}</p> : null}
          {dataUrl !== '' ? <img className="event-qr" src={dataUrl} alt={copy.qr} /> : null}
        </section>

        <Link to={`/events/${eventId}`} className="btn btn--primary btn--link">
          {copy.view}
        </Link>
        <p>
          <Link to={`/org/events/${eventId}`}>{copy.manage}</Link>
        </p>
        <p>
          <Link to="/org">{copy.home}</Link>
        </p>
      </div>
    </Screen>
  );
}
