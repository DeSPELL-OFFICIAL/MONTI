import { decode as decodeJpeg, encode as encodeJpeg } from 'jpeg-js';
import { PNG } from 'pngjs';

/**
 * 게이트 스냅샷이 사진 한 장에 허용하는 base64 길이(32 KB). **이 파일이 원본이고**
 * `snapshot.ts` 의 `SNAPSHOT_MAX_PHOTO_BYTES` 가 여기를 가리킨다 — 두 값이 갈라지면
 * 저장은 통과했는데 게이트가 그 티켓만 사진 없이 내보내는, 아무도 못 찾는 실패가 된다.
 */
export const PORTRAIT_MAX_BASE64_BYTES = 32 * 1024;

/**
 * 다시 인코딩할 때의 긴 변 상한. 스태프는 이 사진으로 얼굴을 **대조만** 한다 —
 * 원본 해상도를 들고 있을 이유가 없고, 들고 있으면 유출 시 잃는 것만 커진다.
 */
export const PORTRAIT_MAX_EDGE = 256;

/** 앞에서부터 써 보고 한도 안에 들어오는 첫 결과를 쓴다. */
const QUALITIES = [70, 40];

export type PortraitFailure = 'PORTRAIT_UNSUPPORTED' | 'PORTRAIT_TOO_LARGE';

/**
 * 사진을 우리 규격으로 못 만들었다는 뜻. **부르는 쪽은 원본을 저장하면 안 된다** —
 * 스냅샷은 이 필드를 JPEG 로 읽으므로(`photoJpegB64`), 원본을 그대로 넣으면 게이트가
 * 열지 못하는 바이트를 JPEG 라고 부르며 내보내게 된다.
 */
export class PortraitError extends Error {
  constructor(readonly code: PortraitFailure) {
    super(code);
    this.name = 'PortraitError';
  }
}

interface Raster {
  width: number;
  height: number;
  data: Uint8Array;
}

/**
 * 확장자도 content-type 도 믿지 않는다 — 우리가 받는 것은 base64 문자열뿐이라
 * 앞머리 바이트가 유일한 진실이다.
 */
function sniff(bytes: Buffer): 'jpeg' | 'png' | 'unknown' {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'png';
  }
  return 'unknown';
}

/**
 * 어떤 포맷이든 RGBA 픽셀로 편다. 열지 못하면 `PORTRAIT_UNSUPPORTED` 로 **던진다** —
 * 조용히 원본을 흘려보내는 길은 없다. WebP·HEIC 는 지금 디코더가 없어 여기서 걸린다
 * (Didit 의 문서와 픽스처는 JPEG 다).
 */
function decodeToRaster(bytes: Buffer): Raster {
  try {
    if (sniff(bytes) === 'jpeg') {
      return decodeJpeg(bytes, { useTArray: true, maxMemoryUsageInMB: 64 });
    }
    if (sniff(bytes) === 'png') {
      const png = PNG.sync.read(bytes);
      return { width: png.width, height: png.height, data: new Uint8Array(png.data) };
    }
  } catch {
    // 앞머리는 맞는데 본문이 깨진 파일. 아래와 같은 결론이다.
    throw new PortraitError('PORTRAIT_UNSUPPORTED');
  }
  throw new PortraitError('PORTRAIT_UNSUPPORTED');
}

/**
 * 박스(면적 평균) 축소. 최근접 이웃은 얼굴에서 계단과 모아레를 만들어 대조를 어렵게 한다.
 * 목표 픽셀 하나가 덮는 원본 사각형을 통째로 평균 낸다.
 */
function downscale(
  source: Uint8Array,
  width: number,
  height: number,
  targetWidth: number,
  targetHeight: number,
): Uint8Array {
  const out = new Uint8Array(targetWidth * targetHeight * 4);
  for (let y = 0; y < targetHeight; y += 1) {
    const top = Math.floor((y * height) / targetHeight);
    const bottom = Math.max(top + 1, Math.floor(((y + 1) * height) / targetHeight));
    for (let x = 0; x < targetWidth; x += 1) {
      const left = Math.floor((x * width) / targetWidth);
      const right = Math.max(left + 1, Math.floor(((x + 1) * width) / targetWidth));
      let r = 0;
      let g = 0;
      let b = 0;
      let count = 0;
      for (let sy = top; sy < bottom; sy += 1) {
        for (let sx = left; sx < right; sx += 1) {
          const i = (sy * width + sx) * 4;
          r += source[i] ?? 0;
          g += source[i + 1] ?? 0;
          b += source[i + 2] ?? 0;
          count += 1;
        }
      }
      const o = (y * targetWidth + x) * 4;
      out[o] = Math.round(r / count);
      out[o + 1] = Math.round(g / count);
      out[o + 2] = Math.round(b / count);
      out[o + 3] = 255;
    }
  }
  return out;
}

/**
 * Didit 이 보내 준 `portrait_image` 를 **우리 규격**(긴 변 256 px JPEG, ≤ 32 KB)으로 다시 만든다.
 * KMS 봉투에 넣기 **전에** 한 번만 돌고, 원본 바이트는 이 함수 밖으로 나가지 않는다.
 *
 * 원본은 신분증 촬영 해상도 그대로라 32 KB 스냅샷 한도를 쉽게 넘는다. 넘긴 사진은 게이트에서
 * 그 티켓만 사진 없이 나가므로(`snapshot.ts`), 저장 시점에 줄여 두는 것이 유일하게 안전한 자리다.
 * 다시 인코딩하면 EXIF(촬영 좌표·기기)도 함께 사라진다.
 *
 * **원본을 그대로 돌려주는 경로는 없다.** 열지 못한 포맷도, 줄여도 한도를 넘는 사진도
 * `PortraitError` 로 던진다 — 부르는 쪽은 사진을 저장하지 않고 넘어간다.
 */
export function normalizePortrait(base64: string): string {
  if (!base64) return '';

  const image = decodeToRaster(Buffer.from(base64, 'base64'));
  if (image.width < 1 || image.height < 1) throw new PortraitError('PORTRAIT_UNSUPPORTED');

  // 작은 사진을 늘리지 않는다. 없는 정보를 만들어 봐야 파일만 커진다.
  const scale = Math.min(1, PORTRAIT_MAX_EDGE / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const data =
    scale < 1 ? downscale(image.data, image.width, image.height, width, height) : image.data;

  for (const quality of QUALITIES) {
    const encoded = encodeJpeg({ data, width, height }, quality).data.toString('base64');
    if (encoded.length <= PORTRAIT_MAX_BASE64_BYTES) return encoded;
  }
  throw new PortraitError('PORTRAIT_TOO_LARGE');
}
