import { error, fail } from '@sveltejs/kit';
import { ProjectsApiError, getProject } from '$lib/server/projects';
import { WorkflowsApiError, getWorkflow, updateWorkflow } from '$lib/server/workflows';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, cookies }) => {
	const token = cookies.get('session');

	try {
		const [project, workflow] = await Promise.all([
			getProject(token, params.projectId),
			getWorkflow(token, params.workflowId)
		]);
		return { project, workflow };
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
	}
};
