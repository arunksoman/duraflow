import { API_BASE_URL, authHeaders } from '$lib/server/http';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

// The child runs a `run: workflow` task started, for the browser. A child only becomes known once
// its first event arrives mid-run, so the run panel re-reads this while a run is in flight rather
// than relying on what page load happened to see.
export const GET: RequestHandler = async ({ params, cookies, fetch }) => {
	const response = await fetch(`${API_BASE_URL}/executions/${params.id}/children`, {
		headers: authHeaders(cookies.get('session'))
	});

	if (!response.ok) return json([], { status: response.status });
	return json(await response.json());
};
