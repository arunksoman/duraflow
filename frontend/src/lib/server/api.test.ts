import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { API_BASE_URL, authHeaders } from './http';
import { AuthError, DEV_BYPASS_TOKEN, getSessionUser, login } from './auth';
import {
	ExecutionsApiError,
	createExecution,
	deleteExecutions,
	getExecution,
	listAllExecutions,
	listChildExecutions,
	listExecutionEvents,
	listExecutions
} from './executions';
import {
	ProjectsApiError,
	createProject,
	deleteProject,
	getProject,
	listProjects
} from './projects';
import { WorkersApiError, listWorkers } from './workers';
import {
	WorkflowsApiError,
	createWorkflow,
	deleteWorkflow,
	getWorkflow,
	listWorkflows,
	updateWorkflow
} from './workflows';

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
	fetchMock.mockReset();
	vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

function respond(status: number, body?: unknown) {
	fetchMock.mockResolvedValueOnce(
		new Response(body === undefined ? null : JSON.stringify(body), {
			status,
			headers: { 'content-type': 'application/json' }
		})
	);
}

function unreachable() {
	fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
}

/** The URL, method, headers and parsed body of the nth fetch call. */
function call(n = 0) {
	const [url, init] = fetchMock.mock.calls[n];
	return {
		url: String(url),
		method: init?.method ?? 'GET',
		headers: (init?.headers ?? {}) as Record<string, string>,
		body: init?.body ? JSON.parse(String(init.body)) : undefined
	};
}

describe('http', () => {
	it('defaults to the local backend', () => {
		expect(API_BASE_URL).toBe('http://localhost:8000/api');
	});

	it('only sends a bearer header with a token', () => {
		expect(authHeaders('t')).toEqual({ authorization: 'Bearer t' });
		expect(authHeaders(undefined)).toEqual({});
		expect(authHeaders('')).toEqual({});
	});
});

