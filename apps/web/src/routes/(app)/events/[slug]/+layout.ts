import { redirect } from '@sveltejs/kit';
import { api, APIError } from '$lib/api/client.js';

export async function load({ params }: { params: Record<string, string> }) {
  const slug = params['slug'] ?? '';

  try {
    const { event } = await api.events.getEvent(slug);
    return { event };
  } catch (err) {
    if (err instanceof APIError && err.status === 404) {
      throw redirect(302, '/dashboard');
    }
    throw err;
  }
}
