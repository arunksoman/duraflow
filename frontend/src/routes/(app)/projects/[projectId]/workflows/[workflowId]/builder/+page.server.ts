import { error, fail } from '@sveltejs/kit';
import { ProjectsApiError, getProject } from '$lib/server/projects';
import { WorkflowsApiError, getWorkflow, updateWorkflow, listWorkflows } from '$lib/server/workflows';
import { ExecutionsApiError, createExecution } from '$lib/server/executions';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, cookies }) => {
	const token = cookies.get('session');

	try {
		const [project, workflow, siblingWorkflows] = await Promise.all([
			getProject(token, params.projectId),
			getWorkflow(token, params.workflowId),
			listWorkflows(token, params.projectId)
		]);
		return {
			project,
			workflow,
			siblingWorkflows: siblingWorkflows.filter((w) => w.id !== params.workflowId)
		};
	} catch (err) {
		if (err instanceof ProjectsApiError || err instanceof WorkflowsApiError) {
			error(404, 'Workflow not found');
		}
		throw err;
	}
};

export const actions: Actions = {
	save: async ({ request, params, cookies }) => {
		const data = await request.formData();
		const dsl = String(data.get('dsl') ?? '');

		try {
			await updateWorkflow(cookies.get('session'), params.workflowId, { dsl });
		} catch (err) {
			if (err instanceof WorkflowsApiError) return fail(502, { error: err.message });
			throw err;
		}

		return { success: true };
	},

	run: async ({ request, params, cookies }) => {
		const data = await request.formData();
		const dsl = String(data.get('dsl') ?? '');
		const inputRaw = String(data.get('input') ?? '').trim();
		const token = cookies.get('session');

		let input: Record<string, unknown> | undefined;
		if (inputRaw) {
			try {
				input = JSON.parse(inputRaw);
			} catch {
				return fail(400, { error: 'Input must be valid JSON.' });
			}
		}

		try {
			// Run always executes the DSL currently on screen, so save it first — the worker that
			// registers this workflow's Temporal task queue loads from the persisted file, not the
			// canvas.
			await updateWorkflow(token, params.workflowId, { dsl });
			const execution = await createExecution(token, params.workflowId, { input });
			return { success: true, execution };
		} catch (err) {
			if (err instanceof WorkflowsApiError || err instanceof ExecutionsApiError) {
				return fail(502, { error: err.message });
			}
			throw err;
		}
	}
};
