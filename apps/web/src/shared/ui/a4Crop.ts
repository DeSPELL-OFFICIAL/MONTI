/**
 * A4 portrait at 150dpi (1:√2). The poster's shape is settled before anyone picks a picture,
 * so the only choice left is which part of the picture lands inside the frame — a pan, a zoom
 * and a quarter turn, not a free crop. That is also why no crop library is pulled in: most of
 * one would go unused, and the repo carries none today.
 *
 * The drawing and the encoding are parameters rather than calls, the way `shrinkImage` is a
 * parameter of `prepareImage`: a test has no `createImageBitmap` and no canvas that encodes.
 */
export const A4_WIDTH = 1240;
export const A4_HEIGHT = 1754;

/** The pinning call carries base64, a third larger again, so the blob itself has to stay small. */
export const A4_MAX_BYTES = 600 * 1024;

/** One good encode, and a cheaper rescue only for the picture that came out too heavy. */
export const A4_QUALITY = 0.85;
export const A4_QUALITY_RESCUE = 0.7;

/**
 * Quarter turns clockwise. A phone hands back plenty of photos that are a quarter out — EXIF
 * covers the camera's own rotation, nothing covers a picture somebody was sent — and a poster
 * lying on its side is the one thing no amount of panning can repair.
 */
export type Quarter = 0 | 1 | 2 | 3;

/** `scale` 1 is the picture filling the frame; the pans are in frame widths, 0 being centred. */
export interface CropView { scale: number; panX: number; panY: number }

/**
 * How long each part of making a poster took, in milliseconds (T-UX2-10). The plan ranked the
 * suspects for why the poster felt slow by reading the code (section D-2); this is the part of
 * the measurement that only this module can take, because only this module knows whether the
 * rescue encode ran at all. The upload is added by whoever sends the bytes.
 */
export interface CropTimings {
  /** `createImageBitmap` — a 12 MP photo off a phone. */
  decodeMs: number;
  /** The first draw and JPEG encode, at {@link A4_QUALITY}. */
  encodeMs: number;
  /** The second one, at {@link A4_QUALITY_RESCUE}; `0` when the first blob already fitted. */
  rescueMs: number;
  /** `FileReader` turning the blob into the base64 the pinning call carries. */
  base64Ms: number;
}

/** `base64` is the blob without its `data:<mime>;base64,` prefix — what the pinning call takes. */
export interface CroppedPoster {
  blob: Blob;
  base64: string;
  width: number;
  height: number;
  /** Optional because a test that stubs this whole module has no seconds to report. */
  timings?: CropTimings;
}

export interface CropSource { sx: number; sy: number; sw: number; sh: number }

export interface CropOptions {
  view?: CropView;
  quarter?: Quarter;
  load?: (file: File) => Promise<ImageBitmap>;
  encode?: (
    bitmap: ImageBitmap, rect: CropSource, quality: number, quarter: Quarter,
  ) => Promise<Blob | null>;
}

export const CENTRED: CropView = { scale: 1, panX: 0, panY: 0 };

export function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/**
 * The picture's size once it has been turned. The odd quarters swap the two, and everything
 * that measures the frame — the cover rectangle, the pan clamp — has to measure the turned
 * picture or the photo pans off the edge the moment it is stood upright.
 */
export function turnedSize(
  width: number, height: number, quarter: Quarter,
): { width: number; height: number } {
  return quarter % 2 === 1 ? { width: height, height: width } : { width, height };
}

/** The largest A4-shaped rectangle the picture holds, divided down by the zoom. */
export function coverRect(width: number, height: number, scale: number): { sw: number; sh: number } {
  let sw = width;
  let sh = (width * A4_HEIGHT) / A4_WIDTH;
  if (sh > height) {
    sh = height;
    sw = (height * A4_WIDTH) / A4_HEIGHT;
  }
  return { sw: sw / scale, sh: sh / scale };
}

/** The rectangle `drawImage` reads from, clamped so the frame is covered edge to edge. */
function cropRect(width: number, height: number, view: CropView): CropSource {
  const { sw, sh } = coverRect(width, height, view.scale);
  const sx = clamp(width / 2 - view.panX * sw - sw / 2, 0, width - sw);
  const sy = clamp(height / 2 - view.panY * sh - sh / 2, 0, height - sh);
  return { sx, sy, sw, sh };
}

/**
 * The frame's rectangle — measured on the *turned* picture, because that is what the organiser
 * was looking at — back in the bitmap's own coordinates. `drawImage` reads from the bitmap and
 * knows nothing about the turn; the canvas is what gets rotated afterwards.
 *
 * Turning a picture a quarter clockwise sends its pixel (x, y) to (height - y, x), so a
 * rectangle measured in turned coordinates comes back transposed and with one axis reversed.
 */
