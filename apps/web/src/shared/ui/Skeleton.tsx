import type { CSSProperties } from 'react';

export interface SkeletonProps {
  /** CSS width; a number is read as px. Defaults to filling its column. */
  width?: number | string;
  /** CSS height; a number is read as px. */
  height?: number | string;
  /** Corner radius; a number is read as px. Defaults to the token in `.skeleton`. */
  radius?: number | string;
  /** How many identical blocks to stack — a list's worth of rows from one call. */
  count?: number;
  /** An extra class for a block that has to sit in a particular grid cell. */
  className?: string;
}

const size = (value: number | string | undefined): string | undefined =>
  typeof value === 'number' ? `${value}px` : value;

/**
 * A calm grey stand-in for content that has not arrived — the shape of the thing, not a spinner
 * that says only "wait". A highlight sweeps across it (a pseudo-element moved by transform, so
 * the reduced-motion killswitch in `theme.css` freezes it to a flat grey with no flash).
 *
 * It is decoration for the eye and nothing for a screen reader — the loading region says
 * `aria-busy` on its own — so every block is `aria-hidden`.
 */
export function Skeleton({ width, height, radius, count = 1, className }: SkeletonProps) {
  const style: CSSProperties = { width: size(width), height: size(height), borderRadius: size(radius) };
  const cls = className === undefined ? 'skeleton' : `skeleton ${className}`;
  return (
    <>
      {Array.from({ length: count }, (_, index) => (
        <span key={index} className={cls} style={style} aria-hidden="true" />
      ))}
    </>
  );
}
