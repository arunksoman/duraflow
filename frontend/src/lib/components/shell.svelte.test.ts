import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import Sidebar from './Sidebar.svelte';
import Topbar from './Topbar.svelte';
import { getCurrentTheme } from '$lib/utils/theme.svelte';

vi.mock('$app/state', () => ({ page: { url: new URL('http://app.test/workers') } }));

describe('Sidebar', () => {
	it('links every section and marks the current one', async () => {
		const screen = render(Sidebar);
		const links = screen.getByRole('link');
		expect(links.elements().map((a) => a.getAttribute('href'))).toEqual([
			'/dashboard',
			'/workers',
			'/executions'
		]);
		await expect.element(screen.getByRole('link', { name: 'Workers' })).toHaveClass('text-primary');
		await expect
			.element(screen.getByRole('link', { name: 'Dashboard' }))
			.not.toHaveClass('text-primary');
	});
});

describe('Topbar', () => {
	const user = { id: 'u', email: 'a@b.co', name: 'ada', role: 'designer' as const };

	it('shows the user and a logout form', async () => {
		const screen = render(Topbar, { user });
		await expect.element(screen.getByText('ada')).toBeVisible();
		await expect.element(screen.getByText('designer')).toBeVisible();
		await expect.element(screen.getByText('A', { exact: true })).toBeVisible();
		const logout = screen.getByRole('button', { name: 'Log out' });
		expect(logout.element().closest('form')?.getAttribute('action')).toBe('/logout');
	});

	it('toggles the theme and remembers it', async () => {
		document.documentElement.setAttribute('data-theme', 'light');
		const screen = render(Topbar, { user });
		const before = getCurrentTheme();
		const after = before === 'dark' ? 'light' : 'dark';

		await screen.getByTitle(/Switch to (dark|light) mode/).click();
		expect(getCurrentTheme()).toBe(after);
		expect(document.documentElement.getAttribute('data-theme')).toBe(after);
		expect(localStorage.getItem('duraflow-theme')).toBe(after);

		await screen.getByTitle(/Switch to (dark|light) mode/).click();
		expect(getCurrentTheme()).toBe(before);
	});
});
