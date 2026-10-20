import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { createRawSnippet } from 'svelte';
import { resetForms, settled, submissions } from '$lib/testing/forms';
import { page } from '$app/state';
import Login from './login/+page.svelte';
import Landing from './+page.svelte';
import Docs from './docs/+page.svelte';
import RootLayout from './+layout.svelte';
import AppLayout from './(app)/+layout.svelte';

vi.mock('$app/forms', () => import('$lib/testing/forms'));
vi.mock('$app/state', () => ({ page: { url: new URL('http://app.test/dashboard') } }));

beforeEach(() => {
	resetForms();
});

const child = createRawSnippet(() => ({ render: () => '<p>page content</p>' }));

describe('login page', () => {
	it('submits credentials', async () => {
		const screen = render(Login, { form: null, data: {}, params: {} } as never);
		await screen.getByPlaceholder('you@company.com').fill('ada@example.com');
		await screen.getByPlaceholder('••••••••').fill('pw');
		await screen.getByRole('button', { name: 'Log in' }).click();
		await settled();
		expect(submissions[0].action).toBe('?/login');
		expect(Object.fromEntries(submissions[0].data)).toEqual({
			email: 'ada@example.com',
			password: 'pw'
		});
	});

	it('keeps redirectTo on the form actions', async () => {
		// A bare `?/login` action would replace the query string and drop it.
		const original = page.url;
		(page as { url: URL }).url = new URL('http://app.test/login?redirectTo=%2Fexecutions%3Fa%3D1');
		try {
			const screen = render(Login, { form: null, data: {}, params: {} } as never);
			const actionOf = (name: RegExp) =>
				screen.getByRole('button', { name }).element().closest('form')?.getAttribute('action');
			expect(actionOf(/^Log in$/)).toBe('?/login&redirectTo=%2Fexecutions%3Fa%3D1');
			expect(actionOf(/Continue as demo user/)).toBe(
				'?/devBypass&redirectTo=%2Fexecutions%3Fa%3D1'
			);
		} finally {
			(page as { url: URL }).url = original;
		}
	});

	it('shows the error and keeps the email', async () => {
		const screen = render(Login, {
			form: { error: 'Invalid email or password', email: 'ada@example.com' },
			data: {},
			params: {}
		} as never);
		await expect.element(screen.getByText('Invalid email or password')).toBeVisible();
		await expect.element(screen.getByPlaceholder('you@company.com')).toHaveValue('ada@example.com');
	});

	it('reveals the password on request', async () => {
		const screen = render(Login, { form: null, data: {}, params: {} } as never);
		const password = screen.getByPlaceholder('••••••••');
		await expect.element(password).toHaveAttribute('type', 'password');
		await screen.getByLabelText('Show password').click();
		await expect.element(password).toHaveAttribute('type', 'text');
		await screen.getByLabelText('Hide password').click();
		await expect.element(password).toHaveAttribute('type', 'password');
	});

	it('offers the dev bypass in dev', async () => {
		const screen = render(Login, { form: null, data: {}, params: {} } as never);
		const bypass = screen.getByRole('button', { name: /Continue as demo user/ });
		expect(bypass.element().closest('form')?.getAttribute('action')).toBe('?/devBypass');
	});
});

describe('landing page', () => {
	it('points visitors at sign-in and members at the dashboard', async () => {
		const visitor = render(Landing, { data: { loggedIn: false }, params: {} } as never);
		await expect
			.element(visitor.getByRole('link', { name: 'Sign in' }).first())
			.toHaveAttribute('href', '/login');
		visitor.unmount();

		const member = render(Landing, { data: { loggedIn: true }, params: {} } as never);
		await expect
			.element(member.getByRole('link', { name: 'Go to dashboard' }).first())
			.toHaveAttribute('href', '/dashboard');
	});
});

describe('docs page', () => {
	it('links back home', async () => {
		const screen = render(Docs);
		await expect.element(screen.getByText('Documentation is on its way')).toBeVisible();
		await expect
			.element(screen.getByRole('link', { name: 'Back home' }))
			.toHaveAttribute('href', '/');
	});
});

describe('layouts', () => {
	it('root layout renders the page and its locale links', async () => {
		const screen = render(RootLayout, { children: child } as never);
		await expect.element(screen.getByText('page content')).toBeVisible();
		expect(screen.container.querySelector('a[href="/dashboard"]')).not.toBeNull();
	});

	it('app layout wraps the page with the sidebar and top bar', async () => {
		const user = { id: 'u', email: 'a@b.co', name: 'Ada', role: 'admin' };
		const screen = render(AppLayout, { data: { user }, children: child, params: {} } as never);
		await expect.element(screen.getByText('page content')).toBeVisible();
		await expect.element(screen.getByText('Ada')).toBeVisible();
		await expect.element(screen.getByRole('link', { name: 'Executions' })).toBeVisible();
	});
});
