import { fail } from '@sveltejs/kit';
import { ProjectsApiError, createProject, deleteProject, listProjects } from '$lib/server/projects';
import type { Project } from '$lib/types';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ cookies }) => {
	try {
		const projects = await listProjects(cookies.get('session'));
		return { projects, apiError: false };
	} catch {
		return { projects: [] as Project[], apiError: true };
	}
};

export const actions: Actions = {
	create: async ({ request, cookies }) => {
		const data = await request.formData();
		const name = String(data.get('name') ?? '').trim();
		const description = String(data.get('description') ?? '').trim();

		if (!name) {
			return fail(400, { name, description, error: 'Project name is required.' });
		}

		try {
			await createProject(cookies.get('session'), {
				name,
				description: description || undefined
			});
		} catch {
			return fail(502, { name, description, error: 'Unable to create the project right now.' });
		}

		return { success: true };
	},

	delete: async ({ request, cookies }) => {
		const data = await request.formData();
		const id = String(data.get('id') ?? '');
		if (!id) return fail(400, { deleteError: 'Missing project id.' });

		try {
			await deleteProject(cookies.get('session'), id);
		} catch (err) {
			if (err instanceof ProjectsApiError) return fail(502, { deleteError: err.message });
			throw err;
		}

		return { success: true };
	}
};
