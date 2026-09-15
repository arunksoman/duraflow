import { error, fail, redirect } from '@sveltejs/kit';
import { ProjectsApiError, getProject } from '$lib/server/projects';
import {
	WorkflowsApiError,
	createWorkflow,
	deleteWorkflow,
	listWorkflows
} from '$lib/server/workflows';
import { listAllExecutions } from '$lib/server/executions';
import type { Execution } from '$lib/types';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, cookies }) => {
	const token = cookies.get('session');

	let project;
	try {
		project = await getProject(token, params.projectId);
	} catch (err) {
		if (err instanceof ProjectsApiError) error(404, 'Project not found');
		throw err;
	}

	try {
		const [workflows, lastRuns] = await Promise.all([
			listWorkflows(token, params.projectId),
			latestRunPerWorkflow(token, params.projectId)
		]);
		return { project, workflows, lastRuns, apiError: false };
	} catch {
		return { project, workflows: [], lastRuns: {}, apiError: true };
	}
};

/**
 * Each workflow's most recent root run, for the status line on its card. One page of the project's
 * runs (newest first) covers it; a workflow whose last run is older than that page simply shows no
 * status. Best-effort — the cards still render if runs can't be loaded.
 */
async function latestRunPerWorkflow(
	token: string | undefined,
	projectId: string
): Promise<Record<string, Pick<Execution, 'id' | 'status' | 'startedAt'>>> {
	try {
		const { items } = await listAllExecutions(token, { projectId, limit: 500 });
		const latest: Record<string, Pick<Execution, 'id' | 'status' | 'startedAt'>> = {};
		for (const run of items) {
			if (!latest[run.workflowId]) {
				latest[run.workflowId] = { id: run.id, status: run.status, startedAt: run.startedAt };
			}
		}
		return latest;
	} catch {
		return {};
	}
}

export const actions: Actions = {
	createWorkflow: async ({ request, cookies, params }) => {
		const data = await request.formData();
		const name = String(data.get('name') ?? '').trim();
		const description = String(data.get('description') ?? '').trim();

		if (!name) {
			return fail(400, { name, description, error: 'Workflow name is required.' });
		}

		let workflow;
		try {
			workflow = await createWorkflow(cookies.get('session'), params.projectId, {
				name,
				description: description || undefined
			});
		} catch {
			return fail(502, { name, description, error: 'Unable to create the workflow right now.' });
		}

		redirect(303, `/projects/${params.projectId}/workflows/${workflow.id}/builder`);
	},

	deleteWorkflow: async ({ request, cookies }) => {
		const data = await request.formData();
		const id = String(data.get('id') ?? '');
		if (!id) return fail(400, { deleteError: 'Missing workflow id.' });

		try {
			await deleteWorkflow(cookies.get('session'), id);
		} catch (err) {
			if (err instanceof WorkflowsApiError) return fail(502, { deleteError: err.message });
			throw err;
		}

		return { success: true };
	}
};
