import { useState } from 'react';
import { A4Cropper, Chip } from '../shared/ui';
import type { CroppedPoster, TicketArtPreset, TicketArtSource } from '../shared/ui';
import { useOrganizerCopy, type OrganizerCopy } from './copy';
import { TICKET_ART_PRESETS } from './scene/draftRules';
import { usePinImage } from './scene/usePinImage';

/** Flat keys rather than a map, so a locale missing one fails the build. */
export function presetLabel(copy: OrganizerCopy['scene']['tiers'], preset: TicketArtPreset): string {
  if (preset === 'b') return copy.artB;
  if (preset === 'c') return copy.artC;
  if (preset === 'd') return copy.artD;
  return copy.artA;
}

export interface ArtPickerProps {
  /** What the kind carries now — one of the four letters, or a picture of the organiser's own. */
  art: TicketArtSource;
  onPreset: (preset: TicketArtPreset) => void;
  /** The CID `pinEventImage` gave back for the picture that was just cropped. */
  onUploaded: (imageCid: string) => void;
}

/**
 * The four bundled backdrops and the way to upload a fifth, in one part because two screens
 * offer exactly this choice: SCENE 2's kind card, before the event exists, and the event's own
 * screen afterwards (T-EV-W13). The art is the one thing about a ticket that stays editable
 * after publishing — it lives in `eventArt/{eventId}` and not on the chain — so the picker had
 * to be reachable from both, and a second copy of it would be a second set of names.
 *
 * It owns the upload and nothing else: where the answer is *stored* is the caller's business,
 * which is what keeps the draft (a field on a document) and the live event (a callable) apart.
 */
export function ArtPicker({ art, onPreset, onUploaded }: ArtPickerProps) {
  const copy = useOrganizerCopy().scene.tiers;
  const [uploading, setUploading] = useState(false);
  const { pin, busy, problem } = usePinImage('ticket');
  // `null` while a picture of their own is in place: the design chips then show nothing chosen,
  // which is the truth — the upload is what the ticket will carry.
  const chosen = 'preset' in art ? art.preset : null;

  async function upload(cropped: CroppedPoster): Promise<void> {
    const cid = await pin(cropped);
    if (cid === '') return;
    onUploaded(cid);
    setUploading(false);
  }

  return (
    <>
      <div className="chip-row">
        {TICKET_ART_PRESETS.map((preset) => (
          <Chip
            key={preset}
            label={presetLabel(copy, preset)}
            selected={chosen === preset}
            onClick={() => onPreset(preset)}
          />
        ))}
        <Chip
          label={uploading ? copy.artUploadClose : copy.artUpload}
          selected={chosen === null}
          onClick={() => setUploading((open) => !open)}
        />
      </div>
      {uploading ? (
        <>
          <A4Cropper onCropped={upload} busy={busy} />
          {busy ? <p className="muted">{copy.artWorking}</p> : null}
        </>
      ) : null}
      {problem !== '' ? <p className="problem">{problem}</p> : null}
    </>
  );
}
