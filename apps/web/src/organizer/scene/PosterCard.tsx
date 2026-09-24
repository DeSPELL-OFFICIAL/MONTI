import { useState } from 'react';
import { Button, Chip, PosterModal, Spinner, posterUrl } from '../../shared/ui';
import { useOrganizerCopy } from '../copy';
import type { PosterUpload } from './usePosterUpload';

export interface PosterCardProps {
  posterCid: string;
  upload: PosterUpload;
}

/**
 * The preview card at the top of the scene: the picture the organiser is making is on screen
 * the whole time they are describing it.
 *
 * The bytes on this card are the ones that were just cropped — an object URL over the blob
 * still in memory — and they are never swapped for `gatewayUrl(cid)` once the pin returns.
 * Doing that was the second suspect in the plan's list of why the poster felt slow: it threw
 * away a picture already decoded in this tab and asked a public gateway for it again, adding
 * IPFS propagation to a screen that had finished waiting (plan section D-2).
 *
 * The upload itself is not this part's business. It belongs to `usePosterUpload` up in the
 * scene, because `만들기` has to be able to wait for it.
 */
export function PosterCard({ posterCid, upload }: PosterCardProps) {
  const copy = useOrganizerCopy().scene;
  const [picking, setPicking] = useState(false);
  // The crop of this session first, then a CID carried in from a resumed draft or an event
  // being edited — which is the only case with nothing local to show.
  const src = upload.localUrl !== '' ? upload.localUrl
    : posterCid !== '' ? posterUrl(posterCid) : '';

  return (
    <div className="poster-card">
      {src !== '' ? (
        <div className="poster-card__filled">
          <img src={src} alt={copy.posterAlt} />
          {/* Small, and in the corner of the picture: the scene stays usable, so this is a
              note about something happening elsewhere and not a screen being blocked. */}
          {upload.busy ? <span className="poster-card__working"><Spinner /></span> : null}
        </div>
      ) : null}
      {upload.busy ? <p className="muted">{copy.posterWorking}</p> : null}
      {upload.problem !== '' ? (
        <>
          <p className="problem">{upload.problem}</p>
          <div className="chip-row">
            <Chip label={copy.posterRetry} onClick={upload.retry} />
          </div>
        </>
      ) : null}
      <Button variant="ghost" onClick={() => setPicking(true)}>
        {src !== '' ? copy.posterChange : copy.posterAdd}
      </Button>
      {picking ? (
        <PosterModal onConfirm={upload.start} onClose={() => setPicking(false)} />
      ) : null}
    </div>
  );
}
