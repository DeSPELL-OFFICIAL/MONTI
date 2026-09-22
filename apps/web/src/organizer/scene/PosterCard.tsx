import { useState } from 'react';
import { A4Cropper, Button } from '../../shared/ui';
import type { CroppedPoster } from '../../shared/ui';
import { api, callableFailure } from '../../shared/api/functions';
import { gatewayUrl } from '../../shared/envio/ipfs';
import { useOrganizerCopy, type OrganizerCopy } from '../copy';

type ImageProblem = keyof OrganizerCopy['scene']['imageProblems'];

/**
 * The server's reason codes against the sentence each one deserves
 * (task-ev-b report §3.1). Anything not listed — `PIN_FAILED`, a dropped connection,
 * `BAD_IMAGE` — is the retryable one, because that is what every unlisted case actually is.
 */
const IMAGE_PROBLEMS: Readonly<Record<string, ImageProblem>> = {
  IMAGE_TOO_LARGE: 'tooLarge',
  BAD_IMAGE_FORMAT: 'format',
  BAD_IMAGE_DIMENSIONS: 'dimensions',
  PIN_QUOTA: 'quota',
  NOT_ACTIVE: 'notActive',
  NO_SIGNUP: 'notActive',
};

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
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');

  async function upload(poster: CroppedPoster): Promise<void> {
    setBusy(true);
    setProblem('');
    try {
      const { cid } = await api.pinEventImage({ bytesBase64: poster.base64, kind: 'poster' });
      onPinned(cid);
      setEditing(false);
    } catch (cause) {
      // Caught here rather than thrown on: the cropper's own catch would replace a sentence
      // that says which photo to pick next with one that only says it did not work.
      const { reason } = callableFailure(cause);
      setProblem(copy.imageProblems[IMAGE_PROBLEMS[reason] ?? 'failed']);
    } finally {
      setBusy(false);
    }
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
