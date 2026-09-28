import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useCopy } from '../i18n';
import { Alert } from './Alert';
import { Button } from './Button';
import { Field } from './Field';
import {
  A4_HEIGHT, A4_WIDTH, CENTRED, clamp, coverRect, cropToA4, turnedSize,
  type CropView, type CroppedPoster, type Quarter,
} from './a4Crop';

const MIN_SCALE = 1;
const MAX_SCALE = 4;
/** One wheel notch is roughly 100 deltaY, which this turns into about a tenth of a zoom. */
const WHEEL_DIVISOR = 900;

/**
 * Pan is clamped rather than the crop: the frame never shows what the output could not, and a
 * photo wider than A4 still pans sideways at rest — which half becomes the poster.
 */
function settle(view: CropView, width: number, height: number): CropView {
  const scale = clamp(view.scale, MIN_SCALE, MAX_SCALE);
  const { sw, sh } = coverRect(width, height, scale);
  const x = (width / sw - 1) / 2;
  const y = (height / sh - 1) / 2;
  return { scale, panX: clamp(view.panX, -x, x), panY: clamp(view.panY, -y, y) };
}

export interface A4FrameProps {
  /** The object URL of the picture being framed; the frame never reads the file itself. */
  url: string;
  alt: string;
  view: CropView;
  quarter?: Quarter;
  /**
   * Handed an updater rather than a value on purpose. Pointer moves arrive faster than React
   * re-renders and the browser batches them, so a handler that settled against the `view` it
   * was rendered with would drop every delta between two paints — the drag would stutter and
   * then jump. The updater is applied to whatever the owner's state actually holds.
   */
  onView: (next: (current: CropView) => CropView) => void;
}

/**
 * The frame and the gestures, and nothing else — no file, no buttons, no crop. Pinch and drag
 * on a phone, wheel and drag on a desktop. Both are Pointer Events, so there is one set of
 * handlers rather than a touch pair and a mouse pair; two live pointers mean a pinch, one
 * means a drag.
 *
 * It is a part of its own because the poster modal puts its buttons at the foot of a full
 * screen while the ticket picker keeps them under the frame (plan section D-1): where the
 * buttons live is a layout decision, and the gestures are not.
 */
