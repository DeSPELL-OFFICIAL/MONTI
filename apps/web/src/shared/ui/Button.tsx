import type { ButtonHTMLAttributes } from 'react';
import { Pressable } from '../motion';

type Props = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'danger' };

export function Button({ variant = 'primary', ...rest }: Props) {
  return <Pressable type="button" className={`btn btn--${variant}`} {...rest} />;
}
