import { fail } from '@sveltejs/kit';
import { listProjects } from '$lib/server/projects';
import { listWorkflows } from '$lib/server/workflows';
import { ExecutionsApiError, createExecution, listExecutions } from '$lib/server/executions';
import { parseInputSchemaFromDsl } from '$lib/zigflow-engine/header';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ cookies }) => {
	const token = cookies.get('session');

	try {
		const projects = await listProjects(token);
		const workflowsByProject = await Promise.all(
			projects.map((project) => listWorkflows(token, project.id))
		);
		// The run dialog builds a typed form from each workflow's declared `$input` fields. Parsed
		// here rather than in the browser so whole DSLs don't have to be shipped to the client.
		const workflows = projects.flatMap((project, i) =>
			workflowsByProject[i].map((workflow) => ({
				id: workflow.id,
				name: workflow.name,
				projectName: project.name,
				inputSchema: parseInputSchemaFromDsl(workflow.dsl)
			}))
		);

		const executionLists = await Promise.all(
			workflows.map((workflow) => listExecutions(token, workflow.id))
		);
		const executions = executionLists.flat();
		executions.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

		return { workflows, executions, apiError: false };
	} catch {
		return { workflows: [], executions: [], apiError: true };
	}
};

export const actions: Actions = {
	run: async ({ request, cookies }) => {
		const data = await request.formData();
		const workflowId = String(data.get('workflowId') ?? '');
		const inputRaw = String(data.get('input') ?? '').trim();

		if (!workflowId) {
			return fail(400, { workflowId, error: 'Choose a workflow to run.' });
		}

		// The dialog builds this from the workflow's typed input form and submits it as JSON.
		let input: Record<string, unknown> | undefined;
		if (inputRaw) {
			try {
				input = JSON.parse(inputRaw);
			} catch {
				return fail(400, { workflowId, error: 'Input must be valid JSON.' });
			}
		}

		let execution;
		try {
			execution = await createExecution(cookies.get('session'), workflowId, { input });
		} catch (err) {
			const message = err instanceof ExecutionsApiError ? err.message : 'Unable to start execution.';
			return fail(502, { workflowId, error: message });
		}

		return { success: true, execution };
	}
};
