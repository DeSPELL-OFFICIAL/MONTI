import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { en, type Copy, type Locale } from './copy/index';

/**
 * MONTI ships English-only (global hackathon build). The browser language and any stored
 * preference are ignored and there is no fallback to another table: every screen reads `en`.
 * The `ko` tables stay in the codebase but nothing selects them.
 */
export const LOCALE: Locale = 'en';

export async function initI18n(): Promise<void> {
  if (i18next.isInitialized) return;
  await i18next.use(initReactI18next).init({
    lng: LOCALE,
    fallbackLng: LOCALE,
    resources: { en: { translation: {} } },
    interpolation: { escapeValue: false },
  });
}

/** Typed copy for the app's one locale. */
export function useCopy(): Copy {
  return en;
}

export function useLocale(): Locale {
  return LOCALE;
}

export function fmt(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => String(vars[key] ?? ''));
}
