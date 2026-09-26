import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  A4Cropper, A4_HEIGHT, A4_MAX_BYTES, A4_QUALITY, A4_QUALITY_RESCUE, A4_WIDTH, cropToA4,
  sourceRect, turnedSize, type CropSource,
} from './index';
import { ko } from '../copy/index';

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

  /**
   * The turn is the one thing panning cannot repair: a photo somebody was sent arrives a
   * quarter out and EXIF says nothing about it. What is checked here is that the frame was
   * measured on the *turned* picture and handed back in the bitmap's own coordinates — a
   * portrait photo turned upright is cropped out of a landscape rectangle.
   */
  it('reads a turned picture out of the swapped dimensions', async () => {
    const encode = vi.fn(async (_b: ImageBitmap, _r: CropSource, _q: number, _t: number) => readable);
    await cropToA4(file, { load: async () => bitmapOf(2000, 3000), quarter: 1, encode });

    const [, rect, , quarter] = encode.mock.calls[0] ?? [];
    expect(quarter).toBe(1);
    // Turned, the picture is 3000 x 2000, whose largest A4 slice is 1414 x 2000. Back in the
    // bitmap it is that slice on its side: 2000 wide and 1414 tall.
    expect(rect?.sw).toBeCloseTo(2000, 3);
    expect(rect?.sh).toBeCloseTo((2000 * A4_WIDTH) / A4_HEIGHT, 3);
    expect(rect?.sx).toBeCloseTo(0, 3);
    expect(rect?.sy).toBeCloseTo((3000 - (2000 * A4_WIDTH) / A4_HEIGHT) / 2, 3);
  });

  /** An upright picture pays nothing for a feature it is not using. */
  it('leaves the rectangle and the quarter alone when nothing was turned', async () => {
    const encode = vi.fn(async (_b: ImageBitmap, _r: CropSource, _q: number, _t: number) => readable);
    await cropToA4(file, { load: async () => bitmapOf(2000, 3000), encode });
    const [, rect, , quarter] = encode.mock.calls[0] ?? [];
    expect(quarter).toBe(0);
    // Upright, the 2000-wide picture gives a 2000 x 2829 slice — the whole width of it.
    expect(rect?.sw).toBeCloseTo(2000, 3);
    expect(rect?.sh).toBeCloseTo((2000 * A4_HEIGHT) / A4_WIDTH, 3);
    expect(sourceRect(rect as CropSource, 0, 2000, 3000)).toEqual(rect);
  });

  it('swaps the sides for the odd quarters and only those', () => {
    expect(turnedSize(2000, 3000, 0)).toEqual({ width: 2000, height: 3000 });
    expect(turnedSize(2000, 3000, 1)).toEqual({ width: 3000, height: 2000 });
    expect(turnedSize(2000, 3000, 2)).toEqual({ width: 2000, height: 3000 });
    expect(turnedSize(2000, 3000, 3)).toEqual({ width: 3000, height: 2000 });
  });

  /** Four turns is where it started, whichever way the arithmetic went. */
  it('comes back to the same rectangle after four quarters', () => {
    const rect = { sx: 100, sy: 200, sw: 400, sh: 500 };
    const once = sourceRect(rect, 1, 2000, 3000);
    const twice = sourceRect(once, 1, 3000, 2000);
    const thrice = sourceRect(twice, 1, 2000, 3000);
    const round = sourceRect(thrice, 1, 3000, 2000);
    expect(round.sx).toBeCloseTo(rect.sx, 6);
    expect(round.sy).toBeCloseTo(rect.sy, 6);
    expect(round.sw).toBeCloseTo(rect.sw, 6);
    expect(round.sh).toBeCloseTo(rect.sh, 6);
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
    expect(screen.getByLabelText(ko.poster.pick)).toHaveAttribute('type', 'file');
    expect(screen.getByLabelText(ko.poster.pick)).toHaveAttribute('accept', 'image/jpeg,image/png,image/webp');
    expect(container.querySelector('.a4-frame')).toBeNull();
  });
});
