import { fail } from '@sveltejs/kit';
import { listProjects } from '$lib/server/projects';
import { listWorkflows } from '$lib/server/workflows';
import {
	ExecutionsApiError,
	createExecution,
	deleteExecutions,
	listAllExecutions,
	type ExecutionFilters
} from '$lib/server/executions';
import { parseInputSchemaFromDsl } from '$lib/zigflow-engine/header';
import type { ExecutionStatus, ExecutionTrigger } from '$lib/types';
import type { Actions, PageServerLoad } from './$types';

const PAGE_SIZE = 25;

const TRIGGERS: ExecutionTrigger[] = ['manual', 'scheduled', 'backfill'];
const STATUSES: ExecutionStatus[] = [
	'running',
	'completed',
	'failed',
	'cancelled',
	'terminated',
	'timed_out'
];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Filters live in the URL, so a filtered list can be bookmarked or shared. Unknown values are
 * dropped rather than sent on, since the backend would reject them. Dates are whole UTC days.
 */
function readFilters(url: URL) {
	const get = (key: string) => url.searchParams.get(key)?.trim() ?? '';
	const trigger = get('trigger') as ExecutionTrigger;
	const status = get('status') as ExecutionStatus;
	const from = get('from');
	const to = get('to');
	const page = Math.max(1, Number.parseInt(get('page'), 10) || 1);

	return {
		workflowId: get('workflowId'),
		trigger: TRIGGERS.includes(trigger) ? trigger : ('' as const),
		status: STATUSES.includes(status) ? status : ('' as const),
		from: DATE.test(from) ? from : '',
		to: DATE.test(to) ? to : '',
		page
	};
}

export const load: PageServerLoad = async ({ cookies, url }) => {
	const token = cookies.get('session');
	const filters = readFilters(url);

	const query: ExecutionFilters = {
		workflowId: filters.workflowId || undefined,
		trigger: filters.trigger || undefined,
		status: filters.status || undefined,
		from: filters.from ? `${filters.from}T00:00:00Z` : undefined,
		to: filters.to ? `${filters.to}T23:59:59Z` : undefined,
		limit: PAGE_SIZE,
		offset: (filters.page - 1) * PAGE_SIZE
	};

	try {
		const [projects, page] = await Promise.all([
			listProjects(token),
			listAllExecutions(token, query)
		]);
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

		return {
			workflows,
			executions: page.items,
			total: page.total,
			filters,
			pageSize: PAGE_SIZE,
			apiError: false
		};
	} catch {
		return {
			workflows: [],
			executions: [],
			total: 0,
			filters,
			pageSize: PAGE_SIZE,
			apiError: true
		};
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
			execution = await createExecution(cookies.get('session'), workflowId, {
				input,
				trigger: 'manual'
			});
		} catch (err) {
			const message =
				err instanceof ExecutionsApiError ? err.message : 'Unable to start execution.';
			return fail(502, { workflowId, error: message });
		}

		return { success: true, execution };
	},

	delete: async ({ request, cookies }) => {
		const data = await request.formData();
		const ids = data.getAll('ids').map(String).filter(Boolean);
		const force = data.get('force') === 'true';

		if (ids.length === 0) return fail(400, { deleteError: 'Select at least one run.' });

		try {
			const deleted = await deleteExecutions(cookies.get('session'), ids, force);
			return { deleted };
		} catch (err) {
			if (err instanceof ExecutionsApiError) {
				return fail(err.status ?? 502, { deleteError: err.message });
			}
			throw err;
		}
	}
};
