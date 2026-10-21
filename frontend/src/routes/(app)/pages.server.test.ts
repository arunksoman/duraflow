// Load functions and form actions of the (app) pages, against mocked $lib/server wrappers.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	data,
	expectFailure,
	expectHttpError,
	expectRedirect,
	formRequest,
	kitEvent
} from '$lib/testing/kit';
import * as projectsApi from '$lib/server/projects';
import * as workflowsApi from '$lib/server/workflows';
import * as executionsApi from '$lib/server/executions';
import type { Execution, Project, Workflow } from '$lib/types';
import * as dashboard from './dashboard/+page.server';
import * as executionsPage from './executions/+page.server';
import * as executionPage from './executions/[id]/+page.server';
import * as projectPage from './projects/[projectId]/+page.server';
import * as builderPage from './projects/[projectId]/workflows/[workflowId]/builder/+page.server';

vi.mock('$lib/server/projects', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/projects')>()),
	listProjects: vi.fn(),
	createProject: vi.fn(),
	deleteProject: vi.fn(),
	getProject: vi.fn()
}));
vi.mock('$lib/server/workflows', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/workflows')>()),
	listWorkflows: vi.fn(),
	createWorkflow: vi.fn(),
	getWorkflow: vi.fn(),
	updateWorkflow: vi.fn(),
	deleteWorkflow: vi.fn()
}));
vi.mock('$lib/server/executions', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/executions')>()),
	listAllExecutions: vi.fn(),
	deleteExecutions: vi.fn(),
	getExecution: vi.fn(),
	listExecutionEvents: vi.fn(),
	listChildExecutions: vi.fn(),
	createExecution: vi.fn()
}));

const { ProjectsApiError } = projectsApi;
const { WorkflowsApiError } = workflowsApi;
const { ExecutionsApiError } = executionsApi;

// Rejections go through an async implementation: a rejected promise created up front is reported
// as unhandled before the code under test gets to await it.
function failWith(fn: unknown, err: Error) {
	vi.mocked(fn as () => Promise<unknown>).mockImplementation(async () => {
		throw err;
	});
}

const project = (id: string, name = id) => ({ id, name }) as Project;
const workflow = (id: string, extra: Partial<Workflow> = {}) =>
	({ id, name: id, projectId: 'p1', dsl: '', ...extra }) as Workflow;
const run = (id: string, extra: Partial<Execution> = {}) =>
	({ id, workflowId: 'w1', status: 'completed', startedAt: 't', ...extra }) as Execution;

beforeEach(() => {
	vi.resetAllMocks();
});

describe('dashboard', () => {
	it('loads projects, or flags the API as down', async () => {
		vi.mocked(projectsApi.listProjects).mockResolvedValueOnce([project('p1')]);
		expect(data(await dashboard.load(kitEvent({})))).toEqual({
			projects: [project('p1')],
			apiError: false
		});

		failWith(projectsApi.listProjects, new Error('down'));
		expect(data(await dashboard.load(kitEvent({})))).toEqual({ projects: [], apiError: true });
	});

	it('creates a project', async () => {
		vi.mocked(projectsApi.createProject).mockResolvedValueOnce(project('p'));
		const result = await dashboard.actions.create(
			kitEvent({ request: formRequest({ name: ' Billing ', description: '  ' }) })
		);
		expect(result).toEqual({ success: true });
		expect(projectsApi.createProject).toHaveBeenCalledWith('tok', {
			name: 'Billing',
			description: undefined
		});
	});

	it('validates and reports create failures', async () => {
		const blank = await dashboard.actions.create(kitEvent({ request: formRequest({ name: ' ' }) }));
		expect(expectFailure(blank, 400).error).toBe('Project name is required.');

		failWith(projectsApi.createProject, new Error('x'));
		const failed = await dashboard.actions.create(
			kitEvent({ request: formRequest({ name: 'n', description: 'd' }) })
		);
		expect(expectFailure(failed, 502)).toMatchObject({ name: 'n', description: 'd' });
	});

	it('deletes a project', async () => {
		const missing = await dashboard.actions.delete(kitEvent({ request: formRequest({}) }));
		expect(expectFailure(missing, 400).deleteError).toBe('Missing project id.');

		vi.mocked(projectsApi.deleteProject).mockResolvedValueOnce();
		expect(await dashboard.actions.delete(kitEvent({ request: formRequest({ id: 'p' }) }))).toEqual(
			{ success: true }
		);

		failWith(projectsApi.deleteProject, new ProjectsApiError('Unable to delete the project'));
		const failed = await dashboard.actions.delete(kitEvent({ request: formRequest({ id: 'p' }) }));
		expect(expectFailure(failed, 502).deleteError).toBe('Unable to delete the project');

		failWith(projectsApi.deleteProject, new TypeError('bug'));
		await expect(
			dashboard.actions.delete(kitEvent({ request: formRequest({ id: 'p' }) }))
		).rejects.toThrow('bug');
	});
});

