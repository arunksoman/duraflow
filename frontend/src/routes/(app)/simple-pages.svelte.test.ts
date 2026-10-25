import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { resetForms, respondWith, settled, submissions } from '$lib/testing/forms';
import type { Project, Worker } from '$lib/types';
import Dashboard from './dashboard/+page.svelte';
import Workers from './workers/+page.svelte';

vi.mock('$app/forms', () => import('$lib/testing/forms'));

beforeEach(() => {
	resetForms();
});

const project = (id: string, name: string, extra: Partial<Project> = {}) =>
	({
		id,
		name,
		workflowCount: 0,
		createdAt: '2026-01-01T00:00:00Z',
		updatedAt: '2026-01-01T00:00:00Z',
		...extra
	}) as Project;

type DashboardProps = Parameters<typeof render<typeof Dashboard>>[1];

function dashboard(projects: Project[], extra: { apiError?: boolean; form?: unknown } = {}) {
	return render(Dashboard, {
		data: { projects, apiError: extra.apiError ?? false, user: {} },
		form: extra.form ?? null,
		params: {}
	} as DashboardProps);
}

describe('dashboard page', () => {
	const projects = [
		project('p1', 'Billing', { description: 'money', workflowCount: 1 }),
		project('p2', 'Ops', { workflowCount: 3 })
	];

	it('lists projects and filters them', async () => {
		const screen = dashboard(projects);
		await expect
			.element(screen.getByRole('link', { name: 'Billing' }).first())
			.toHaveAttribute('href', '/projects/p1');
		await expect.element(screen.getByText('1 workflow', { exact: true })).toBeVisible();
		await expect.element(screen.getByText('3 workflows')).toBeVisible();
		await expect.element(screen.getByText('No description')).toBeVisible();

		await screen.getByPlaceholder('Search projects…').fill('ops');
		expect(screen.getByText('Billing').elements()).toHaveLength(0);
		await screen.getByPlaceholder('Search projects…').fill('zzz');
		await expect.element(screen.getByText('No projects match your search.')).toBeVisible();
	});

	it('shows an empty state and an API warning', async () => {
		const screen = dashboard([], { apiError: true });
		await expect.element(screen.getByText(/Couldn't reach the workflow API/)).toBeVisible();
		await expect.element(screen.getByText('No projects yet.', { exact: true })).toBeVisible();
		await screen.getByRole('button', { name: 'Create your first project' }).click();
		await expect.element(screen.getByRole('heading', { name: 'New project' })).toBeVisible();
	});

	it('creates a project through the dialog', async () => {
		const screen = dashboard(projects, { form: { error: 'Project name is required.', name: 'x' } });
		await screen.getByRole('button', { name: 'New project' }).click();
		await expect.element(screen.getByText('Project name is required.')).toBeVisible();
		await screen.getByPlaceholder('Order Fulfillment').fill('Payments');
		await screen.getByRole('button', { name: 'Create project' }).click();
		await settled();
		expect(submissions[0].action).toBe('?/create');
		expect(submissions[0].data.get('name')).toBe('Payments');
		expect((document.querySelector('dialog') as HTMLDialogElement).open).toBe(false);
	});

	it('deletes an empty project straight away', async () => {
		const screen = dashboard(projects);
		await screen.getByRole('button', { name: 'Actions for Billing' }).click();
		await screen.getByRole('menuitem', { name: 'Delete' }).first().click();
		await expect.element(screen.getByText('Delete “Billing”?')).toBeVisible();
		await screen.getByRole('button', { name: 'Cancel', exact: true }).first().click();
		expect(screen.getByText('Delete “Billing”?').elements()).toHaveLength(0);
	});

	it('makes you type the name to delete a project with workflows', async () => {
		const screen = dashboard(projects, { form: { deleteError: 'Unable to delete the project' } });
		await screen.getByRole('button', { name: 'Actions for Ops' }).click();
		await screen.getByRole('menuitem', { name: 'Delete' }).nth(1).click();
		await expect.element(screen.getByText(/its 3\s+workflows/)).toBeVisible();
		await expect.element(screen.getByText('Unable to delete the project')).toBeVisible();

		const confirm = screen.getByRole('button', { name: 'Delete project' });
		await expect.element(confirm).toBeDisabled();
		await screen.getByRole('textbox').last().fill('Ops');
		await expect.element(confirm).toBeEnabled();

		respondWith({ type: 'failure', status: 502, data: {} });
		await confirm.click();
		await settled();
		expect(submissions.at(-1)?.data.get('id')).toBe('p2');
		await expect.element(screen.getByText('Delete “Ops”?')).toBeVisible();

		respondWith({ type: 'success', status: 200 });
		await confirm.click();
		await settled();
		expect(screen.getByText('Delete “Ops”?').elements()).toHaveLength(0);
	});
});

describe('workers page', () => {
	const worker = (id: string, status: Worker['status']) =>
		({
			id,
			identity: id,
			taskQueue: 'q',
			status,
			lastHeartbeatAt: '2026-01-01T00:00:00Z'
		}) as Worker;

	it('lists workers with their status', async () => {
		const screen = render(Workers, {
			data: { workers: [worker('a', 'online'), worker('b', 'draining')], apiError: false },
			params: {}
		} as never);
		await expect.element(screen.getByText('online')).toHaveClass('badge-success');
		await expect.element(screen.getByText('draining')).toHaveClass('badge-warning');
	});

	it('explains an empty list and an unreachable API', async () => {
		const screen = render(Workers, { data: { workers: [], apiError: true }, params: {} } as never);
		await expect.element(screen.getByText("Couldn't reach the workers API.")).toBeVisible();
		await expect.element(screen.getByText(/No workers yet/)).toBeVisible();
	});
});
