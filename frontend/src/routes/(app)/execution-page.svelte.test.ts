import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { resetForms, settled, submissions } from '$lib/testing/forms';
import { fixtureEvents } from '$lib/testing/runFixture';
import type { Execution, Workflow } from '$lib/types';
import ExecutionPage from './executions/[id]/+page.svelte';

vi.mock('$app/forms', () => import('$lib/testing/forms'));

const DSL = `document:
  dsl: 1.0.0
  version: 0.1.0
  taskQueue: q
  workflowType: orders
do:
  - prepare:
      set:
        total: 1
  - notify:
      set:
        sent: true
`;

const sources: { url: string; closed: boolean }[] = [];

beforeEach(() => {
	resetForms();
	sources.length = 0;
	// A running run opens the live stream; nothing should reach the network here.
	vi.stubGlobal(
		'EventSource',
		class {
			closed = false;
			constructor(readonly url: string) {
				sources.push(this);
			}
			addEventListener() {}
			close() {
				this.closed = true;
			}
		}
	);
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => Response.json([]))
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

const run = (extra: Partial<Execution> = {}) =>
	({
		id: 'e1234567890',
		workflowId: 'w1',
		workflowName: 'orders',
		status: 'failed',
		trigger: 'manual',
		startedAt: '2026-01-01T00:00:00Z',
		completedAt: '2026-01-01T00:00:01.500Z',
		error: 'notify failed',
		...extra
	}) as Execution;

function page(
	execution: Execution,
	extra: { workflow?: Workflow | null; parent?: Execution | null; form?: unknown } = {}
) {
	return render(ExecutionPage, {
		data: {
			execution,
			events: fixtureEvents(),
			children: [],
			workflow:
				extra.workflow === undefined
					? ({ id: 'w1', projectId: 'p1', dsl: DSL } as Workflow)
					: extra.workflow,
			parent: extra.parent ?? null
		},
		form: extra.form ?? null,
		params: { id: execution.id }
	} as never);
}

describe('execution page', () => {
	it('replays a finished run', async () => {
		const screen = page(run());
		await expect.element(screen.getByRole('heading', { name: 'orders' })).toBeVisible();
		await expect.element(screen.getByText('e1234567')).toBeVisible();
		await expect.element(screen.getByText('notify failed').first()).toBeVisible();
		await expect.element(screen.getByText(/· 1\.50 s/)).toBeVisible();
		await expect
			.element(screen.getByRole('link', { name: 'Open in builder' }))
			.toHaveAttribute('href', '/projects/p1/workflows/w1/builder');
		expect(sources).toHaveLength(0);
	});

	it('re-runs and deletes', async () => {
		const screen = page(run(), { form: { deleteError: 'still running' } });
		await screen.getByRole('button', { name: 'Re-run' }).click();
		await settled();
		expect(submissions[0].action).toBe('?/rerun');

		await screen.getByRole('button', { name: 'Delete', exact: true }).click();
		await expect.element(screen.getByText('Delete this run?')).toBeVisible();
		await expect.element(screen.getByText('still running')).toBeVisible();
		await screen.getByRole('button', { name: 'Cancel', exact: true }).first().click();
		expect(screen.getByText('Delete this run?').elements()).toHaveLength(0);
	});

	it('attaches to a running run and stops on leaving', async () => {
		const screen = page(run({ status: 'running', completedAt: undefined, error: undefined }));
		await expect.poll(() => sources.length).toBe(1);
		expect(sources[0].url).toMatch(/^\/executions\/e1234567890\/watch\?afterSeq=\d+$/);
		await expect.element(screen.getByText('running', { exact: true })).toBeVisible();
		await screen.getByRole('button', { name: 'Delete', exact: true }).click();
		await expect.element(screen.getByText(/This run is/)).toBeVisible();
		screen.unmount();
		expect(sources[0].closed).toBe(true);
	});

	it('shows a child run without its own workflow', async () => {
		const screen = page(
			run({
				workflowId: '',
				workflowName: '',
				workflowType: 'childType',
				parentExecutionId: 'root',
				parentTaskName: 'callChild',
				trigger: undefined,
				completedAt: undefined
			}),
			{ workflow: null, parent: run({ id: 'root', workflowName: 'parentFlow' }) }
		);
		await expect.element(screen.getByRole('heading', { name: 'childType' })).toBeVisible();
		await expect
			.element(screen.getByRole('link', { name: /parentFlow/ }))
			.toHaveAttribute('href', '/executions/root');
		await expect.element(screen.getByText('· callChild')).toBeVisible();
		await expect.element(screen.getByText(/No canvas for this run/)).toBeVisible();
		expect(screen.getByRole('button', { name: 'Re-run' }).elements()).toHaveLength(0);
		expect(screen.getByRole('button', { name: 'Delete', exact: true }).elements()).toHaveLength(0);
	});

	it('falls back when the stored DSL does not parse', async () => {
		const screen = page(run({ workflowName: '' }), {
			workflow: { id: 'w1', projectId: 'p1', dsl: 'document: [broken' } as Workflow
		});
		await expect.element(screen.getByRole('heading', { name: 'Unknown workflow' })).toBeVisible();
		await expect.element(screen.getByText(/No canvas for this run/)).toBeVisible();
	});
});
