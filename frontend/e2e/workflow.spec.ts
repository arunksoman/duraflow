import { expect, test } from '@playwright/test';
import { createProject, deleteProject, runnableDsl, uniqueSuffix } from './helpers';

/**
 * The path a user takes through the whole product: a project, a workflow designed in the builder,
 * saved (the worker pool starts polling its task queue), run through Temporal, then inspected and
 * cleaned up.
 */
test('design, run and inspect a workflow end to end', async ({ page }) => {
	const id = uniqueSuffix();
	const projectName = `E2E ${id}`;
	const workflowName = `Greeter ${id}`;

	await createProject(page, projectName);

	// ── Create the workflow: lands in the builder ──────────────────────────
	await page.getByRole('button', { name: 'New workflow' }).click();
	await page.getByPlaceholder('Order Fulfillment').fill(workflowName);
	await page.getByRole('button', { name: 'Create workflow' }).click();
	await expect(page).toHaveURL(/\/workflows\/[^/]+\/builder$/);
	await expect(page.getByText(workflowName).first()).toBeVisible();

	// ── Design it as DSL text; the canvas follows ──────────────────────────
	await page.getByRole('button', { name: 'DSL' }).click();
	await page.locator('.modal .cm-content').fill(runnableDsl(id));
	await expect(page.locator('.svelte-flow__node', { hasText: 'greet' })).toBeVisible();
	await page.getByRole('button', { name: '✕' }).click();

	// ── Save: the backend stores the DSL as a new version ──────────────────
	await page.getByRole('button', { name: 'Save' }).click();
	await expect(page.getByRole('button', { name: 'Saved' })).toBeVisible();

	// ── Run it from the builder and watch it finish ────────────────────────
	await page.getByRole('button', { name: 'Run', exact: true }).click();
	const runWindow = page.getByRole('dialog', { name: `Run ${workflowName}` });
	await expect(runWindow).toBeVisible();
	await expect(runWindow.getByText('completed', { exact: true })).toBeVisible({ timeout: 90_000 });

	// Its node shows what it did.
	await runWindow.locator('.svelte-flow__node', { hasText: 'greet' }).click();
	await expect(runWindow.getByText('"hello from e2e"').first()).toBeVisible();
	await runWindow.getByRole('button', { name: 'Close run window' }).click();

	// ── A worker process polling the workflow's task queue is listed ───────
	await page.goto('/workers');
	const workerRow = page.getByRole('row', { name: new RegExp(`e2e-${id}`) }).first();
	await expect(workerRow).toContainText('online');

	// ── The run is in the executions list, and opens on its own page ───────
	await page.goto('/executions');
	const runRow = page.getByRole('row', { name: new RegExp(workflowName) });
	await expect(runRow).toContainText('completed');
	await expect(runRow).toContainText('manual');
	await runRow.getByRole('link', { name: workflowName }).click();
	await expect(page.getByRole('heading', { name: workflowName })).toBeVisible();
	await expect(page.locator('.svelte-flow__node', { hasText: 'greet' })).toBeVisible();

	// ── Delete the run from its page ───────────────────────────────────────
	await page.getByRole('button', { name: 'Delete', exact: true }).click();
	await page
		.getByRole('dialog', { name: 'Delete this run?' })
		.getByRole('button', { name: 'Delete' })
		.click();
	await expect(page).toHaveURL(/\/executions$/);
	await expect(page.getByRole('row', { name: new RegExp(workflowName) })).toHaveCount(0);

	// ── Deleting the project stops the pool polling the workflow's queue ───
	await deleteProject(page, projectName);
	await expect(async () => {
		await page.goto('/workers');
		const rows = page.getByRole('row', { name: new RegExp(`e2e-${id}`) });
		await expect(rows.filter({ hasText: 'online' })).toHaveCount(0);
	}).toPass({ timeout: 30_000 });
});

test('a failing run shows its error', async ({ page }) => {
	const id = uniqueSuffix();
	const projectName = `E2E fail ${id}`;
	const workflowName = `Raiser ${id}`;

	await createProject(page, projectName);
	await page.getByRole('button', { name: 'New workflow' }).click();
	await page.getByPlaceholder('Order Fulfillment').fill(workflowName);
	await page.getByRole('button', { name: 'Create workflow' }).click();
	await expect(page).toHaveURL(/\/builder$/);

	const failing = runnableDsl(id).replace(
		'  - greet:\n      set:\n        message: hello from e2e\n',
		[
			'  - boom:',
			'      raise:',
			'        error:',
			'          type: https://serverlessworkflow.io/spec/1.0.0/errors/runtime',
			'          status: 500',
			'          title: Deliberate e2e failure',
			''
		].join('\n')
	);
	await page.getByRole('button', { name: 'DSL' }).click();
	await page.locator('.modal .cm-content').fill(failing);
	await expect(page.locator('.svelte-flow__node', { hasText: 'boom' })).toBeVisible();
	await page.getByRole('button', { name: '✕' }).click();

	await page.getByRole('button', { name: 'Run', exact: true }).click();
	const runWindow = page.getByRole('dialog', { name: `Run ${workflowName}` });
	await expect(runWindow.getByText('failed', { exact: true })).toBeVisible({ timeout: 90_000 });

	await page.goto('/executions?status=failed');
	await expect(page.getByRole('row', { name: new RegExp(workflowName) })).toContainText('failed');

	await deleteProject(page, projectName);
});
