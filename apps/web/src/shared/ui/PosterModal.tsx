import { useEffect, useRef, useState } from 'react';
import { useCopy } from '../i18n';
import { A4Frame } from './A4Cropper';
import { Alert } from './Alert';
import { Button } from './Button';
import { Field } from './Field';
import { CENTRED, cropToA4, type CropView, type CroppedPoster, type Quarter } from './a4Crop';

export interface PosterModalProps {
  /**
   * The finished bytes. It is deliberately not awaited: the modal is gone by the time whoever
   * owns the upload has sent the first packet, which is the whole point of the screen.
   */
  onConfirm: (cropped: CroppedPoster) => void;
  onClose: () => void;
}

/**
 * The poster, start to finish, on one full screen: pick a photo, move it about inside the
 * frame, and press 이 사진으로 정하기. Confirming closes this immediately — the upload happens
 * behind the scene the organiser has already gone back to (plan section D-1).
 *
 * It was three states of the card before the founder's phone test: a file box, then a frame
 * with two buttons under it, then a round trip to the server with the card frozen. A poster on
 * a phone is a picture the size of the phone, and a 240px card was never where to choose it.
 *
 * A `<dialog>` rather than a route, like the deletion confirmation in `attendee/me`: it is one
 * decision with a way out, and a route would put it in the back button's history. It is opened
 * with `showModal()`, not the `open` attribute, so the browser puts it in the top layer — above
 * the `.route-view` transform and the sticky bar — and paints a `::backdrop` that swallows the
 * taps behind it. Without that the confirm button sat under the sticky bar's hit target and the
 * tap missed (S4b).
 */
export function PosterModal({ onConfirm, onClose }: PosterModalProps) {
  const copy = useCopy().poster;
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState('');
  const [view, setView] = useState<CropView>(CENTRED);
  const [quarter, setQuarter] = useState<Quarter>(0);
  const [working, setWorking] = useState(false);
  const [failed, setFailed] = useState(false);

  // Open it in the top layer on mount. `showModal` is what lifts it above the route transform and
  // the sticky bar; a browser (or jsdom) that will not run it falls back to the plain open attribute
  // so the modal still renders — it just loses the top-layer guarantee there.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return undefined;
    try {
      dialog.showModal();
    } catch {
      dialog.setAttribute('open', '');
    }
    return () => {
      try {
        dialog.close();
      } catch {
        dialog.removeAttribute('open');
      }
    };
  }, []);

  // The preview reads the same bytes the crop will, so it is an object URL rather than a
  // second decode of the file. Nothing else would revoke it.
  useEffect(() => {
    if (!file) return;
    const next = URL.createObjectURL(file);
    setUrl(next);
    setView(CENTRED);
    setQuarter(0);
    return () => URL.revokeObjectURL(next);
  }, [file]);

  /** A turn re-frames the picture, so the pan and the zoom start again rather than half-apply. */
  function turn(): void {
    setQuarter((current) => ((current + 1) % 4) as Quarter);
    setView(CENTRED);
  }

  async function confirm(): Promise<void> {
    if (!file) return;
    setWorking(true);
    setFailed(false);
    try {
      const cropped = await cropToA4(file, { view, quarter });
      // In this order: the bytes are handed over first, so the card already has a picture on
      // it by the time this screen is taken away.
      onConfirm(cropped);
      onClose();
    } catch {
      setFailed(true);
      setWorking(false);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="poster-modal"
      aria-label={copy.title}
      // Escape closes through the same path the ✕ uses, and never mid-crop.
      onCancel={(event) => {
        event.preventDefault();
        if (!working) onClose();
      }}
    >
      <div className="poster-modal__body">
        <div className="poster-modal__head">
          <Button variant="ghost" aria-label={copy.close} onClick={onClose} disabled={working}>
            ✕
          </Button>
        </div>

        {file ? (
          <>
            <div className="poster-modal__frame">
              <A4Frame url={url} alt={copy.frame} view={view} quarter={quarter} onView={setView} />
            </div>
            <p className="muted">{copy.adjust}</p>
            {failed ? <Alert tone="error">{copy.failed}</Alert> : null}
            {/* The two adjustments share a row and the one decision spans the foot: on a
                phone the bottom edge is where the thumb already is, and the button that
                closes this screen should be the one it reaches without a stretch. */}
            <div className="poster-modal__bar">
              <div className="poster-modal__tools">
                <Button variant="ghost" onClick={turn} disabled={working}>{copy.rotate}</Button>
                <Button variant="ghost" onClick={() => setFile(null)} disabled={working}>
                  {copy.again}
                </Button>
              </div>
              <Button onClick={() => void confirm()} disabled={working}>
                {working ? copy.working : copy.crop}
              </Button>
            </div>
          </>
        ) : (
          <div className="poster-modal__frame">
            <Field label={copy.pick}>
              <input
                type="file" accept="image/jpeg,image/png,image/webp"
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              />
            </Field>
          </div>
        )}
      </div>
    </dialog>
  );
}
