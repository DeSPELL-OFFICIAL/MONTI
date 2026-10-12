import { useLocale } from '../../shared/i18n';
import { en, ko, type StartCopy } from './copy';

/** The open-mode screens' strings in the current language. */
export function useStartCopy(): StartCopy {
  return useLocale() === 'en' ? en : ko;
}