describe('auth', () => {
	it('logs in', async () => {
		const session = { token: 'tok', user: { id: 'u' }, expiresAt: 'x' };
		respond(200, session);
		await expect(login('a@b', 'pw')).resolves.toEqual(session);
		expect(call()).toMatchObject({
			url: `${API_BASE_URL}/auth/login`,
			method: 'POST',
			body: { email: 'a@b', password: 'pw' }
		});
	});

	it.each([
		['bad credentials', () => respond(401), 'Invalid email or password'],
		['server error', () => respond(500), 'Unable to reach the authentication service'],
		['network failure', unreachable, 'Unable to reach the authentication service']
	])('maps %s to an AuthError', async (_, arrange, message) => {
		arrange();
		const error = await login('a@b', 'pw').catch((e) => e);
		expect(error).toBeInstanceOf(AuthError);
		expect(error.message).toBe(message);
	});

	it('resolves the session user', async () => {
		respond(200, { id: 'u1' });
		await expect(getSessionUser('tok')).resolves.toEqual({ id: 'u1' });
		expect(call().headers).toEqual({ authorization: 'Bearer tok' });
	});

	it('treats a missing token, a rejected token and an unreachable API as logged out', async () => {
		await expect(getSessionUser(undefined)).resolves.toBeNull();
		respond(401);
		await expect(getSessionUser('stale')).resolves.toBeNull();
		unreachable();
		await expect(getSessionUser('tok')).resolves.toBeNull();
	});

	it('honours the dev bypass token without calling the API', async () => {
		const user = await getSessionUser(DEV_BYPASS_TOKEN);
		expect(user?.id).toBe('dev-user');
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe('projects', () => {
	it('lists, creates, gets and deletes', async () => {
		respond(200, [{ id: 'p' }]);
		await expect(listProjects('t')).resolves.toEqual([{ id: 'p' }]);
		expect(call(0).url).toBe(`${API_BASE_URL}/projects`);

		respond(201, { id: 'p2' });
		await expect(createProject('t', { name: 'n' })).resolves.toEqual({ id: 'p2' });
		expect(call(1)).toMatchObject({ method: 'POST', body: { name: 'n' } });
		expect(call(1).headers).toMatchObject({
			'content-type': 'application/json',
			authorization: 'Bearer t'
		});

		respond(200, { id: 'p' });
		await expect(getProject('t', 'p')).resolves.toEqual({ id: 'p' });
		expect(call(2).url).toBe(`${API_BASE_URL}/projects/p`);

		respond(204);
		await expect(deleteProject('t', 'p')).resolves.toBeUndefined();
		expect(call(3)).toMatchObject({ url: `${API_BASE_URL}/projects/p`, method: 'DELETE' });
	});

	it.each([
		['listProjects', () => listProjects('t'), 'Unable to load projects'],
		['createProject', () => createProject('t', { name: 'n' }), 'Unable to create the project'],
		['getProject', () => getProject('t', 'p'), 'Unable to load the project'],
		['deleteProject', () => deleteProject('t', 'p'), 'Unable to delete the project']
	])('%s maps failures to ProjectsApiError', async (_, run, message) => {
		respond(500);
		await expect(run()).rejects.toThrow(new ProjectsApiError(message));
		unreachable();
		await expect(run()).rejects.toThrow('Unable to reach the projects service');
	});
});

describe('workflows', () => {
	it('lists, creates, gets, updates and deletes', async () => {
		respond(200, []);
		await listWorkflows('t', 'p');
		expect(call(0).url).toBe(`${API_BASE_URL}/projects/p/workflows`);

		respond(201, { id: 'w' });
		await createWorkflow('t', 'p', { name: 'w', dsl: 'x' });
		expect(call(1)).toMatchObject({ method: 'POST', body: { name: 'w', dsl: 'x' } });

		respond(200, { id: 'w' });
		await getWorkflow('t', 'w');
		expect(call(2).url).toBe(`${API_BASE_URL}/workflows/w`);

		respond(200, { id: 'w', dsl: 'y' });
		await expect(updateWorkflow('t', 'w', { dsl: 'y' })).resolves.toEqual({ id: 'w', dsl: 'y' });
		expect(call(3)).toMatchObject({ method: 'PATCH', body: { dsl: 'y' } });

		respond(204);
		await deleteWorkflow('t', 'w');
		expect(call(4)).toMatchObject({ method: 'DELETE', url: `${API_BASE_URL}/workflows/w` });
	});

	it.each([
		['listWorkflows', () => listWorkflows('t', 'p'), 'Unable to load workflows'],
		[
			'createWorkflow',
			() => createWorkflow('t', 'p', { name: 'w' }),
			'Unable to create the workflow'
		],
		['getWorkflow', () => getWorkflow('t', 'w'), 'Unable to load the workflow'],
		['updateWorkflow', () => updateWorkflow('t', 'w', {}), 'Unable to save the workflow'],
		['deleteWorkflow', () => deleteWorkflow('t', 'w'), 'Unable to delete the workflow']
	])('%s maps failures to WorkflowsApiError', async (_, run, message) => {
		respond(404);
		await expect(run()).rejects.toThrow(new WorkflowsApiError(message));
		unreachable();
		await expect(run()).rejects.toThrow('Unable to reach the workflows service');
	});
});

describe('workers', () => {
	it('lists workers', async () => {
		respond(200, [{ id: 'w' }]);
		await expect(listWorkers('t')).resolves.toEqual([{ id: 'w' }]);
	});

	it('maps failures to WorkersApiError', async () => {
		respond(500);
		await expect(listWorkers('t')).rejects.toThrow(new WorkersApiError('Unable to load workers'));
		unreachable();
		await expect(listWorkers('t')).rejects.toThrow('Unable to reach the workers service');
	});
});

describe('executions', () => {
	it('sends only the filters that are set', async () => {
		respond(200, { items: [{ id: 'e' }], total: 7 });
		const page = await listAllExecutions('t', {
			workflowId: 'w',
			trigger: 'scheduled',
			status: undefined,
			from: '',
			limit: 25,
			offset: 0
		});
		expect(page).toEqual({ items: [{ id: 'e' }], total: 7 });
		const url = new URL(call().url);
		expect(url.pathname).toBe('/api/executions');
		expect(Object.fromEntries(url.searchParams)).toEqual({
			workflowId: 'w',
			trigger: 'scheduled',
			limit: '25',
			offset: '0'
		});
	});

	it('tolerates an empty page body', async () => {
		respond(200, {});
		await expect(listAllExecutions('t')).resolves.toEqual({ items: [], total: 0 });
	});

	it('surfaces the backend detail and status on a failed list', async () => {
		respond(422, { detail: 'unknown trigger cron' });
		const error = await listAllExecutions('t').catch((e) => e);
		expect(error).toBeInstanceOf(ExecutionsApiError);
		expect(error).toMatchObject({ message: 'unknown trigger cron', status: 422 });

		fetchMock.mockResolvedValueOnce(new Response('not json', { status: 500 }));
		await expect(listAllExecutions('t')).rejects.toMatchObject({
			message: 'Unable to load executions',
			status: 500
		});
	});

	it('deletes runs, forcing when asked', async () => {
		respond(200, { deleted: 2 });
		await expect(deleteExecutions('t', ['a', 'b'], true)).resolves.toBe(2);
		expect(call()).toMatchObject({
			url: `${API_BASE_URL}/executions/delete`,
			method: 'POST',
			body: { ids: ['a', 'b'], force: true }
		});

		respond(200, {});
		await expect(deleteExecutions('t', ['a'])).resolves.toBe(0);
		expect(call(1).body).toEqual({ ids: ['a'], force: false });

		respond(409, { detail: 'run is still in progress' });
		await expect(deleteExecutions('t', ['a'])).rejects.toMatchObject({
			message: 'run is still in progress',
			status: 409
		});
	});

	it('reads one run, its events and its children', async () => {
		respond(200, { id: 'e' });
		await expect(getExecution('t', 'e')).resolves.toEqual({ id: 'e' });

		respond(200, { events: [{ seq: 1 }] });
		await expect(listExecutionEvents('t', 'e', 5)).resolves.toEqual([{ seq: 1 }]);
		expect(call(1).url).toBe(`${API_BASE_URL}/executions/e/events?afterSeq=5`);

		respond(200, {});
		await expect(listExecutionEvents('t', 'e')).resolves.toEqual([]);
		expect(call(2).url).toContain('afterSeq=0');

		respond(200, [{ id: 'c' }]);
		await expect(listChildExecutions('t', 'e')).resolves.toEqual([{ id: 'c' }]);
		expect(call(3).url).toBe(`${API_BASE_URL}/executions/e/children`);

		respond(200, []);
		await listExecutions('t', 'w');
		expect(call(4).url).toBe(`${API_BASE_URL}/workflows/w/executions`);
	});

	it('starts a run', async () => {
		respond(201, { id: 'e' });
		await createExecution('t', 'w', { input: { a: 1 }, trigger: 'manual' });
		expect(call()).toMatchObject({
			method: 'POST',
			url: `${API_BASE_URL}/workflows/w/executions`,
			body: { input: { a: 1 }, trigger: 'manual' }
		});

		respond(502, { detail: 'no worker' });
		await expect(createExecution('t', 'w', {})).rejects.toThrow('no worker');
		fetchMock.mockResolvedValueOnce(new Response('<html>', { status: 502 }));
		await expect(createExecution('t', 'w', {})).rejects.toThrow('Unable to start the execution');
	});

	it.each([
		['listAllExecutions', () => listAllExecutions('t')],
		['deleteExecutions', () => deleteExecutions('t', ['a'])],
		['getExecution', () => getExecution('t', 'e')],
		['listExecutionEvents', () => listExecutionEvents('t', 'e')],
		['listChildExecutions', () => listChildExecutions('t', 'e')],
		['listExecutions', () => listExecutions('t', 'w')],
		['createExecution', () => createExecution('t', 'w', {})]
	])('%s reports an unreachable service', async (_, run) => {
		unreachable();
		await expect(run()).rejects.toThrow('Unable to reach the executions service');
	});

	it.each([
		['getExecution', () => getExecution('t', 'e'), 'Unable to load the execution'],
		['listExecutionEvents', () => listExecutionEvents('t', 'e'), 'Unable to load the run log'],
		['listChildExecutions', () => listChildExecutions('t', 'e'), 'Unable to load child runs'],
		['listExecutions', () => listExecutions('t', 'w'), 'Unable to load executions']
	])('%s reports a failed response', async (_, run, message) => {
		respond(500);
		await expect(run()).rejects.toThrow(message);
	});
});
