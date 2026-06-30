import { initI18nSvelte } from 'typesafe-i18n/svelte';
import { de } from './de/index.js';
import { en } from './en/index.js';

export type Locale = 'de' | 'en';

const STORAGE_KEY = 'timing-hub:locale';

const translations = { de, en } as const;

/** Detect the user's preferred locale: localStorage > navigator.language > 'de' */
function detectLocale(): Locale {
  if (typeof localStorage !== 'undefined') {
    const stored = localStorage.getItem(STORAGE_KEY) as Locale | null;
    if (stored === 'de' || stored === 'en') return stored;
  }
  if (typeof navigator !== 'undefined') {
    return navigator.language.startsWith('de') ? 'de' : 'en';
  }
  return 'de';
}

const { locale, LL, setLocale: _setLocale } = initI18nSvelte(translations);

export { locale, LL };

export function setLocale(newLocale: Locale): void {
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(STORAGE_KEY, newLocale);
  }
  _setLocale(newLocale);
}

export function initLocale(): void {
  _setLocale(detectLocale());
}
