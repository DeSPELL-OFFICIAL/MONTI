import { ko } from './ko';
import { en } from './en';

export type Copy = typeof ko;
export { ko, en };
export type Locale = 'ko' | 'en';
