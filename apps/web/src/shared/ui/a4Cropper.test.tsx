import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  A4Cropper, A4_HEIGHT, A4_MAX_BYTES, A4_QUALITY, A4_QUALITY_RESCUE, A4_WIDTH, cropToA4,
  type CropSource,
} from './index';

/**
 * jsdom has neither `createImageBitmap` nor a canvas that encodes, so both are handed in —
 * the same seam `prepareImage` opens for `shrinkImage`. Nothing here touches real pixels; what
 * is being checked is the shape that leaves, the number of encodes, and the orientation asked
 * for, which is all this part decides.
 */
function bitmapOf(width: number, height: number): ImageBitmap {
  return { width, height, close: vi.fn() } as unknown as ImageBitmap;
}

/**
 * A real `Blob` wearing a size it does not have. `toBase64` runs for real — jsdom has
 * `FileReader`, and stripping the data URL prefix is part of what is under test — so a plain
 * object standing in for a blob would fail there rather than on what the size decides.
 */
function blobOf(size: number): Blob {
  const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' });
  return Object.defineProperty(blob, 'size', { value: size });
}

const file = new File([new Uint8Array([1, 2, 3])], 'poster.jpg', { type: 'image/jpeg' });
const readable = blobOf(1024);

describe('cropToA4', () => {
  it('always leaves A4 portrait at 150dpi, whatever shape went in', async () => {
    const encode = vi.fn(async () => readable);
    const wide = await cropToA4(file, { load: async () => bitmapOf(4000, 1000), encode });
    expect([wide.width, wide.height]).toEqual([A4_WIDTH, A4_HEIGHT]);
    expect(wide.height / wide.width).toBeCloseTo(Math.SQRT2, 3);
    expect(wide.base64).toBe('AQID');

    const tall = await cropToA4(file, { load: async () => bitmapOf(600, 5000), encode });
    expect([tall.width, tall.height]).toEqual([A4_WIDTH, A4_HEIGHT]);
  });

  it('reads an A4-shaped rectangle out of the picture rather than the whole of it', async () => {
    let rect: CropSource | null = null;
    const encode = vi.fn(async (_b: ImageBitmap, r: CropSource) => {
      rect = r;
      return readable;
    });
    await cropToA4(file, { load: async () => bitmapOf(4000, 1000), encode });
    const read = rect as CropSource | null;
    expect(read).not.toBeNull();
    // The short edge decides: 1000 tall means a 707-wide slice, centred.
    expect(read?.sh).toBeCloseTo(1000, 3);
    expect(read?.sw).toBeCloseTo((1000 * A4_WIDTH) / A4_HEIGHT, 3);
    expect(read?.sy).toBeCloseTo(0, 3);
    expect(read?.sx).toBeCloseTo((4000 - (1000 * A4_WIDTH) / A4_HEIGHT) / 2, 3);
  });

  it('encodes once when the first blob already fits', async () => {
    const encode = vi.fn(async (_b: ImageBitmap, _r: CropSource, _quality: number) => readable);
    await cropToA4(file, { load: async () => bitmapOf(2000, 3000), encode });
    expect(encode).toHaveBeenCalledTimes(1);
    expect(encode.mock.calls[0]?.[2]).toBe(A4_QUALITY);
  });

  /**
   * The cap is the reason the rescue exists: the poster travels to the pinning call as base64,
   * a third larger again, and a 600 KB blob is already 800 KB on the way out.
   */
  it('re-encodes once at the lower quality when the first blob is over the cap, and keeps that one', async () => {
    const heavy = blobOf(A4_MAX_BYTES + 1);
    const light = blobOf(120 * 1024);
    const encode = vi.fn(async (_b: ImageBitmap, _r: CropSource, quality: number) =>
      quality === A4_QUALITY ? heavy : light,
    );
    const cropped = await cropToA4(file, { load: async () => bitmapOf(2000, 3000), encode });
    expect(encode).toHaveBeenCalledTimes(2);
    expect(encode.mock.calls.map((call) => call[2])).toEqual([A4_QUALITY, A4_QUALITY_RESCUE]);
    expect(cropped.blob).toBe(light);
  });

  /**
   * A phone keeps the rotation of a photo in EXIF. Without this flag a portrait shot taken on
   * one is cropped lying on its side, which is the single most likely poster in the demo.
   */
  it('asks the browser to apply the picture own orientation', async () => {
    const createImageBitmap = vi.fn(async () => bitmapOf(2000, 3000));
    vi.stubGlobal('createImageBitmap', createImageBitmap);
    await cropToA4(file, { encode: async () => readable });
    expect(createImageBitmap).toHaveBeenCalledWith(file, { imageOrientation: 'from-image' });
    vi.unstubAllGlobals();
  });

  it('gives up rather than handing back a poster nothing encoded', async () => {
    await expect(
      cropToA4(file, { load: async () => bitmapOf(2000, 3000), encode: async () => null }),
    ).rejects.toThrow('POSTER_ENCODE_FAILED');
  });
});

describe('A4Cropper', () => {
  it('starts as a file input and shows no frame until a picture is picked', () => {
    const { container } = render(<A4Cropper onCropped={vi.fn()} />);
    expect(screen.getByLabelText('포스터 올리기')).toHaveAttribute('type', 'file');
    expect(screen.getByLabelText('포스터 올리기')).toHaveAttribute('accept', 'image/jpeg,image/png,image/webp');
    expect(container.querySelector('.a4-frame')).toBeNull();
  });
});
