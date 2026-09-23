import type { ButtonHTMLAttributes } from 'react';

type Props = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'danger' };

export function Button({ variant = 'primary', ...rest }: Props) {
  return <button type="button" className={`btn btn--${variant}`} {...rest} />;
}