export function A4Frame({ url, alt, view, quarter = 0, onView }: A4FrameProps) {
  const frame = useRef<HTMLDivElement>(null);
  const natural = useRef({ width: A4_WIDTH, height: A4_HEIGHT });
  const points = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ gap: number; scale: number } | null>(null);
  // The turn is read inside the handlers, which outlive the render they were made in.
  const turn = useRef<Quarter>(quarter);
  turn.current = quarter;

  /** Every settle measures the *turned* picture: standing a photo upright swaps its sides. */
  function bounded(next: (current: CropView) => CropView): void {
    onView((current) => {
      const size = turnedSize(natural.current.width, natural.current.height, turn.current);
      return settle(next(current), size.width, size.height);
    });
  }

  // React's own wheel listener is passive, so holding the page still under a desktop zoom
  // takes a listener of ours. Touch is held instead by `touch-action: none` on the frame.
  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    const zoom = (event: WheelEvent) => {
      event.preventDefault();
      bounded((v) => ({ ...v, scale: v.scale * Math.exp(-event.deltaY / WHEEL_DIVISOR) }));
    };
    element.addEventListener('wheel', zoom, { passive: false });
    return () => element.removeEventListener('wheel', zoom);
  }, [url]);

  function gap(): number {
    const [a, b] = [...points.current.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  }

  function down(event: ReactPointerEvent<HTMLDivElement>): void {
    event.currentTarget.setPointerCapture(event.pointerId);
    points.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (points.current.size === 2) pinch.current = { gap: gap(), scale: view.scale };
  }

  function move(event: ReactPointerEvent<HTMLDivElement>): void {
    const before = points.current.get(event.pointerId);
    if (!before) return;
    points.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const started = pinch.current;
    if (started && points.current.size >= 2) {
      const spread = gap();
      if (spread > 0) bounded((v) => ({ ...v, scale: (started.scale * spread) / started.gap }));
      return;
    }
    // A drag is measured against the frame, not the screen: the pans are in frame widths.
    const box = event.currentTarget.getBoundingClientRect();
    if (!box.width || !box.height) return;
    const dx = (event.clientX - before.x) / box.width;
    const dy = (event.clientY - before.y) / box.height;
    bounded((v) => ({ ...v, panX: v.panX + dx, panY: v.panY + dy }));
  }

  function up(event: ReactPointerEvent<HTMLDivElement>): void {
    points.current.delete(event.pointerId);
    if (points.current.size < 2) pinch.current = null;
  }

  return (
    <div
      ref={frame}
      className="a4-frame"
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
    >
      <img
        // An odd quarter stands the picture up, so its box is the frame with the sides swapped
        // — the class is what swaps them, and the rotation puts it back over the frame.
        className={quarter % 2 === 1 ? 'a4-frame__img a4-frame__img--turned' : 'a4-frame__img'}
        src={url}
        alt={alt}
        draggable={false}
        onLoad={(event) => {
          const { naturalWidth, naturalHeight } = event.currentTarget;
          if (naturalWidth && naturalHeight) {
            natural.current = { width: naturalWidth, height: naturalHeight };
          }
        }}
        style={{
          transform: `translate(-50%, -50%) rotate(${quarter * 90}deg) `
            + `translate(${view.panX * 100}%, ${view.panY * 100}%) scale(${view.scale})`,
        }}
      />
    </div>
  );
}

/** `onCropped` is awaited, so an upload behind it holds the buttons down instead of racing. */
export interface A4CropperProps { onCropped: (poster: CroppedPoster) => void | Promise<void>; busy?: boolean }

/**
 * Pick a picture, frame it, crop it — inline, under whatever asked for it. This is the ticket
 * picture's way in: a kind card already is a card, and a full screen over it to choose a
 * backdrop would be a screen for a decision the organiser is making in passing.
 *
 * The poster does not come through here any more. It opens {@link PosterModal} instead, which
 * is the same frame with the buttons at the foot of a full screen and a turn button beside
 * them (plan section D-1).
 */
export function A4Cropper({ onCropped, busy = false }: A4CropperProps) {
  const copy = useCopy().poster;
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState('');
  const [view, setView] = useState<CropView>(CENTRED);
  const [working, setWorking] = useState(false);
  const [failed, setFailed] = useState(false);

  // The preview reads the same bytes the crop will, so it is an object URL rather than a
  // second decode of the file. Nothing else would revoke it.
  useEffect(() => {
    if (!file) return;
    const next = URL.createObjectURL(file);
    setUrl(next);
    setView(CENTRED);
    return () => URL.revokeObjectURL(next);
  }, [file]);

  async function crop(): Promise<void> {
    if (!file) return;
    setWorking(true);
    setFailed(false);
    try {
      await onCropped(await cropToA4(file, { view }));
    } catch {
      setFailed(true);
    } finally {
      setWorking(false);
    }
  }

  if (!file) {
    return (
      <Field label={copy.pick}>
        <input
          type="file" accept="image/jpeg,image/png,image/webp"
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
        />
      </Field>
    );
  }

  return (
    <section>
      <A4Frame url={url} alt={copy.frame} view={view} onView={setView} />
      <p className="muted">{copy.adjust}</p>
      {failed ? <Alert tone="error">{copy.failed}</Alert> : null}
      <Button onClick={() => void crop()} disabled={working || busy}>{working ? copy.working : copy.crop}</Button>
      <Button variant="ghost" onClick={() => setFile(null)} disabled={working || busy}>{copy.again}</Button>
    </section>
  );
}
