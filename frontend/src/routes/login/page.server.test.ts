import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	expectFailure,
	expectRedirect,
	fakeCookies,
	formRequest,
	kitEvent
} from '$lib/testing/kit';
import { AuthError, DEV_BYPASS_TOKEN, login } from '$lib/server/auth';
import { actions, load } from './+page.server';

vi.mock('$lib/server/auth', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/auth')>()),
	login: vi.fn()
}));

const session = {
	token: 'tok-123',
	expiresAt: '2030-01-01T00:00:00Z',
	user: { id: 'u', email: 'a@b.co', name: 'A', role: 'admin' as const }
};

beforeEach(() => {
	vi.mocked(login).mockReset();
});

describe('login load', () => {
	it('sends a logged-in user to the dashboard', async () => {
		await expectRedirect(() => load(kitEvent({ locals: { user: session.user } })), '/dashboard');
	});

	it('shows the form otherwise', () => {
		expect(load(kitEvent({ locals: {} }))).toBeUndefined();
	});
});

describe('login action', () => {
	const submit = (fields: Record<string, string>, url = 'http://app.test/login') => {
		const cookies = fakeCookies();
		const run = () => actions.login(kitEvent({ request: formRequest(fields), cookies, url }));
		return { cookies, run };
	};

	it.each([
		[{ email: '', password: 'x' }, 'Email and password are required.'],
		[{ email: 'a@b.co', password: '' }, 'Email and password are required.'],
		[{ email: 'not-an-email', password: 'x' }, 'Enter a valid email address.']
	])('rejects %o', async (fields, error) => {
		const result = await submit(fields).run();
		expect(expectFailure(result, 400)).toEqual({ email: fields.email, error });
		expect(login).not.toHaveBeenCalled();
	});

	it('stores the session cookie and redirects', async () => {
		vi.mocked(login).mockResolvedValue(session);
		const { cookies, run } = submit({ email: ' a@b.co ', password: 'pw' });
		await expectRedirect(run, '/dashboard');

		expect(login).toHaveBeenCalledWith('a@b.co', 'pw');
		const cookie = cookies.written.get('session');
		expect(cookie?.value).toBe('tok-123');
		expect(cookie?.options).toMatchObject({ path: '/', httpOnly: true, sameSite: 'strict' });
		expect((cookie?.options?.expires as Date).toISOString()).toBe('2030-01-01T00:00:00.000Z');
	});

	it('returns to the page that asked for a login', async () => {
		vi.mocked(login).mockResolvedValue(session);
		const { run } = submit(
			{ email: 'a@b.co', password: 'pw' },
			'http://app.test/login?redirectTo=%2Fexecutions%3Fstatus%3Dfailed'
		);
		await expectRedirect(run, '/executions?status=failed');
	});

	it.each(['https://evil.example/', '//evil.example', '/\\evil.example', 'javascript:alert(1)'])(
		'never redirects off-site to %s',
		async (target) => {
			vi.mocked(login).mockResolvedValue(session);
			const { run } = submit(
				{ email: 'a@b.co', password: 'pw' },
				`http://app.test/login?redirectTo=${encodeURIComponent(target)}`
			);
			await expectRedirect(run, '/dashboard');
		}
	);

	it('shows the auth error message', async () => {
		vi.mocked(login).mockImplementation(async () => {
			throw new AuthError('Invalid email or password');
		});
		const { cookies, run } = submit({ email: 'a@b.co', password: 'bad' });
		expect(expectFailure(await run(), 401)).toEqual({
			email: 'a@b.co',
			error: 'Invalid email or password'
		});
		expect(cookies.written.size).toBe(0);
	});

	it('hides unexpected errors', async () => {
		vi.mocked(login).mockImplementation(async () => {
			throw new Error('boom');
		});
		const { run } = submit({ email: 'a@b.co', password: 'pw' });
		expect(expectFailure(await run(), 401).error).toBe('Something went wrong. Try again.');
	});
});

describe('dev bypass action', () => {
	it('sets the bypass cookie in dev', async () => {
		const cookies = fakeCookies();
		await expectRedirect(
			() =>
				actions.devBypass(kitEvent({ cookies, url: 'http://app.test/login?redirectTo=/workers' })),
			'/workers'
		);
		expect(cookies.written.get('session')?.value).toBe(DEV_BYPASS_TOKEN);
	});
});
