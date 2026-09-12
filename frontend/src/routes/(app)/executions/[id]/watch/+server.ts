import { API_BASE_URL, authHeaders } from '$lib/server/http';
import type { RequestHandler } from './$types';

// Relays the backend's `GET /executions/{id}/watch` Server-Sent Events stream straight through to
// the browser. Browser `EventSource` can't set an Authorization header, so this same-origin route
// resolves the session cookie to a bearer token server-side (same pattern as every other
// `$lib/server/*.ts` wrapper) and forwards it on the backend request instead.
export const GET: RequestHandler = async ({ params, url, cookies, fetch }) => {
	const token = cookies.get('session');

	// `afterSeq` has to survive the hop, or a reconnecting client replays the whole run.
	const query = url.search ? url.search : '';
	const response = await fetch(`${API_BASE_URL}/executions/${params.id}/watch${query}`, {
		headers: authHeaders(token)
	});

	return new Response(response.body, {
		status: response.status,
		headers: {
			'content-type': response.headers.get('content-type') ?? 'text/event-stream',
			'cache-control': 'no-cache',
			connection: 'keep-alive'
		}
	});
};
