import { expect, test } from '@playwright/test';
import { ADMIN_EMAIL, logIn } from './helpers';

// These start logged out, whatever the project default is.
test.use({ storageState: { cookies: [], origins: [] } });

test('an anonymous visitor is sent to login and brought back afterwards', async ({ page }) => {
	await page.goto('/executions?status=failed');
	await expect(page).toHaveURL(/\/login\?redirectTo=%2Fexecutions%3Fstatus%3Dfailed$/);

	await logIn(page);
	await expect(page).toHaveURL(/\/executions\?status=failed$/);
	await expect(page.getByRole('heading', { name: 'Executions' })).toBeVisible();
});

test('a wrong password is refused', async ({ page }) => {
	await page.goto('/login');
	await logIn(page, ADMIN_EMAIL, 'not-the-password');
	await expect(page.getByText('Invalid email or password')).toBeVisible();
	await expect(page).toHaveURL(/\/login/);
});

test('login never redirects off-site', async ({ page }) => {
	await page.goto('/login?redirectTo=https://example.com/');
	await logIn(page);
	await expect(page).toHaveURL(/\/dashboard$/);
});

test('logging out ends the session', async ({ page }) => {
	await page.goto('/login');
	await logIn(page);
	await expect(page).toHaveURL(/\/dashboard$/);

	await page.getByRole('button', { name: 'Log out' }).click();
	await expect(page).toHaveURL(/\/login$/);
	await page.goto('/dashboard');
	await expect(page).toHaveURL(/\/login\?redirectTo=/);
});
