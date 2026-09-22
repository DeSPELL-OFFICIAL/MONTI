/**
 * A4 portrait at 150dpi (1:√2). The poster's shape is settled before anyone picks a picture,
 * so the only choice left is which part of the picture lands inside the frame — a pan and a
 * zoom, not a free crop. That is also why no crop library is pulled in: most of one would go
 * unused, and the repo carries none today.
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

/** `scale` 1 is the picture filling the frame; the pans are in frame widths, 0 being centred. */
export interface CropView { scale: number; panX: number; panY: number }

/** `base64` is the blob without its `data:<mime>;base64,` prefix — what the pinning call takes. */
export interface CroppedPoster { blob: Blob; base64: string; width: number; height: number }

export interface CropSource { sx: number; sy: number; sw: number; sh: number }

export interface CropOptions {
  view?: CropView;
  load?: (file: File) => Promise<ImageBitmap>;
  encode?: (bitmap: ImageBitmap, rect: CropSource, quality: number) => Promise<Blob | null>;
}

export const CENTRED: CropView = { scale: 1, panX: 0, panY: 0 };

export function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
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
 * `imageOrientation: 'from-image'` is the whole reason this goes through `createImageBitmap`:
 * a phone keeps the rotation of a photo in EXIF, so without it a portrait shot taken on one
 * is cropped lying on its side.
 */
function loadBitmap(file: File): Promise<ImageBitmap> {
  return createImageBitmap(file, { imageOrientation: 'from-image' });
}

/** The crop rectangle is what lands on the canvas, so the canvas is exactly A4 and never scaled. */
function drawAndEncode(bitmap: ImageBitmap, rect: CropSource, quality: number): Promise<Blob | null> {
  const canvas = document.createElement('canvas');
  canvas.width = A4_WIDTH;
  canvas.height = A4_HEIGHT;
  const context = canvas.getContext('2d');
  if (!context) return Promise.resolve(null);
  context.drawImage(bitmap, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, A4_WIDTH, A4_HEIGHT);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}

/** The data URL is base64 already; only the prefix comes off (as `wizard/pinata.ts` does). */
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
  const bitmap = await (opts.load ?? loadBitmap)(file);
  const encode = opts.encode ?? drawAndEncode;
  const rect = cropRect(bitmap.width, bitmap.height, opts.view ?? CENTRED);
  let blob = await encode(bitmap, rect, A4_QUALITY);
  if (blob && blob.size > A4_MAX_BYTES) blob = (await encode(bitmap, rect, A4_QUALITY_RESCUE)) ?? blob;
  bitmap.close();
  if (!blob) throw new Error('POSTER_ENCODE_FAILED');
  return { blob, base64: await toBase64(blob), width: A4_WIDTH, height: A4_HEIGHT };
}