describe('executions list', () => {
	const dsl =
		'document:\n  taskQueue: q\n  workflowType: t\ninput:\n  schema:\n    format: json\n    document:\n      type: object\n      properties:\n        n:\n          type: number\n';

	it('reads filters from the URL and pages', async () => {
		vi.mocked(projectsApi.listProjects).mockResolvedValueOnce([project('p1', 'Billing')]);
		vi.mocked(executionsApi.listAllExecutions).mockResolvedValueOnce({
			items: [run('e1')],
			total: 60
		});
		vi.mocked(workflowsApi.listWorkflows).mockResolvedValueOnce([workflow('w1', { dsl })]);

		const result = data(
			await executionsPage.load(
				kitEvent({
					url: 'http://app.test/executions?workflowId=w1&trigger=scheduled&status=failed&from=2026-01-01&to=2026-01-31&page=3'
				})
			)
		);

		expect(executionsApi.listAllExecutions).toHaveBeenCalledWith('tok', {
			workflowId: 'w1',
			trigger: 'scheduled',
			status: 'failed',
			from: '2026-01-01T00:00:00Z',
			to: '2026-01-31T23:59:59Z',
			limit: 25,
			offset: 50
		});
		expect(result).toMatchObject({ total: 60, pageSize: 25, apiError: false });
		expect(result.executions).toEqual([run('e1')]);
		expect(result.workflows).toEqual([
			{
				id: 'w1',
				name: 'w1',
				projectName: 'Billing',
				inputSchema: [expect.objectContaining({ name: 'n' })]
			}
		]);
	});

	it('drops values the backend would reject', async () => {
		vi.mocked(projectsApi.listProjects).mockResolvedValueOnce([]);
		vi.mocked(executionsApi.listAllExecutions).mockResolvedValueOnce({ items: [], total: 0 });

		const result = data(
			await executionsPage.load(
				kitEvent({ url: 'http://app.test/executions?trigger=cron&status=meh&from=jan&page=-4' })
			)
		);
		expect(result.filters).toEqual({
			workflowId: '',
			trigger: '',
			status: '',
			from: '',
			to: '',
			page: 1
		});
		expect(executionsApi.listAllExecutions).toHaveBeenCalledWith('tok', {
			workflowId: undefined,
			trigger: undefined,
			status: undefined,
			from: undefined,
			to: undefined,
			limit: 25,
			offset: 0
		});
	});

	it('flags the API as down', async () => {
		failWith(projectsApi.listProjects, new Error('down'));
		vi.mocked(executionsApi.listAllExecutions).mockResolvedValueOnce({ items: [], total: 0 });
		const result = data(await executionsPage.load(kitEvent({ url: 'http://app.test/executions' })));
		expect(result).toMatchObject({ apiError: true, executions: [], workflows: [], total: 0 });
	});

	it('starts a manual run with JSON input', async () => {
		vi.mocked(executionsApi.createExecution).mockResolvedValueOnce(run('new'));
		const result = await executionsPage.actions.run(
			kitEvent({ request: formRequest({ workflowId: 'w1', input: '{"n":1}' }) })
		);
		expect(result).toEqual({ success: true, execution: run('new') });
		expect(executionsApi.createExecution).toHaveBeenCalledWith('tok', 'w1', {
			input: { n: 1 },
			trigger: 'manual'
		});

		vi.mocked(executionsApi.createExecution).mockResolvedValueOnce(run('new2'));
		await executionsPage.actions.run(kitEvent({ request: formRequest({ workflowId: 'w1' }) }));
		expect(executionsApi.createExecution).toHaveBeenLastCalledWith('tok', 'w1', {
			input: undefined,
			trigger: 'manual'
		});
	});

	it('reports run failures', async () => {
		const noWorkflow = await executionsPage.actions.run(kitEvent({ request: formRequest({}) }));
		expect(expectFailure(noWorkflow, 400).error).toBe('Choose a workflow to run.');

		const badJson = await executionsPage.actions.run(
			kitEvent({ request: formRequest({ workflowId: 'w1', input: '{nope' }) })
		);
		expect(expectFailure(badJson, 400).error).toBe('Input must be valid JSON.');

		failWith(executionsApi.createExecution, new ExecutionsApiError('no worker polling'));
		const apiFailure = await executionsPage.actions.run(
			kitEvent({ request: formRequest({ workflowId: 'w1' }) })
		);
		expect(expectFailure(apiFailure, 502).error).toBe('no worker polling');

		failWith(executionsApi.createExecution, new Error('weird'));
		const other = await executionsPage.actions.run(
			kitEvent({ request: formRequest({ workflowId: 'w1' }) })
		);
		expect(expectFailure(other, 502).error).toBe('Unable to start execution.');
	});

	it('deletes selected runs', async () => {
		const none = await executionsPage.actions.delete(kitEvent({ request: formRequest({}) }));
		expect(expectFailure(none, 400).deleteError).toBe('Select at least one run.');

		vi.mocked(executionsApi.deleteExecutions).mockResolvedValueOnce(2);
		const deleted = await executionsPage.actions.delete(
			kitEvent({ request: formRequest({ ids: ['a', 'b', ''], force: 'true' }) })
		);
		expect(deleted).toEqual({ deleted: 2 });
		expect(executionsApi.deleteExecutions).toHaveBeenCalledWith('tok', ['a', 'b'], true);

		failWith(executionsApi.deleteExecutions, new ExecutionsApiError('still running', 409));
		const conflict = await executionsPage.actions.delete(
			kitEvent({ request: formRequest({ ids: 'a' }) })
		);
		expect(expectFailure(conflict, 409).deleteError).toBe('still running');

		failWith(executionsApi.deleteExecutions, new ExecutionsApiError('unreachable'));
		const unknownStatus = await executionsPage.actions.delete(
			kitEvent({ request: formRequest({ ids: 'a' }) })
		);
		expectFailure(unknownStatus, 502);

		failWith(executionsApi.deleteExecutions, new TypeError('bug'));
		await expect(
			executionsPage.actions.delete(kitEvent({ request: formRequest({ ids: 'a' }) }))
		).rejects.toThrow('bug');
	});
});

