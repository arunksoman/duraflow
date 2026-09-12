import { API_BASE_URL, authHeaders } from '$lib/server/http';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

// Same-origin read of an execution's recorded task events, for the browser. The builder's run
// panel needs this when its live stream reports it fell behind, and when a page is reopened on a
// run that already finished — both are client-side moments with no bearer token of their own
// (same reason the sibling `watch` route exists).
export const GET: RequestHandler = async ({ params, url, cookies, fetch }) => {
	const afterSeq = url.searchParams.get('afterSeq') ?? '0';

	const response = await fetch(
		`${API_BASE_URL}/executions/${params.id}/events?afterSeq=${encodeURIComponent(afterSeq)}`,
		{ headers: authHeaders(cookies.get('session')) }
	);

	if (!response.ok) {
		return json({ events: [], nextSeq: 0, hasMore: false }, { status: response.status });
	}
	return json(await response.json());
};
