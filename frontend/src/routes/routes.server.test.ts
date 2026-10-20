// The small route files that don't warrant a test file each: the app gate, the landing page,
// logout, the workers page and the three same-origin relays the browser talks to.
import { describe, expect, it, vi } from 'vitest';
import { data, expectRedirect, fakeCookies, kitEvent } from '$lib/testing/kit';
import { API_BASE_URL } from '$lib/server/http';
import { listWorkers } from '$lib/server/workers';
import { load as appLayoutLoad } from './(app)/+layout.server';
import { load as landingLoad } from './+page.server';
import { POST as logout } from './logout/+server';
import { load as workersLoad } from './(app)/workers/+page.server';
import { GET as childrenRelay } from './(app)/executions/[id]/children/+server';
import { GET as eventsRelay } from './(app)/executions/[id]/events/+server';
import { GET as watchRelay } from './(app)/executions/[id]/watch/+server';

vi.mock('$lib/server/workers', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/workers')>()),
	listWorkers: vi.fn()
}));

const user = { id: 'u', email: 'a@b.co', name: 'A', role: 'admin' as const };

describe('(app) layout gate', () => {
	it('redirects anonymous visitors to login, remembering where they were going', async () => {
		await expectRedirect(
			() => appLayoutLoad(kitEvent({ url: 'http://app.test/executions?status=failed' })),
			'/login?redirectTo=%2Fexecutions%3Fstatus%3Dfailed'
		);
	});

	it('passes the user through', async () => {
		expect(await appLayoutLoad(kitEvent({ locals: { user } }))).toEqual({ user });
	});
});

describe('landing page', () => {
	it('reports whether someone is logged in', async () => {
		expect(await landingLoad(kitEvent({ locals: { user } }))).toEqual({ loggedIn: true });
		expect(await landingLoad(kitEvent({ locals: {} }))).toEqual({ loggedIn: false });
	});
});

describe('logout', () => {
	it('drops the session cookie and goes to login', async () => {
		const cookies = fakeCookies({ session: 'tok' });
		await expectRedirect(() => logout(kitEvent({ cookies })), '/login');
		expect(cookies.deleted).toEqual(['session']);
		expect(cookies.get('session')).toBeUndefined();
	});
});

describe('workers page', () => {
	it('lists workers', async () => {
		vi.mocked(listWorkers).mockResolvedValueOnce([{ id: 'w' } as never]);
		expect(data(await workersLoad(kitEvent({})))).toEqual({
			workers: [{ id: 'w' }],
			apiError: false
		});
		expect(listWorkers).toHaveBeenCalledWith('tok');
	});

	it('degrades to an empty list when the API is down', async () => {
		vi.mocked(listWorkers).mockRejectedValueOnce(new Error('down'));
		expect(data(await workersLoad(kitEvent({})))).toEqual({ workers: [], apiError: true });
	});
});

/** A fetch stub that answers once and records what it was asked. */
function stubFetch(response: Response) {
	return vi.fn<typeof fetch>().mockResolvedValue(response);
}

describe('execution relays', () => {
	it('relays child runs with the session token', async () => {
		const fetch = stubFetch(Response.json([{ id: 'c' }]));
		const res = await childrenRelay(kitEvent({ params: { id: 'e1' }, fetch }));
		expect(await res.json()).toEqual([{ id: 'c' }]);
		expect(fetch).toHaveBeenCalledWith(`${API_BASE_URL}/executions/e1/children`, {
			headers: { authorization: 'Bearer tok' }
		});

		const failed = await childrenRelay(
			kitEvent({ params: { id: 'e1' }, fetch: stubFetch(new Response(null, { status: 404 })) })
		);
		expect(failed.status).toBe(404);
		expect(await failed.json()).toEqual([]);
	});

	it('relays the event log, keeping afterSeq', async () => {
		const page = { events: [{ seq: 4 }], nextSeq: 4, hasMore: false };
		const fetch = stubFetch(Response.json(page));
		const res = await eventsRelay(
			kitEvent({ params: { id: 'e1' }, url: 'http://app.test/x?afterSeq=3', fetch })
		);
		expect(await res.json()).toEqual(page);
		expect(String(fetch.mock.calls[0][0])).toBe(`${API_BASE_URL}/executions/e1/events?afterSeq=3`);

		const defaulted = stubFetch(Response.json(page));
		await eventsRelay(kitEvent({ params: { id: 'e1' }, fetch: defaulted }));
		expect(String(defaulted.mock.calls[0][0])).toContain('afterSeq=0');

		const failed = await eventsRelay(
			kitEvent({ params: { id: 'e1' }, fetch: stubFetch(new Response(null, { status: 500 })) })
		);
		expect(failed.status).toBe(500);
		expect(await failed.json()).toEqual({ events: [], nextSeq: 0, hasMore: false });
	});

	it('streams the watch feed through untouched', async () => {
		const upstream = new Response('event: status\ndata: {}\n\n', {
			headers: { 'content-type': 'text/event-stream; charset=utf-8' }
		});
		const fetch = stubFetch(upstream);
		const res = await watchRelay(
			kitEvent({ params: { id: 'e1' }, url: 'http://app.test/x?afterSeq=9', fetch })
		);
		expect(String(fetch.mock.calls[0][0])).toBe(`${API_BASE_URL}/executions/e1/watch?afterSeq=9`);
		expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
		expect(res.headers.get('cache-control')).toBe('no-cache');
		expect(await res.text()).toBe('event: status\ndata: {}\n\n');

		const bare = stubFetch(new Response('x', { status: 401 }));
		const unauthorized = await watchRelay(kitEvent({ params: { id: 'e1' }, fetch: bare }));
		expect(String(bare.mock.calls[0][0])).toBe(`${API_BASE_URL}/executions/e1/watch`);
		expect(unauthorized.status).toBe(401);
	});
});