describe('execution detail', () => {
	const params = { id: 'e1' };

	it('loads the run with its log, children, workflow and parent', async () => {
		vi.mocked(executionsApi.getExecution)
			.mockResolvedValueOnce(run('e1', { parentExecutionId: 'root' }))
			.mockResolvedValueOnce(run('root'));
		vi.mocked(executionsApi.listExecutionEvents).mockResolvedValueOnce([{ seq: 1 } as never]);
		vi.mocked(executionsApi.listChildExecutions).mockResolvedValueOnce([run('c')]);
		vi.mocked(workflowsApi.getWorkflow).mockResolvedValueOnce(workflow('w1'));

		const result = data(await executionPage.load(kitEvent({ params })));
		expect(result).toEqual({
			execution: run('e1', { parentExecutionId: 'root' }),
			events: [{ seq: 1 }],
			children: [run('c')],
			workflow: workflow('w1'),
			parent: run('root')
		});
	});

	it('still shows a run whose supporting detail is missing', async () => {
		vi.mocked(executionsApi.getExecution).mockResolvedValueOnce(run('e1'));
		failWith(executionsApi.listExecutionEvents, new Error('x'));
		failWith(executionsApi.listChildExecutions, new Error('x'));
		failWith(workflowsApi.getWorkflow, new WorkflowsApiError('gone'));

		const result = data(await executionPage.load(kitEvent({ params })));
		expect(result).toMatchObject({ events: [], children: [], workflow: null, parent: null });

		vi.mocked(executionsApi.getExecution).mockResolvedValueOnce(run('e1', { workflowId: '' }));
		vi.mocked(executionsApi.listExecutionEvents).mockResolvedValueOnce([]);
		vi.mocked(executionsApi.listChildExecutions).mockResolvedValueOnce([]);
		expect(data(await executionPage.load(kitEvent({ params }))).workflow).toBeNull();
	});

	it('404s for an unknown run and rethrows anything unexpected', async () => {
		failWith(executionsApi.getExecution, new ExecutionsApiError('nope'));
		await expectHttpError(() => executionPage.load(kitEvent({ params })), 404);

		failWith(executionsApi.getExecution, new TypeError('bug'));
		await expect(executionPage.load(kitEvent({ params }))).rejects.toThrow('bug');

		vi.mocked(executionsApi.getExecution).mockResolvedValueOnce(run('e1'));
		vi.mocked(executionsApi.listExecutionEvents).mockResolvedValueOnce([]);
		vi.mocked(executionsApi.listChildExecutions).mockResolvedValueOnce([]);
		failWith(workflowsApi.getWorkflow, new TypeError('workflow bug'));
		await expect(executionPage.load(kitEvent({ params }))).rejects.toThrow('workflow bug');
	});

	it('deletes the run and returns to the list', async () => {
		vi.mocked(executionsApi.deleteExecutions).mockResolvedValueOnce(1);
		await expectRedirect(
			() =>
				executionPage.actions.delete(kitEvent({ params, request: formRequest({ force: 'true' }) })),
			'/executions'
		);
		expect(executionsApi.deleteExecutions).toHaveBeenCalledWith('tok', ['e1'], true);

		failWith(executionsApi.deleteExecutions, new ExecutionsApiError('still running', 409));
		const conflict = await executionPage.actions.delete(kitEvent({ params }));
		expect(expectFailure(conflict, 409).deleteError).toBe('still running');

		failWith(executionsApi.deleteExecutions, new ExecutionsApiError('down'));
		expectFailure(await executionPage.actions.delete(kitEvent({ params })), 502);

		failWith(executionsApi.deleteExecutions, new TypeError('bug'));
		await expect(executionPage.actions.delete(kitEvent({ params }))).rejects.toThrow('bug');
	});

	it('re-runs with the same input', async () => {
		vi.mocked(executionsApi.getExecution).mockResolvedValueOnce(run('e1', { input: { a: 1 } }));
		vi.mocked(executionsApi.createExecution).mockResolvedValueOnce(run('e2'));
		expect(await executionPage.actions.rerun(kitEvent({ params }))).toEqual({
			success: true,
			execution: run('e2')
		});
		expect(executionsApi.createExecution).toHaveBeenCalledWith('tok', 'w1', { input: { a: 1 } });

		vi.mocked(executionsApi.getExecution).mockResolvedValueOnce(run('e1'));
		vi.mocked(executionsApi.createExecution).mockResolvedValueOnce(run('e3'));
		await executionPage.actions.rerun(kitEvent({ params }));
		expect(executionsApi.createExecution).toHaveBeenLastCalledWith('tok', 'w1', { input: {} });

		vi.mocked(executionsApi.getExecution).mockResolvedValueOnce(run('e1', { workflowId: '' }));
		expect(expectFailure(await executionPage.actions.rerun(kitEvent({ params })), 422).error).toBe(
			'This run has no workflow to re-run.'
		);

		failWith(executionsApi.getExecution, new ExecutionsApiError('down'));
		expect(expectFailure(await executionPage.actions.rerun(kitEvent({ params })), 502).error).toBe(
			'down'
		);

		failWith(executionsApi.getExecution, new TypeError('bug'));
		await expect(executionPage.actions.rerun(kitEvent({ params }))).rejects.toThrow('bug');
	});
});

