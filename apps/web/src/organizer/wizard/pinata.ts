import { api } from '../../shared/api/functions';
import type { PreparedImage } from './buildEventMeta';

/**
 * The cover picture is pinned by the backend, not by this browser (`pinEventMetadata`,
 * functions/src/functions/organizer.ts). Everything here is what has to happen on this side
 * first: narrow the file to a type and a size the server accepts, and hand it over as base64.
 *
 * The file is named `pinata.ts` because that is where the pinning happens; nothing in this
 * module talks to Pinata, and no build of this app carries a pinning token.
 */

/** Exactly the three the server accepts. */
export const ALLOWED_IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp'] as const;

/** The server's own cap, mirrored so an oversized picture fails before it is uploaded. */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/**
 * What the wizard re-encodes down to. Well under the cap on purpose: the draft is kept in
 * `localStorage`, and base64 is a third larger again than the bytes it carries.
 */
export const TARGET_IMAGE_BYTES = 600 * 1024;

/** A cover is shown at 1200×630; anything wider is detail nobody sees. */
export const MAX_IMAGE_EDGE = 1600;

/** Tried in order, and the first result under the target wins. */
const QUALITY_STEPS = [0.85, 0.7, 0.55, 0.4] as const;

export type ImageProblem = 'imageType' | 'imageTooLarge';

/** `problem` is a copy key in `organizer/copy.ts`, not a sentence. */
export class ImageRejected extends Error {
  constructor(readonly problem: ImageProblem) {
    super(`ImageRejected: ${problem}`);
    this.name = 'ImageRejected';
  }
}

function isAllowedMime(mime: string): boolean {
  return (ALLOWED_IMAGE_MIMES as readonly string[]).includes(mime);
}

/**
 * `FileReader` rather than `btoa` over the bytes: it is what turns a picture of any size into
 * base64 without this module walking a two-megabyte array, and the data URL it produces is
 * base64 already — only the `data:<mime>;base64,` prefix has to come off.
 */
function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('IMAGE_UNREADABLE'));
    reader.onload = () => {
      const url = String(reader.result);
      resolve(url.slice(url.indexOf(',') + 1));
    };
    reader.readAsDataURL(blob);
  });
}

/**
 * Re-encodes the picture to a JPEG that fits, longest edge first and then quality. Uses the
 * canvas, so it is injected into {@link prepareImage} rather than called from it directly:
 * a test has no canvas, and a picture already small enough never reaches this at all.
 */
export async function shrinkImage(file: File): Promise<File> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new ImageRejected('imageTooLarge');
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  let smallest: Blob | null = null;
  for (const quality of QUALITY_STEPS) {
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, 'image/jpeg', quality);
    });
    if (!blob) continue;
    smallest = blob;
    if (blob.size <= TARGET_IMAGE_BYTES) break;
  }
  if (!smallest) throw new ImageRejected('imageTooLarge');
  return new File([smallest], `${file.name.replace(/\.[^.]+$/, '')}.jpg`, { type: 'image/jpeg' });
}

/**
 * The chosen file as the draft carries it. A picture already under the target is kept as it
 * is — re-encoding a small PNG only makes it worse — and anything larger is re-encoded once.
 * A picture still over the server's cap after that is refused here rather than at the server.
 */
export async function prepareImage(
  file: File,
  shrink: (file: File) => Promise<File> = shrinkImage,
): Promise<PreparedImage> {
  if (!isAllowedMime(file.type)) throw new ImageRejected('imageType');
  const fitted = file.size <= TARGET_IMAGE_BYTES ? file : await shrink(file);
  if (fitted.size > MAX_IMAGE_BYTES) throw new ImageRejected('imageTooLarge');
  return { base64: await toBase64(fitted), mime: fitted.type, fileName: fitted.name };
}

export interface PinnedEvent {
  /** The picture itself. Referenced by the metadata document; nothing on chain points at it. */
  imageCid: string;
  /** The metadata document. This is what `EventMeta.imageCid` carries. */
  metadataCid: string;
}

/**
 * Pins the picture and the metadata document in one server call. `meta` is exactly the two
 * readable fields the document carries beside the image — the same `{ name, description,
 * image }` the discover screens read back.
 */
export async function pinEventImage(args: {
  orgId: string;
  image: PreparedImage;
  name: string;
  description: string;
}): Promise<PinnedEvent> {
  return api.pinEventMetadata({
    orgId: args.orgId,
    image: { base64: args.image.base64, mime: args.image.mime },
    meta: { name: args.name, description: args.description },
  });
}
