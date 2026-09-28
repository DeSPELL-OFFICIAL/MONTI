/**
 * 올라온 이미지의 **머리 바이트만** 읽어 포맷과 치수를 알아낸다.
 *
 * `lib/portrait.ts` 와 같은 규칙에서 출발한다 — 확장자도 content-type 도 믿지 않고
 * 앞머리 바이트가 유일한 진실이다. 다른 점은 **픽셀을 펴지 않는다**는 것 하나다.
 *
 * 포스터는 600 KB 까지 받는데, 그 안에 20000×20000 PNG 가 들어간다(압축 폭탄).
 * `PNG.sync.read` 도 `jpeg-js.decode` 도 치수를 알려면 먼저 그 버퍼를 통째로 펴므로,
 * 치수 검사를 하려고 디코드하면 검사하려던 바로 그 공격에 먼저 당한다.
 * JPEG 의 SOF 와 PNG 의 IHDR 는 둘 다 파일 앞쪽 수십 바이트라 펴지 않고 읽을 수 있다.
 */

export type ImageFormat = 'jpeg' | 'png';

export type ImageProbeFailure = 'BAD_IMAGE_FORMAT' | 'BAD_IMAGE_DIMENSIONS';

export class ImageProbeError extends Error {
  constructor(readonly code: ImageProbeFailure) {
    super(code);
    this.name = 'ImageProbeError';
  }
}

export interface ImageProbe {
  format: ImageFormat;
  /** 브라우저가 바로 그릴 수 있는 형식만 나간다 — 클라이언트가 보낸 이름이 아니라 바이트에서 온다. */
  mime: string;
  extension: string;
  width: number;
  height: number;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 크기를 적은 프레임 머리(SOF). `0xc4`(DHT)·`0xc8`(JPG)·`0xcc`(DAC) 는 프레임이 아니다. */
function isStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

/**
 * JPEG 의 세그먼트를 앞에서부터 건너뛰며 첫 SOF 를 찾는다. 픽셀 데이터에는 닿지 않는다.
 * 손상된 길이 필드로 무한히 돌지 않도록 언제나 앞으로만 간다.
 */
function probeJpeg(bytes: Buffer): { width: number; height: number } {
  let i = 2;
  while (i + 1 < bytes.length) {
    if (bytes[i] !== 0xff) throw new ImageProbeError('BAD_IMAGE_FORMAT');
    const marker = bytes[i + 1] as number;
    // 채움 바이트(0xff 연속)는 한 칸씩 넘긴다.
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    // 길이 없는 표식 — SOI·TEM·RSTn.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker === 0xd9) break; // EOI — SOF 없이 끝났다.
    if (i + 3 >= bytes.length) break;
    const length = bytes.readUInt16BE(i + 2);
    if (length < 2) throw new ImageProbeError('BAD_IMAGE_FORMAT');
    if (isStartOfFrame(marker)) {
      if (i + 9 > bytes.length) throw new ImageProbeError('BAD_IMAGE_FORMAT');
      return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) };
    }
    i += 2 + length;
  }
  throw new ImageProbeError('BAD_IMAGE_FORMAT');
}

/** PNG 의 첫 청크는 규격상 언제나 IHDR 이고 폭·높이가 그 앞 8바이트다. */
function probePng(bytes: Buffer): { width: number; height: number } {
  if (bytes.length < 24 || bytes.subarray(12, 16).toString('latin1') !== 'IHDR') {
    throw new ImageProbeError('BAD_IMAGE_FORMAT');
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/**
 * 포맷과 치수를 돌려준다. 열 수 없는 바이트는 `BAD_IMAGE_FORMAT`, 0 이하이거나
 * `maxEdge` 를 넘는 치수는 `BAD_IMAGE_DIMENSIONS` 로 **던진다** —
 * 조용히 원본을 흘려보내는 길은 없다(`lib/portrait.ts` 와 같은 약속).
 */
export function probeImage(bytes: Buffer, maxEdge: number): ImageProbe {
  let format: ImageFormat;
  let size: { width: number; height: number };

  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    format = 'jpeg';
    size = probeJpeg(bytes);
  } else if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    format = 'png';
    size = probePng(bytes);
  } else {
    throw new ImageProbeError('BAD_IMAGE_FORMAT');
  }

  if (size.width < 1 || size.height < 1 || size.width > maxEdge || size.height > maxEdge) {
    throw new ImageProbeError('BAD_IMAGE_DIMENSIONS');
  }

  return {
    format,
    mime: format === 'jpeg' ? 'image/jpeg' : 'image/png',
    extension: format === 'jpeg' ? 'jpg' : 'png',
    width: size.width,
    height: size.height,
  };
}
