import type { LayoutLoad } from './$types';

export const ssr = false; // SPA mode — auth is client-side

export const load: LayoutLoad = async () => {
  return {};
};
