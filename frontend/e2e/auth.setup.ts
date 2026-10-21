import { expect, test as setup } from '@playwright/test';
import { logIn } from './helpers';

// Logs in once as the seeded admin; every other spec reuses the session cookie.
setup('log in as the seeded admin', async ({ page }) => {
	await page.goto('/login');
	await logIn(page);
	await expect(page).toHaveURL(/\/dashboard$/);
	await page.context().storageState({ path: 'e2e/.auth/admin.json' });
});
