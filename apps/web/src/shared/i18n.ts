import i18next from 'i18next';
import { initReactI18next, useTranslation } from 'react-i18next';
import { en, ko, type Copy, type Locale } from './copy/index';

const STORAGE_KEY = 'monti.locale';

export function detectLocale(): Locale {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'ko' || stored === 'en') return stored;
  } catch {
    /* private mode */
  }
  return navigator.language.toLowerCase().startsWith('ko') ? 'ko' : 'en';
}

export async function initI18n(lng?: Locale): Promise<void> {
  if (i18next.isInitialized) return;
  await i18next.use(initReactI18next).init({
    lng: lng ?? detectLocale(),
    fallbackLng: 'ko',
    resources: { ko: { translation: {} }, en: { translation: {} } },
    interpolation: { escapeValue: false },
  });
}

export async function setLocale(locale: Locale): Promise<void> {
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    /* private mode */
  }
  await i18next.changeLanguage(locale);
}

/** Typed copy for the current locale. Re-renders when the language changes. */
export function useCopy(): Copy {
  const { i18n } = useTranslation();
  return i18n.language?.startsWith('en') ? en : ko;
}

export function useLocale(): Locale {
  const { i18n } = useTranslation();
  return i18n.language?.startsWith('en') ? 'en' : 'ko';
}

export function fmt(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => String(vars[key] ?? ''));
}
