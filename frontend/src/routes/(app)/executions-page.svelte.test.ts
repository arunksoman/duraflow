import { beforeEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import { resetForms, respondWith, settled, submissions } from '$lib/testing/forms';
import type { Execution, InputField } from '$lib/types';
import ExecutionsPage from './executions/+page.svelte';

vi.mock('$app/forms', () => import('$lib/testing/forms'));
vi.mock('$app/state', () => ({
	page: { url: new URL('http://app.test/executions?status=failed&page=2') }
}));

beforeEach(() => {
	resetForms();
});

const run = (id: string, extra: Partial<Execution> = {}) =>
	({
		id,
		workflowId: 'w1',
		workflowName: 'orders',
		projectName: 'Billing',
		status: 'completed',
		trigger: 'manual',
		startedAt: '2026-01-01T00:00:00Z',
		completedAt: '2026-01-01T00:00:00.500Z',
		...extra
	}) as Execution;

const noFilters = { workflowId: '', trigger: '', status: '', from: '', to: '', page: 1 };

function page(
	executions: Execution[],
	extra: {
		total?: number;
		filters?: Partial<typeof noFilters>;
		workflows?: { id: string; name: string; projectName: string; inputSchema: InputField[] }[];
		form?: unknown;
		apiError?: boolean;
	} = {}
) {
	return render(ExecutionsPage, {
		data: {
			executions,
			total: extra.total ?? executions.length,
			pageSize: 25,
			filters: { ...noFilters, ...extra.filters },
			workflows: extra.workflows ?? [
				{ id: 'w1', name: 'orders', projectName: 'Billing', inputSchema: [] }
			],
			apiError: extra.apiError ?? false
		},
		form: extra.form ?? null,
		params: {}
	} as never);
}

describe('executions page', () => {
	it('lists runs with status, type, duration and error', async () => {
		const screen = page([
			run('aaaaaaaa1', { status: 'failed', error: 'boom', trigger: 'scheduled' }),
			run('bbbbbbbb2', { status: 'running', completedAt: undefined }),
			run('cccccccc3', {
				completedAt: '2026-01-01T00:00:12Z',
				workflowName: '',
				workflowType: 'child'
			}),
			run('dddddddd4', {
				completedAt: '2026-01-01T00:03:30Z',
				workflowName: '',
				trigger: undefined
			}),
			run('eeeeeeee5', { completedAt: '2025-12-31T00:00:00Z', status: 'cancelled' })
		]);
		await expect.element(screen.getByText('5 runs')).toBeVisible();
		const badge = (text: string) => screen.getByRole('cell').getByText(text, { exact: true });
		await expect.element(badge('failed')).toHaveClass('badge-error');
		await expect.element(badge('scheduled')).toHaveClass('badge-primary');
		await expect.element(screen.getByText('boom')).toBeVisible();
		await expect.element(screen.getByText('500 ms')).toBeVisible();
		await expect.element(screen.getByText('12.0 s')).toBeVisible();
		await expect.element(screen.getByText('3m 30s')).toBeVisible();
		await expect.element(screen.getByText('…', { exact: true })).toBeVisible();
		await expect.element(screen.getByText('child')).toBeVisible();
		await expect.element(screen.getByText('Unknown workflow')).toBeVisible();
		await expect
			.element(screen.getByRole('link', { name: 'orders' }).first())
			.toHaveAttribute('href', '/executions/aaaaaaaa1');
	});

	it('explains an empty list, filtered or not', async () => {
		const plain = page([], { apiError: true, workflows: [] });
		await expect.element(plain.getByText('No executions yet.')).toBeVisible();
		await expect.element(plain.getByText("Couldn't reach the executions API.")).toBeVisible();
		await expect.element(plain.getByRole('button', { name: 'Run Workflow' })).toBeDisabled();
		plain.unmount();

		const filtered = page([], { filters: { status: 'failed' } });
		await expect.element(filtered.getByText('No runs match these filters.')).toBeVisible();
		await expect
			.element(filtered.getByRole('link', { name: 'Clear' }))
			.toHaveAttribute('href', '/executions');
	});

	it('submits the filter form when a filter changes', async () => {
		const screen = page([run('a')]);
		const form = screen.container.querySelector<HTMLFormElement>('form[method="GET"]')!;
		const submitted = vi.fn((e: Event) => e.preventDefault());
		form.addEventListener('submit', submitted);
		await userEvent.selectOptions(form.querySelector('select[name="status"]')!, 'failed');
		expect(submitted).toHaveBeenCalled();
	});

	it('pages, keeping the other filters', async () => {
		const screen = page([run('a')], { total: 60, filters: { page: 2, status: 'failed' } });
		await expect.element(screen.getByText('Page 2 of 3')).toBeVisible();
		await expect
			.element(screen.getByLabelText('Previous page'))
			.toHaveAttribute('href', '?status=failed');
		await expect
			.element(screen.getByLabelText('Next page'))
			.toHaveAttribute('href', '?status=failed&page=3');
	});

	it('selects runs and deletes them', async () => {
		const screen = page([run('aaaaaaaa1', { status: 'running' }), run('bbbbbbbb2')], {
			form: { deleted: 2 }
		});
		await expect.element(screen.getByText('Deleted 2 runs.')).toBeVisible();

		await screen.getByLabelText('Select run aaaaaaaa').click();
		await expect.element(screen.getByText('· 1 selected')).toBeVisible();
		await screen.getByLabelText('Select run aaaaaaaa').click();
		expect(screen.getByText('· 1 selected').elements()).toHaveLength(0);

		await screen.getByLabelText('Select all runs on this page').click();
		await expect.element(screen.getByText('· 2 selected')).toBeVisible();
		await screen.getByRole('button', { name: 'Delete selected' }).click();
		await expect.element(screen.getByText('Delete 2 runs?')).toBeVisible();
		await expect.element(screen.getByText(/1 of these runs are/)).toBeVisible();

		await screen.getByRole('button', { name: 'Terminate and delete' }).click();
		await settled();
		expect(submissions.at(-1)?.data.getAll('ids')).toEqual(['aaaaaaaa1', 'bbbbbbbb2']);
		expect(screen.getByText(/selected/).elements()).toHaveLength(0);

		await screen.getByLabelText('Select all runs on this page').click();
		await screen.getByLabelText('Select all runs on this page').click();
		expect(screen.getByText(/selected/).elements()).toHaveLength(0);
	});

	it('deletes a single run from its row', async () => {
		const screen = page([run('aaaaaaaa1')], { form: { deleteError: 'still running' } });
		await screen.getByLabelText('Delete run aaaaaaaa').click();
		await expect.element(screen.getByText('Delete this run?')).toBeVisible();
		await expect.element(screen.getByText('still running')).toBeVisible();
		await screen.getByRole('button', { name: 'Cancel', exact: true }).first().click();
		expect(screen.getByText('Delete this run?').elements()).toHaveLength(0);
	});

	it('runs a workflow with typed input', async () => {
		const screen = page([], {
			form: { error: 'no worker polling' },
			workflows: [
				{
					id: 'w1',
					name: 'orders',
					projectName: 'Billing',
					inputSchema: [
						{ name: 'customer', type: 'string', required: true },
						{ name: 'qty', type: 'number' }
					] as InputField[]
				},
				{ id: 'w2', name: 'free', projectName: 'Ops', inputSchema: [] }
			]
		});
		await screen.getByRole('button', { name: 'Run Workflow' }).click();
		await expect.element(screen.getByText('no worker polling')).toBeVisible();
		const runButton = screen.getByRole('button', { name: 'Run', exact: true });
		await expect.element(runButton).toBeDisabled();

		const picker = [...document.querySelectorAll('select[name="workflowId"]')].at(
			-1
		) as HTMLSelectElement;
		await userEvent.selectOptions(picker, 'w1');
		await expect.element(screen.getByText('qty')).toBeVisible();

		// A required field left blank stops the submit.
		await runButton.click();
		await settled();
		await expect.element(screen.getByText('Required.')).toBeVisible();
		expect(submissions).toHaveLength(0);

		await userEvent.fill(document.querySelector<HTMLInputElement>('#run-input-customer')!, 'ada');
		await userEvent.fill(document.querySelector<HTMLInputElement>('#run-input-qty')!, '3');
		respondWith({ type: 'success', status: 200, data: {} });
		await runButton.click();
		await settled();
		expect(submissions[0].action).toBe('?/run');
		expect(submissions[0].data.get('workflowId')).toBe('w1');
		expect(JSON.parse(String(submissions[0].data.get('input')))).toEqual({
			customer: 'ada',
			qty: 3
		});
	});

	it('blocks a run while the JSON input is invalid', async () => {
		const screen = page([]);
		await screen.getByRole('button', { name: 'Run Workflow' }).click();
		const picker = [...document.querySelectorAll('select[name="workflowId"]')].at(
			-1
		) as HTMLSelectElement;
		await userEvent.selectOptions(picker, 'w1');
		await userEvent.fill(document.querySelector<HTMLElement>('dialog .cm-content')!, 'nope');
		await expect.element(screen.getByRole('button', { name: 'Run', exact: true })).toBeDisabled();
		await userEvent.fill(document.querySelector<HTMLElement>('dialog .cm-content')!, '{"x":1}');
		respondWith({ type: 'failure', status: 502, data: {} });
		await screen.getByRole('button', { name: 'Run', exact: true }).click();
		await settled();
		expect(JSON.parse(String(submissions[0].data.get('input')))).toEqual({ x: 1 });
	});
});
