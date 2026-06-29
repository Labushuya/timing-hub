import type { PageLoad } from './$types';

export const load: PageLoad = async ({ params, fetch }) => {
  const slug = params['eventSlug'] ?? '';
  try {
    const res = await fetch(`/api/v1/events/${encodeURIComponent(slug)}/results`);
    if (res.ok) {
      const data = await res.json();
      return {
        results: data.results ?? [],
        event: data.event ?? null,
        computed_at: data.computed_at ?? null
      };
    }
  } catch {
    // fall through to empty state — client will retry
  }
  return { results: [], event: null, computed_at: null };
};
