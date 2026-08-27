import { fail } from '@sveltejs/kit';
import { listProjects } from '$lib/server/projects';
import { listWorkflows } from '$lib/server/workflows';
import {
	SchedulesApiError,
	createSchedule,
	deleteSchedule,
	listSchedules,
	updateSchedule
} from '$lib/server/schedules';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ cookies }) => {
	const token = cookies.get('session');

	try {
		const projects = await listProjects(token);
		const workflowsByProject = await Promise.all(
			projects.map((project) => listWorkflows(token, project.id))
		);
		const workflows = projects.flatMap((project, i) =>
			workflowsByProject[i].map((workflow) => ({
				id: workflow.id,
				name: workflow.name,
				projectName: project.name
			}))
		);

		const scheduleLists = await Promise.all(
			workflows.map((workflow) => listSchedules(token, workflow.id))
		);
		const schedules = workflows.flatMap((workflow, i) =>
			scheduleLists[i].map((schedule) => ({
				...schedule,
				workflowName: workflow.name,
				projectName: workflow.projectName
			}))
		);
		schedules.sort((a, b) => a.workflowName.localeCompare(b.workflowName));

		return { workflows, schedules, apiError: false };
	} catch {
		return { workflows: [], schedules: [], apiError: true };
	}
};

export const actions: Actions = {
	create: async ({ request, cookies }) => {
		const data = await request.formData();
		const workflowId = String(data.get('workflowId') ?? '');
		const cron = String(data.get('cron') ?? '').trim();
		const timezone = String(data.get('timezone') ?? '').trim();
		const enabled = data.get('enabled') === 'on';

		if (!workflowId || !cron) {
			return fail(400, { workflowId, cron, timezone, error: 'Workflow and cron are required.' });
		}

		try {
			await createSchedule(cookies.get('session'), {
				workflowId,
				cron,
				timezone: timezone || undefined,
				enabled
			});
		} catch (err) {
			const message = err instanceof SchedulesApiError ? err.message : 'Unable to create schedule.';
			return fail(502, { workflowId, cron, timezone, error: message });
		}

		return { success: true };
	},

	toggle: async ({ request, cookies }) => {
		const data = await request.formData();
		const id = String(data.get('id') ?? '');
		const enabled = data.get('enabled') === 'true';
		if (!id) return fail(400, { error: 'Missing schedule id.' });

		try {
			await updateSchedule(cookies.get('session'), id, { enabled: !enabled });
		} catch (err) {
			if (err instanceof SchedulesApiError) return fail(502, { error: err.message });
			throw err;
		}
		return { success: true };
	},

	delete: async ({ request, cookies }) => {
		const data = await request.formData();
		const id = String(data.get('id') ?? '');
		if (!id) return fail(400, { error: 'Missing schedule id.' });

		try {
			await deleteSchedule(cookies.get('session'), id);
		} catch (err) {
			if (err instanceof SchedulesApiError) return fail(502, { error: err.message });
			throw err;
		}
		return { success: true };
	}
};
