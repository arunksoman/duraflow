import { fail, redirect } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { AuthError, DEV_BYPASS_TOKEN, login } from '$lib/server/auth';
import type { Actions, PageServerLoad } from './$types';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Where to go after logging in. Only a path on this site is honoured — anything else
 * (`https://…`, protocol-relative `//host`, `/\host`) would make the login page an open redirect.
 */
function safeRedirectTarget(url: URL): string {
	const target = url.searchParams.get('redirectTo') ?? '';
	if (!target.startsWith('/') || target.startsWith('//') || target.startsWith('/\\')) {
		return '/dashboard';
	}
	return target;
}

export const load: PageServerLoad = ({ locals }) => {
	if (locals.user) {
		redirect(303, '/dashboard');
	}
};

export const actions: Actions = {
	login: async ({ request, cookies, url }) => {
		const data = await request.formData();
		const email = String(data.get('email') ?? '').trim();
		const password = String(data.get('password') ?? '');

		if (!email || !password) {
			return fail(400, { email, error: 'Email and password are required.' });
		}
		if (!EMAIL_RE.test(email)) {
			return fail(400, { email, error: 'Enter a valid email address.' });
		}

		try {
			const session = await login(email, password);
			cookies.set('session', session.token, {
				path: '/',
				httpOnly: true,
				sameSite: 'strict',
				secure: !dev,
				expires: new Date(session.expiresAt)
			});
		} catch (err) {
			const message = err instanceof AuthError ? err.message : 'Something went wrong. Try again.';
			return fail(401, { email, error: message });
		}

		redirect(303, safeRedirectTarget(url));
	},

	// Dev-only shortcut so the app is reachable before a real backend exists.
	// `dev` is statically false in production builds, so this 404s there.
	devBypass: ({ cookies, url }) => {
		if (!dev) return fail(404);

		cookies.set('session', DEV_BYPASS_TOKEN, {
			path: '/',
			httpOnly: true,
			sameSite: 'strict',
			secure: false
		});

		redirect(303, safeRedirectTarget(url));
	}
};