describe('project page', () => {
	const params = { projectId: 'p1' };

	it('loads workflows with each one’s latest run', async () => {
		vi.mocked(projectsApi.getProject).mockResolvedValueOnce(project('p1'));
		vi.mocked(workflowsApi.listWorkflows).mockResolvedValueOnce([workflow('w1'), workflow('w2')]);
		vi.mocked(executionsApi.listAllExecutions).mockResolvedValueOnce({
			items: [
				run('newest', { workflowId: 'w1', status: 'failed' }),
				run('older', { workflowId: 'w1' }),
				run('only', { workflowId: 'w2', status: 'running' })
			],
			total: 3
		});

		const result = data(await projectPage.load(kitEvent({ params })));
		expect(executionsApi.listAllExecutions).toHaveBeenCalledWith('tok', {
			projectId: 'p1',
			limit: 500
		});
		expect(result.lastRuns).toEqual({
			w1: { id: 'newest', status: 'failed', startedAt: 't' },
			w2: { id: 'only', status: 'running', startedAt: 't' }
		});
		expect(result).toMatchObject({ project: project('p1'), apiError: false });
	});

	it('degrades without runs, or without workflows', async () => {
		vi.mocked(projectsApi.getProject).mockResolvedValue(project('p1'));
		vi.mocked(workflowsApi.listWorkflows).mockResolvedValueOnce([workflow('w1')]);
		failWith(executionsApi.listAllExecutions, new Error('x'));
		expect(data(await projectPage.load(kitEvent({ params })))).toMatchObject({
			lastRuns: {},
			apiError: false
		});

		failWith(workflowsApi.listWorkflows, new Error('x'));
		expect(data(await projectPage.load(kitEvent({ params })))).toMatchObject({
			workflows: [],
			apiError: true
		});
	});

	it('404s for an unknown project', async () => {
		failWith(projectsApi.getProject, new ProjectsApiError('nope'));
		await expectHttpError(() => projectPage.load(kitEvent({ params })), 404);
		failWith(projectsApi.getProject, new TypeError('bug'));
		await expect(projectPage.load(kitEvent({ params }))).rejects.toThrow('bug');
	});

	it('creates a workflow and opens it in the builder', async () => {
		vi.mocked(workflowsApi.createWorkflow).mockResolvedValueOnce(workflow('w9'));
		await expectRedirect(
			() =>
				projectPage.actions.createWorkflow(
					kitEvent({ params, request: formRequest({ name: ' Orders ', description: 'd' }) })
				),
			'/projects/p1/workflows/w9/builder'
		);
		expect(workflowsApi.createWorkflow).toHaveBeenCalledWith('tok', 'p1', {
			name: 'Orders',
			description: 'd'
		});

		const blank = await projectPage.actions.createWorkflow(
			kitEvent({ params, request: formRequest({ name: '' }) })
		);
		expect(expectFailure(blank, 400).error).toBe('Workflow name is required.');

		failWith(workflowsApi.createWorkflow, new Error('x'));
		const failed = await projectPage.actions.createWorkflow(
			kitEvent({ params, request: formRequest({ name: 'n' }) })
		);
		expect(expectFailure(failed, 502).error).toBe('Unable to create the workflow right now.');
	});

	it('deletes a workflow', async () => {
		const missing = await projectPage.actions.deleteWorkflow(
			kitEvent({ params, request: formRequest({}) })
		);
		expectFailure(missing, 400);

		vi.mocked(workflowsApi.deleteWorkflow).mockResolvedValueOnce();
		expect(
			await projectPage.actions.deleteWorkflow(
				kitEvent({ params, request: formRequest({ id: 'w1' }) })
			)
		).toEqual({ success: true });

		failWith(workflowsApi.deleteWorkflow, new WorkflowsApiError('Unable to delete the workflow'));
		const failed = await projectPage.actions.deleteWorkflow(
			kitEvent({ params, request: formRequest({ id: 'w1' }) })
		);
		expect(expectFailure(failed, 502).deleteError).toBe('Unable to delete the workflow');

		failWith(workflowsApi.deleteWorkflow, new TypeError('bug'));
		await expect(
			projectPage.actions.deleteWorkflow(kitEvent({ params, request: formRequest({ id: 'w1' }) }))
		).rejects.toThrow('bug');
	});
});

