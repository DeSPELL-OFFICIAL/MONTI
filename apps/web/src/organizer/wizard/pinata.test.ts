import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

/**
 * The argument as the callable takes it (functions/src/functions/organizer.ts `requireMeta`),
 * typed here so the recorded call can be read field by field rather than only compared whole —
 * `category` is the one value whose *type* matters as much as its value.
 */
interface PinCall {
  orgId: string;
  meta: {
    name: string; description: string; imageCid: string;
    venue: string; category: number; region: string;
  };
}

const pinEventImage = vi.fn(async (_args: { bytesBase64: string; kind: string }) => ({
  cid: 'bafkImage',
}));
const pinEventMetadata = vi.fn(async (_args: PinCall) => ({ metadataCid: 'bafyMeta' }));
vi.mock('../../shared/api/functions', async (orig) => ({
  ...(await orig<typeof import('../../shared/api/functions')>()),
  api: { pinEventImage, pinEventMetadata },
}));

const {
  ALLOWED_IMAGE_MIMES, ImageRejected, MAX_IMAGE_BYTES, pinEventDocuments, prepareImage,
} = await import('./pinata');

function fileOf(bytes: number, mime: string, name = 'cover.jpg'): File {
  return new File([new Uint8Array(bytes)], name, { type: mime });
}

describe('prepareImage', () => {
  it('refuses a type the server would refuse', async () => {
    await expect(prepareImage(fileOf(10, 'image/gif'))).rejects.toBeInstanceOf(ImageRejected);
    await expect(prepareImage(fileOf(10, 'application/pdf'))).rejects.toMatchObject({ problem: 'imageType' });
    expect(ALLOWED_IMAGE_MIMES).toEqual(['image/jpeg', 'image/png', 'image/webp']);
  });

  it('passes a small picture through as base64 without re-encoding it', async () => {
    const prepared = await prepareImage(new File([new Uint8Array([1, 2, 3])], 'a.png', { type: 'image/png' }));
    expect(prepared.mime).toBe('image/png');
    expect(prepared.fileName).toBe('a.png');
    expect(prepared.base64).toBe('AQID');
  });

  it('shrinks a large picture before the call, and gives up rather than sending an oversized one', async () => {
    const shrinkToFit = vi.fn(async () => new File([new Uint8Array([9])], 'x.jpg', { type: 'image/jpeg' }));
    const big = fileOf(MAX_IMAGE_BYTES + 1, 'image/jpeg');
    expect((await prepareImage(big, shrinkToFit)).mime).toBe('image/jpeg');
    expect(shrinkToFit).toHaveBeenCalled();

    const stillBig = vi.fn(async () => fileOf(MAX_IMAGE_BYTES + 1, 'image/jpeg'));
    await expect(prepareImage(big, stillBig)).rejects.toMatchObject({ problem: 'imageTooLarge' });
  });

  it('caps at the two megabytes the server caps at', () => {
    expect(MAX_IMAGE_BYTES).toBe(2 * 1024 * 1024);
  });
});

describe('pinEventDocuments', () => {
  it('calls the two backend callables by argument, and never Pinata itself', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const result = await pinEventDocuments({
      orgId: '9',
      image: { base64: 'AQID', mime: 'image/png', fileName: 'a.png' },
      name: '재즈 나이트',
      description: '한남동 라이브',
      venue: '한남동 어딘가',
      category: 2,
      region: 'KR-11',
    });
    // The picture goes on its own now, and its CID is what the document carries across.
    expect(pinEventImage).toHaveBeenCalledWith({ bytesBase64: 'AQID', kind: 'poster' });
    expect(pinEventMetadata).toHaveBeenCalledWith({
      orgId: '9',
      meta: {
        name: '재즈 나이트',
        description: '한남동 라이브',
        imageCid: 'bafkImage',
        venue: '한남동 어딘가',
        category: 2,
        region: 'KR-11',
      },
    });
    expect(result).toEqual({ imageCid: 'bafkImage', metadataCid: 'bafyMeta' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  /**
   * `toHaveBeenCalledWith` would pass on the string `'2'` as readily as on the number, and the
   * server would let it through — it coerces a numeric string. The reader is what refuses it:
   * the pinned document's `category` is taken only when `typeof === 'number'`
   * (`shared/envio/ipfs.ts`), so a string reaches every discover screen as the default `0`.
   */
  it('sends the theme as the number the chain and the reader both want', async () => {
    await pinEventDocuments({
      orgId: '9',
      image: { base64: 'AQID', mime: 'image/png', fileName: 'a.png' },
      name: '재즈 나이트',
      description: '한남동 라이브',
      venue: '한남동 어딘가',
      category: 2,
      region: 'KR-11',
    });
    const call = pinEventMetadata.mock.calls.at(-1)?.[0];
    expect(typeof call?.meta.category).toBe('number');
  });
});

/**
 * The ruling this file exists for: no browser in this app ever holds a pinning token. A
 * reintroduced `VITE_PINATA_JWT` — in a config, an example env file, or a test fixture — would
 * ship that token to every visitor, so it is grepped for rather than trusted to review.
 */
describe('no pinning token reaches the browser', () => {
  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry);
      if (entry === 'node_modules' || entry === 'dist') return [];
      return statSync(path).isDirectory() ? walk(path) : [path];
    });
  }

  it('names VITE_PINATA_JWT nowhere but in this test', () => {
    const files = [...walk(join(process.cwd(), 'src')), join(process.cwd(), '.env.example')];
    const offenders = files.filter(
      (path) => path !== __filename && readFileSync(path, 'utf8').includes('VITE_PINATA_JWT'),
    );
    expect(offenders).toEqual([]);
  });
});
