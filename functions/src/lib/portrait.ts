import { decode as decodeJpeg, encode as encodeJpeg } from 'jpeg-js';

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

/** 앞에서부터 써 보고 한도 안에 들어오는 첫 결과를 쓴다. 둘 다 넘치면 사진을 버린다. */
const QUALITIES = [70, 40];

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
 * Didit 이 보내 준 `portrait_image` 를 **우리 규격**으로 다시 만든다.
 * KMS 봉투에 넣기 **전에** 한 번만 돌고, 원본 바이트는 이 함수 밖으로 나가지 않는다.
 *
 * 원본은 신분증 촬영 해상도 그대로라 32 KB 스냅샷 한도를 쉽게 넘는다. 넘긴 사진은
 * 게이트에서 그 티켓만 사진 없이 나가므로(`snapshot.ts`), 저장 시점에 줄여 두는 것이
 * 유일하게 안전한 자리다. 다시 인코딩하면 EXIF(촬영 좌표·기기)도 함께 사라진다.
 *
 * 우리 디코더가 모르는 바이트는 손대지 않는다 — 다만 한도를 넘으면 버린다.
 * **한도를 넘긴 원본이 봉투에 들어가는 길은 없다.**
 */
export function normalizePortrait(base64: string): string {
  if (!base64) return '';

  let image: { width: number; height: number; data: Uint8Array };
  try {
    image = decodeJpeg(Buffer.from(base64, 'base64'), { useTArray: true, maxMemoryUsageInMB: 64 });
  } catch {
    return base64.length <= PORTRAIT_MAX_BASE64_BYTES ? base64 : '';
  }
  if (image.width < 1 || image.height < 1) return '';

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
  return '';
}
