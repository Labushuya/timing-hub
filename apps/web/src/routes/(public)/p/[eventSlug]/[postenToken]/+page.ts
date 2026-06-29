import type { PageLoad } from './$types';

export const load: PageLoad = async ({ params }) => {
  // Token validation and session init happen client-side on mount.
  // We just pass the route params through so the page has them immediately.
  return {
    postenToken: params.postenToken ?? '',
    eventSlug: params.eventSlug ?? ''
  };
};
