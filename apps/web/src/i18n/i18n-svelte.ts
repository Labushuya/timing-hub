// Re-export the typesafe-i18n Svelte adapter.
// The initI18nSvelte function and the initialized stores (LL, locale, setLocale)
// are exported from the main i18n index; import from there in components.
export { initI18nSvelte } from 'typesafe-i18n/svelte';
