import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { resetForms, respondWith, settled, submissions } from '$lib/testing/forms';
import type { Execution, Project, Workflow } from '$lib/types';
import ProjectPage from './projects/[projectId]/+page.svelte';

vi.mock('$app/forms', () => import('$lib/testing/forms'));

beforeEach(() => {
	resetForms();
});

const workflow = (id: string, extra: Partial<Workflow> = {}) =>
	({
		id,
		name: id,
		projectId: 'p1',
		dsl: 'document: {}',
		version: 2,
		createdAt: '2026-01-01T00:00:00Z',
		updatedAt: '2026-01-01T00:00:00Z',
		...extra
	}) as Workflow;

function page(
	workflows: Workflow[],
	extra: {
		lastRuns?: Record<string, Pick<Execution, 'id' | 'status' | 'startedAt'>>;
		apiError?: boolean;
		form?: unknown;
		description?: string;
	} = {}
) {
	return render(ProjectPage, {
		data: {
			project: { id: 'p1', name: 'Billing', description: extra.description } as Project,
			workflows,
			lastRuns: extra.lastRuns ?? {},
			apiError: extra.apiError ?? false
		},
		form: extra.form ?? null,
		params: { projectId: 'p1' }
	} as never);
}

describe('project page', () => {
	it('shows each workflow with its last run', async () => {
		const screen = page(
			[
				workflow('orders', { description: 'ship things' }),
				workflow('draft', { dsl: '  ' }),
				workflow('fresh'),
				workflow('broken')
			],
			{
				description: 'money',
				lastRuns: {
					orders: { id: 'e1', status: 'completed', startedAt: '2026-01-01T00:00:00Z' },
					broken: { id: 'e2', status: 'timed_out', startedAt: '2026-01-01T00:00:00Z' },
					draft: { id: 'e3', status: 'failed', startedAt: '2026-01-01T00:00:00Z' }
				}
			}
		);
		await expect.element(screen.getByText('money · 4 workflows')).toBeVisible();
		await expect
			.element(screen.getByRole('link', { name: 'orders', exact: true }))
			.toHaveAttribute('href', '/projects/p1/workflows/orders/builder');
		await expect.element(screen.getByText('Succeeded')).toBeVisible();
		await expect.element(screen.getByText('Timed out')).toBeVisible();
		await expect.element(screen.getByText('Draft', { exact: true })).toBeVisible();
		await expect.element(screen.getByText('Never run')).toBeVisible();
		await expect
			.element(screen.getByRole('menuitem', { name: 'View runs' }).first())
			.toHaveAttribute('href', '/executions?workflowId=orders');
	});

	it('shows an empty project and an API warning', async () => {
		const screen = page([], { apiError: true });
		await expect.element(screen.getByText('0 workflows')).toBeVisible();
		await expect.element(screen.getByText(/Couldn't reach the workflow API/)).toBeVisible();
		await screen.getByRole('button', { name: 'Create your first workflow' }).click();
		await expect.element(screen.getByRole('heading', { name: 'New workflow' })).toBeVisible();
	});

	it('creates a workflow', async () => {
		const screen = page([workflow('a')], { form: { error: 'Workflow name is required.' } });
		await screen.getByRole('button', { name: 'New workflow' }).click();
		await expect.element(screen.getByText('Workflow name is required.')).toBeVisible();
		await screen.getByPlaceholder('Order Fulfillment').fill('Refunds');
		await screen.getByRole('button', { name: 'Create workflow' }).click();
		await settled();
		expect(submissions[0].action).toBe('?/createWorkflow');
		expect(submissions[0].data.get('name')).toBe('Refunds');
	});

	it('deletes a workflow after confirming', async () => {
		const screen = page([workflow('a'), workflow('b')], {
			form: { deleteError: 'Unable to delete the workflow' }
		});
		await screen.getByRole('button', { name: 'Actions for b' }).click();
		await screen.getByRole('menuitem', { name: 'Delete' }).nth(1).click();
		await expect.element(screen.getByText('Delete “b”?')).toBeVisible();
		await expect.element(screen.getByText('Unable to delete the workflow')).toBeVisible();

		respondWith({ type: 'failure', status: 502, data: {} });
		await screen.getByRole('button', { name: 'Delete workflow' }).click();
		await settled();
		expect(submissions.at(-1)?.data.get('id')).toBe('b');
		await expect.element(screen.getByText('Delete “b”?')).toBeVisible();

		respondWith({ type: 'success', status: 200 });
		await screen.getByRole('button', { name: 'Delete workflow' }).click();
		await settled();
		expect(screen.getByText('Delete “b”?').elements()).toHaveLength(0);

		await screen.getByRole('button', { name: 'Actions for a' }).click();
		await screen.getByRole('menuitem', { name: 'Delete' }).first().click();
		await screen.getByRole('button', { name: 'Cancel', exact: true }).first().click();
		expect(screen.getByText('Delete “a”?').elements()).toHaveLength(0);
	});
});
