import { error, fail, redirect } from '@sveltejs/kit';
import { ProjectsApiError, getProject } from '$lib/server/projects';
import {
	WorkflowsApiError,
	createWorkflow,
	deleteWorkflow,
	listWorkflows
} from '$lib/server/workflows';
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
		const workflows = await listWorkflows(token, params.projectId);
		return { project, workflows, apiError: false };
	} catch {
		return { project, workflows: [], apiError: true };
	}
};

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
		if (!id) return fail(400, { error: 'Missing workflow id.' });

		try {
			await deleteWorkflow(cookies.get('session'), id);
		} catch (err) {
			if (err instanceof WorkflowsApiError) return fail(502, { error: err.message });
			throw err;
		}

		return { success: true };
	}
};
