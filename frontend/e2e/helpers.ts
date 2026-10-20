import { expect, type Page } from '@playwright/test';

export const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@duraflow.local';
export const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'changeme123';

/** A suffix that keeps names from colliding with earlier runs against the same database. */
export function uniqueSuffix(): string {
	return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export async function logIn(page: Page, email = ADMIN_EMAIL, password = ADMIN_PASSWORD) {
	await page.getByPlaceholder('you@company.com').fill(email);
	await page.getByPlaceholder('••••••••').fill(password);
	await page.getByRole('button', { name: 'Log in' }).click();
}

/** A minimal workflow zigflow can actually register and run: one `set` task. */
export function runnableDsl(id: string): string {
	return [
		'document:',
		'  dsl: 1.0.0',
		`  taskQueue: e2e-${id}`,
		`  workflowType: e2e-${id}`,
		'  version: 0.1.0',
		'do:',
		'  - greet:',
		'      set:',
		'        message: hello from e2e',
		''
	].join('\n');
}

/** Creates a project from the dashboard and opens it. */
export async function createProject(page: Page, name: string) {
	await page.goto('/dashboard');
	await page.getByRole('button', { name: 'New project' }).click();
	await page.getByPlaceholder('Order Fulfillment').fill(name);
	await page.getByRole('button', { name: 'Create project' }).click();
	await page.getByRole('link', { name, exact: true }).first().click();
	await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
}

/** Deletes a project from the dashboard, confirming by name when it still has workflows. */
export async function deleteProject(page: Page, name: string) {
	await page.goto('/dashboard');
	await page.getByRole('button', { name: `Actions for ${name}` }).click();
	await page.getByRole('menuitem', { name: 'Delete' }).click();
	const dialog = page.getByRole('dialog', { name: `Delete “${name}”?` });
	const confirm = dialog.getByRole('textbox');
	if (await confirm.isVisible()) await confirm.fill(name);
	await dialog.getByRole('button', { name: 'Delete project' }).click();
	await expect(page.getByRole('link', { name, exact: true })).toHaveCount(0);
}
