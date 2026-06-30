import { fail } from '@sveltejs/kit';
import { createProject, listProjects } from '$lib/server/projects';
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
	}
};
