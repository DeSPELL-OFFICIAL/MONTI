import { describe, expect, it } from 'vitest';
import { decode as decodeJpeg, encode as encodeJpeg } from 'jpeg-js';
import {
  PORTRAIT_MAX_BASE64_BYTES,
  PORTRAIT_MAX_EDGE,
  normalizePortrait,
} from '../src/lib/portrait.js';

/**
 * 노이즈로 채운 JPEG. 평평한 색은 거의 무한히 압축돼 "원본이 크다"를 재현하지 못한다 —
 * 실제 신분증 사진처럼 압축이 잘 안 되는 바이트가 있어야 32 KB 한도를 진짜로 넘는다.
 */
function noisyJpeg(width: number, height: number, quality = 95): string {
  const data = new Uint8Array(width * height * 4);
  let seed = 7;
  for (let i = 0; i < width * height; i += 1) {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    data[i * 4] = seed % 256;
    data[i * 4 + 1] = (seed >> 8) % 256;
    data[i * 4 + 2] = (seed >> 16) % 256;
    data[i * 4 + 3] = 255;
  }
  return encodeJpeg({ data, width, height }, quality).data.toString('base64');
}

/** 완만한 그라데이션. 압축이 잘 되므로 작은 원본을 만들 때 쓴다. */
function smoothJpeg(width: number, height: number, quality = 80): string {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      data[i] = (x * 255) / width;
      data[i + 1] = (y * 255) / height;
      data[i + 2] = 128;
      data[i + 3] = 255;
    }
  }
  return encodeJpeg({ data, width, height }, quality).data.toString('base64');
}

function dimensions(base64: string): { width: number; height: number } {
  const { width, height } = decodeJpeg(Buffer.from(base64, 'base64'), { useTArray: true });
  return { width, height };
}

describe('normalizePortrait', () => {
  it('brings an oversized Didit portrait under the 32 KB snapshot cap', () => {
    const original = noisyJpeg(1200, 1600);
    expect(original.length).toBeGreaterThan(PORTRAIT_MAX_BASE64_BYTES);

    const normalized = normalizePortrait(original);

    expect(normalized.length).toBeLessThanOrEqual(PORTRAIT_MAX_BASE64_BYTES);
    expect(normalized).not.toBe(original);
    // 여전히 JPEG 이고, 긴 변이 256 px 이며 가로세로 비율을 지킨다.
    expect(dimensions(normalized)).toEqual({ width: 192, height: PORTRAIT_MAX_EDGE });
  });

  it('re-encodes a landscape portrait on its long edge too', () => {
    const normalized = normalizePortrait(noisyJpeg(1000, 500));
    expect(dimensions(normalized)).toEqual({ width: PORTRAIT_MAX_EDGE, height: 128 });
    expect(normalized.length).toBeLessThanOrEqual(PORTRAIT_MAX_BASE64_BYTES);
  });

  it('never upscales a portrait that is already small', () => {
    const small = smoothJpeg(120, 160);
    const normalized = normalizePortrait(small);
    expect(dimensions(normalized)).toEqual({ width: 120, height: 160 });
  });

  it('strips whatever the camera attached by re-encoding, not by trusting the original bytes', () => {
    // EXIF 가 붙은 원본과 붙지 않은 원본의 결과가 같다 — 결과 바이트는 우리가 만든 것뿐이다.
    const base = smoothJpeg(300, 300);
    const withComment = encodeJpeg(
      { ...decodeJpeg(Buffer.from(base, 'base64'), { useTArray: true }), comments: ['GPS 37.5665,126.9780'] },
      80,
    ).data.toString('base64');
    expect(Buffer.from(withComment, 'base64').toString('latin1')).toContain('GPS');

    const normalized = normalizePortrait(withComment);
    expect(Buffer.from(normalized, 'base64').toString('latin1')).not.toContain('GPS');
  });

  it('leaves bytes it cannot decode alone while they fit the cap', () => {
    // 지금 쓰는 웹훅 픽스처의 모양. 잘린 JPEG 라 디코드되지 않지만 한도 안이다.
    const truncated = '/9j/4AAQSkZJRgABAQ==';
    expect(normalizePortrait(truncated)).toBe(truncated);
  });

  it('drops bytes it cannot decode once they exceed the cap', () => {
    const garbage = Buffer.alloc(40 * 1024, 0x41).toString('base64');
    expect(garbage.length).toBeGreaterThan(PORTRAIT_MAX_BASE64_BYTES);
    expect(normalizePortrait(garbage)).toBe('');
  });

  it('treats an empty portrait as no portrait', () => {
    expect(normalizePortrait('')).toBe('');
  });
});