describe('builder page', () => {
	const params = { projectId: 'p1', workflowId: 'w1' };

	it('loads the workflow, its project and its siblings', async () => {
		vi.mocked(projectsApi.getProject).mockResolvedValueOnce(project('p1'));
		vi.mocked(workflowsApi.getWorkflow).mockResolvedValueOnce(workflow('w1'));
		vi.mocked(workflowsApi.listWorkflows).mockResolvedValueOnce([workflow('w1'), workflow('w2')]);
		expect(data(await builderPage.load(kitEvent({ params })))).toEqual({
			project: project('p1'),
			workflow: workflow('w1'),
			siblingWorkflows: [workflow('w2')]
		});
	});

	it('404s when the workflow or project is gone', async () => {
		vi.mocked(projectsApi.getProject).mockResolvedValue(project('p1'));
		vi.mocked(workflowsApi.listWorkflows).mockResolvedValue([]);
		failWith(workflowsApi.getWorkflow, new WorkflowsApiError('x'));
		await expectHttpError(() => builderPage.load(kitEvent({ params })), 404);

		failWith(projectsApi.getProject, new ProjectsApiError('x'));
		await expectHttpError(() => builderPage.load(kitEvent({ params })), 404);

		failWith(projectsApi.getProject, new TypeError('bug'));
		await expect(builderPage.load(kitEvent({ params }))).rejects.toThrow('bug');
	});

	it('saves the DSL', async () => {
		vi.mocked(workflowsApi.updateWorkflow).mockResolvedValueOnce(workflow('w1'));
		expect(
			await builderPage.actions.save(kitEvent({ params, request: formRequest({ dsl: 'yaml' }) }))
		).toEqual({ success: true });
		expect(workflowsApi.updateWorkflow).toHaveBeenCalledWith('tok', 'w1', { dsl: 'yaml' });

		failWith(workflowsApi.updateWorkflow, new WorkflowsApiError('Unable to save the workflow'));
		const failed = await builderPage.actions.save(kitEvent({ params }));
		expect(expectFailure(failed, 502).error).toBe('Unable to save the workflow');

		failWith(workflowsApi.updateWorkflow, new TypeError('bug'));
		await expect(builderPage.actions.save(kitEvent({ params }))).rejects.toThrow('bug');
	});

	it('saves, then runs what is on screen', async () => {
		vi.mocked(workflowsApi.updateWorkflow).mockResolvedValueOnce(workflow('w1'));
		vi.mocked(executionsApi.createExecution).mockResolvedValueOnce(run('e1'));
		const result = await builderPage.actions.run(
			kitEvent({ params, request: formRequest({ dsl: 'yaml', input: '{"a":2}' }) })
		);
		expect(result).toEqual({ success: true, execution: run('e1') });
		expect(vi.mocked(workflowsApi.updateWorkflow).mock.invocationCallOrder[0]).toBeLessThan(
			vi.mocked(executionsApi.createExecution).mock.invocationCallOrder[0]
		);
		expect(executionsApi.createExecution).toHaveBeenCalledWith('tok', 'w1', {
			input: { a: 2 },
			trigger: 'manual'
		});
	});

	it('reports run failures', async () => {
		const badJson = await builderPage.actions.run(
			kitEvent({ params, request: formRequest({ input: '[' }) })
		);
		expect(expectFailure(badJson, 400).error).toBe('Input must be valid JSON.');
		expect(workflowsApi.updateWorkflow).not.toHaveBeenCalled();

		failWith(workflowsApi.updateWorkflow, new WorkflowsApiError('save failed'));
		expect(expectFailure(await builderPage.actions.run(kitEvent({ params })), 502).error).toBe(
			'save failed'
		);

		vi.mocked(workflowsApi.updateWorkflow).mockResolvedValue(workflow('w1'));
		failWith(executionsApi.createExecution, new ExecutionsApiError('no worker'));
		expect(expectFailure(await builderPage.actions.run(kitEvent({ params })), 502).error).toBe(
			'no worker'
		);

		failWith(executionsApi.createExecution, new TypeError('bug'));
		await expect(builderPage.actions.run(kitEvent({ params }))).rejects.toThrow('bug');
	});
});
