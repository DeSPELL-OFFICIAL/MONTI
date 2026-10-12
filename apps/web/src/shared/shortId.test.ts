import { describe, expect, it } from 'vitest';
import { shortId } from './shortId';

describe('shortId', () => {
  it('keeps the first and last four digits of a long hex value, without 0x', () => {
    expect(shortId('0xa88FF4423777c69408c71FeBb9b40FB21a473741')).toBe('a88f…3741');
  });

  it('leaves a short value whole', () => {
    expect(shortId('0x1234')).toBe('1234');
  });
});
