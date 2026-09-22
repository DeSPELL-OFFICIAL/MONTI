import { useState } from 'react';
import { A4Cropper, Button } from '../../shared/ui';
import type { CroppedPoster } from '../../shared/ui';
import { gatewayUrl } from '../../shared/envio/ipfs';
import { useOrganizerCopy } from '../copy';
import { usePinImage } from './usePinImage';

export interface PosterCardProps {
  posterCid: string;
  onPinned: (cid: string) => void;
}

/**
 * The preview card at the top of SCENE 1, which is also where the poster is uploaded: the
 * picture the organiser is making is on screen the whole time they are describing it.
 *
 * The crop is pinned **immediately**, not at publish. A Firestore document stops at 1 MiB and
 * a 600 KB JPEG is 800 KB as base64, so there is no version of this where the bytes wait in
 * the draft — only the CID can (plan section C).
 */
export function PosterCard({ posterCid, onPinned }: PosterCardProps) {
  const copy = useOrganizerCopy().scene;
  const [editing, setEditing] = useState(false);
  const { pin, busy, problem } = usePinImage('poster');

  async function upload(cropped: CroppedPoster): Promise<void> {
    const cid = await pin(cropped);
    if (cid === '') return;
    onPinned(cid);
    setEditing(false);
  }

  if (posterCid === '' || editing) {
    return (
      <div className="poster-card">
        <A4Cropper onCropped={upload} busy={busy} />
        {busy ? <p className="muted">{copy.posterWorking}</p> : null}
        {problem !== '' ? <p className="problem">{problem}</p> : null}
        {posterCid !== '' ? (
          <Button variant="ghost" onClick={() => setEditing(false)} disabled={busy}>
            {copy.leave}
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="poster-card">
      <div className="poster-card__filled">
        <img src={gatewayUrl(posterCid)} alt={copy.posterAlt} />
      </div>
      <Button variant="ghost" onClick={() => setEditing(true)}>
        {copy.posterChange}
      </Button>
    </div>
  );
}
