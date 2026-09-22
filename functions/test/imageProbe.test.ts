import { describe, expect, it } from 'vitest';
import { encode as encodeJpeg } from 'jpeg-js';
import { PNG } from 'pngjs';
import { ImageProbeError, probeImage } from '../src/lib/imageProbe.js';

const MAX_EDGE = 4000;

/** 진짜 인코더가 뱉은 JPEG. 손으로 지은 바이트만 보면 실제 파일에서 깨지는 회귀를 놓친다. */
function realJpeg(width: number, height: number): Buffer {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = (i * 7) % 256;
    data[i * 4 + 1] = (i * 13) % 256;
    data[i * 4 + 2] = (i * 29) % 256;
    data[i * 4 + 3] = 255;
  }
  return Buffer.from(encodeJpeg({ data, width, height }, 80).data);
}

function realPng(width: number, height: number): Buffer {
  const png = new PNG({ width, height });
  png.data.fill(200);
  return PNG.sync.write(png);
}

/**
 * 치수만 적힌 PNG 앞머리 24바이트. **픽셀을 담지 않는다** — 20000×20000 을 주장하는 파일을
 * 실제로 만들지 않고도 거절을 시험할 수 있다는 것이 헤더만 읽는 설계의 요점이다.
 */
function pngHeader(width: number, height: number): Buffer {
  const out = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(out, 0);
  out.writeUInt32BE(13, 8);
  out.write('IHDR', 12, 'latin1');
  out.writeUInt32BE(width, 16);
  out.writeUInt32BE(height, 20);
  return out;
}

/** `FF D8` 뒤에 길이 있는 세그먼트 하나를 두고 그다음에 SOF0 를 둔 JPEG 앞머리. */
function jpegHeader(width: number, height: number, marker = 0xc0): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);
  const sof = Buffer.alloc(11);
  sof.writeUInt8(0xff, 0);
  sof.writeUInt8(marker, 1);
  sof.writeUInt16BE(0x0011, 2);
  sof.writeUInt8(8, 4);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  const soi = Buffer.from([0xff, 0xd8]);
  return Buffer.concat([soi, app0, sof]);
}

describe('probeImage', () => {
  it('reads the size of a real JPEG without decoding a single pixel', () => {
    const probe = probeImage(realJpeg(64, 96), MAX_EDGE);
    expect(probe).toMatchObject({ format: 'jpeg', mime: 'image/jpeg', extension: 'jpg', width: 64, height: 96 });
  });

  it('reads the size of a real PNG', () => {
    const probe = probeImage(realPng(120, 40), MAX_EDGE);
    expect(probe).toMatchObject({ format: 'png', mime: 'image/png', extension: 'png', width: 120, height: 40 });
  });

  /** 포스터는 A4 세로(1240×1754)다. 폭과 높이를 맞바꾸면 세로 포스터가 가로로 뒤집힌다. */
  it('does not swap width and height — JPEG writes height first, PNG writes width first', () => {
    expect(probeImage(jpegHeader(1240, 1754), MAX_EDGE)).toMatchObject({ width: 1240, height: 1754 });
    expect(probeImage(pngHeader(1240, 1754), MAX_EDGE)).toMatchObject({ width: 1240, height: 1754 });
  });

  it('finds the frame header behind progressive and arithmetic SOF markers too', () => {
    // 0xc2 는 프로그레시브 JPEG — 폰 카메라와 브라우저 인코더가 흔히 쓴다.
    for (const marker of [0xc0, 0xc1, 0xc2, 0xc3, 0xc9, 0xca]) {
      expect(probeImage(jpegHeader(800, 600, marker), MAX_EDGE), `marker ${marker}`).toMatchObject({
        width: 800,
        height: 600,
      });
    }
  });

  it('never mistakes a huffman or quantisation table for a frame header', () => {
    // 0xc4(DHT)·0xc8(JPG)·0xcc(DAC) 는 0xc0–0xcf 범위 안이지만 치수를 적지 않는다.
    for (const marker of [0xc4, 0xc8, 0xcc]) {
      expect(() => probeImage(jpegHeader(800, 600, marker), MAX_EDGE), `marker ${marker}`).toThrow(
        'BAD_IMAGE_FORMAT',
      );
    }
  });

  /**
   * 600 KB 짜리 PNG 안에 20000×20000 이 들어간다(압축 폭탄). 헤더만 읽기 때문에
   * 그 파일을 펴지 않고 거절한다 — 펴서 재려 하면 재려던 바로 그 공격에 먼저 당한다.
   */
  it('rejects an oversized canvas from the header alone, without expanding it', () => {
    expect(() => probeImage(pngHeader(20_000, 20_000), MAX_EDGE)).toThrow(ImageProbeError);
    expect(() => probeImage(pngHeader(20_000, 20_000), MAX_EDGE)).toThrow('BAD_IMAGE_DIMENSIONS');
    expect(() => probeImage(jpegHeader(4001, 10), MAX_EDGE)).toThrow('BAD_IMAGE_DIMENSIONS');
    expect(() => probeImage(jpegHeader(10, 4001), MAX_EDGE)).toThrow('BAD_IMAGE_DIMENSIONS');
  });

  it('takes the 4000 px edge exactly and refuses a zero-sized canvas', () => {
    expect(probeImage(pngHeader(MAX_EDGE, MAX_EDGE), MAX_EDGE)).toMatchObject({ width: MAX_EDGE });
    expect(() => probeImage(pngHeader(0, 10), MAX_EDGE)).toThrow('BAD_IMAGE_DIMENSIONS');
    expect(() => probeImage(pngHeader(10, 0), MAX_EDGE)).toThrow('BAD_IMAGE_DIMENSIONS');
  });

  it('refuses every format that is not JPEG or PNG, whatever the bytes claim', () => {
    for (const bytes of [
      Buffer.from('GIF89a'),
      Buffer.from('RIFF0000WEBPVP8 '), // webp — 옛 경로는 받았다
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      Buffer.from('%PDF-1.4'),
      Buffer.alloc(0),
      Buffer.from([0xff, 0xd8]), // JPEG 앞머리가 잘린 파일
    ]) {
      expect(() => probeImage(bytes, MAX_EDGE)).toThrow('BAD_IMAGE_FORMAT');
    }
  });

  it('refuses a JPEG whose markers are corrupt instead of looping forever', () => {
    // 길이 0 은 스스로를 가리키는 세그먼트라 앞으로 나아가지 않는다.
    const zeroLength = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0x00, 0x00]);
    expect(() => probeImage(zeroLength, MAX_EDGE)).toThrow('BAD_IMAGE_FORMAT');
    // 표식 자리에 0xff 가 아닌 바이트.
    const notAMarker = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0x12, 0x34]);
    expect(() => probeImage(notAMarker, MAX_EDGE)).toThrow('BAD_IMAGE_FORMAT');
  });

  it('refuses a PNG whose first chunk is not IHDR', () => {
    const wrong = pngHeader(10, 10);
    wrong.write('IDAT', 12, 'latin1');
    expect(() => probeImage(wrong, MAX_EDGE)).toThrow('BAD_IMAGE_FORMAT');
  });
});