export function sourceRect(
  rect: CropSource, quarter: Quarter, width: number, height: number,
): CropSource {
  if (quarter === 1) {
    return { sx: rect.sy, sy: height - rect.sx - rect.sw, sw: rect.sh, sh: rect.sw };
  }
  if (quarter === 2) {
    return {
      sx: width - rect.sx - rect.sw, sy: height - rect.sy - rect.sh, sw: rect.sw, sh: rect.sh,
    };
  }
  if (quarter === 3) {
    return { sx: width - rect.sy - rect.sh, sy: rect.sx, sw: rect.sh, sh: rect.sw };
  }
  return rect;
}

/**
 * `imageOrientation: 'from-image'` is the whole reason this goes through `createImageBitmap`:
 * a phone keeps the rotation of a photo in EXIF, so without it a portrait shot taken on one
 * is cropped lying on its side.
 */
function loadBitmap(file: File): Promise<ImageBitmap> {
  return createImageBitmap(file, { imageOrientation: 'from-image' });
}

/**
 * The crop rectangle is what lands on the canvas, so the canvas is exactly A4 and never scaled.
 *
 * A quarter of 0 costs nothing — it is the single `drawImage` this has always been. Only a
 * picture somebody actually turned pays for the transform, and then the destination box is the
 * A4 canvas with its own sides swapped, because it is being drawn in a rotated frame.
 */
function drawAndEncode(
  bitmap: ImageBitmap, rect: CropSource, quality: number, quarter: Quarter,
): Promise<Blob | null> {
  const canvas = document.createElement('canvas');
  canvas.width = A4_WIDTH;
  canvas.height = A4_HEIGHT;
  const context = canvas.getContext('2d');
  if (!context) return Promise.resolve(null);
  if (quarter === 0) {
    context.drawImage(bitmap, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, A4_WIDTH, A4_HEIGHT);
  } else {
    const turned = turnedSize(A4_WIDTH, A4_HEIGHT, quarter);
    context.translate(A4_WIDTH / 2, A4_HEIGHT / 2);
    context.rotate((quarter * Math.PI) / 2);
    context.drawImage(
      bitmap, rect.sx, rect.sy, rect.sw, rect.sh,
      -turned.width / 2, -turned.height / 2, turned.width, turned.height,
    );
  }
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}

/** The data URL is base64 already; only the prefix comes off — the server wants raw base64. */
function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('POSTER_UNREADABLE'));
    reader.onload = () => {
      const url = String(reader.result);
      resolve(url.slice(url.indexOf(',') + 1));
    };
    reader.readAsDataURL(blob);
  });
}

/**
 * One rescue encode rather than a ladder of them: 0.7 is already far under the cap, and a
 * poster is cropped once, in front of somebody waiting for the frame to let go.
 */
export async function cropToA4(file: File, opts: CropOptions = {}): Promise<CroppedPoster> {
  const quarter = opts.quarter ?? 0;
  // Four clocks, and the numbers ride out on the poster rather than into a console from here:
  // this module has no business deciding what is worth printing, and a caller that wants to
  // assert the figures should not have to spy on one (T-UX2-10).
  const decodeAt = performance.now();
  const bitmap = await (opts.load ?? loadBitmap)(file);
  const decodeMs = performance.now() - decodeAt;

  const encode = opts.encode ?? drawAndEncode;
  // Measured on the turned picture — the one that was on screen — and then mapped back.
  const turned = turnedSize(bitmap.width, bitmap.height, quarter);
  const framed = cropRect(turned.width, turned.height, opts.view ?? CENTRED);
  const rect = sourceRect(framed, quarter, bitmap.width, bitmap.height);

  const encodeAt = performance.now();
  let blob = await encode(bitmap, rect, A4_QUALITY, quarter);
  const encodeMs = performance.now() - encodeAt;
  // Kept apart from the first pass on purpose: whether the rescue is worth avoiding is exactly
  // what the plan left open (T-UX2-19), and one added-up number could not answer it.
  let rescueMs = 0;
  if (blob && blob.size > A4_MAX_BYTES) {
    const rescueAt = performance.now();
    blob = (await encode(bitmap, rect, A4_QUALITY_RESCUE, quarter)) ?? blob;
    rescueMs = performance.now() - rescueAt;
  }
  bitmap.close();
  if (!blob) throw new Error('POSTER_ENCODE_FAILED');

  const base64At = performance.now();
  const base64 = await toBase64(blob);
  return {
    blob,
    base64,
    width: A4_WIDTH,
    height: A4_HEIGHT,
    timings: { decodeMs, encodeMs, rescueMs, base64Ms: performance.now() - base64At },
  };
}
