import { describe, expect, it, vi } from 'vitest';
import type { RequestEvent, ResolveOptions } from '@sveltejs/kit';
import { fakeCookies } from '$lib/testing/kit';
import { getSessionUser } from '$lib/server/auth';
import { handle } from './hooks.server';
import { reroute } from './hooks';

// Kit's own `sequence` needs the request store a real server sets up; this one chains the handlers
// the same way (each handler's resolve options are merged into the next), which is all handle needs.
vi.mock('@sveltejs/kit/hooks', () => ({
	sequence:
		(...handlers: import('@sveltejs/kit').Handle[]): import('@sveltejs/kit').Handle =>
		({ event, resolve }) => {
			const apply = (
				i: number,
				e: RequestEvent,
				opts?: ResolveOptions
			): ReturnType<typeof resolve> =>
				i < handlers.length
					? handlers[i]({ event: e, resolve: (next, o) => apply(i + 1, next, { ...opts, ...o }) })
					: resolve(e, opts);
			return apply(0, event);
		}
}));

vi.mock('$lib/server/auth', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/auth')>()),
	getSessionUser: vi.fn()
}));

describe('handle', () => {
	it('resolves the session user and localises the page shell', async () => {
		const user = { id: 'u', email: 'a@b.co', name: 'A', role: 'admin' as const };
		vi.mocked(getSessionUser).mockResolvedValueOnce(user);

		const event = {
			cookies: fakeCookies({ session: 'tok' }),
			request: new Request('http://app.test/dashboard'),
			url: new URL('http://app.test/dashboard'),
			locals: {} as App.Locals
		} as unknown as RequestEvent;

		let chunk = '';
		const resolve = vi.fn(async (e: RequestEvent, opts?: ResolveOptions) => {
			chunk =
				(await opts?.transformPageChunk?.({
					html: '<html lang="%paraglide.lang%" dir="%paraglide.dir%">',
					done: true
				})) ?? '';
			return new Response('ok');
		});

		const response = await handle({ event, resolve });
		expect(await response.text()).toBe('ok');
		expect(getSessionUser).toHaveBeenCalledWith('tok');
		expect(event.locals.user).toEqual(user);
		expect(chunk).toBe('<html lang="en" dir="ltr">');
	});
});

describe('reroute', () => {
	it('strips any locale prefix from the path', () => {
		expect(reroute({ url: new URL('http://app.test/dashboard') } as never)).toBe('/dashboard');
	});
});
