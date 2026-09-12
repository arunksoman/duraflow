import { error, fail } from '@sveltejs/kit';
import {
	ExecutionsApiError,
	createExecution,
	getExecution,
	listChildExecutions,
	listExecutionEvents
} from '$lib/server/executions';
import { WorkflowsApiError, getWorkflow } from '$lib/server/workflows';
import type { Actions, PageServerLoad } from './$types';
import type { Execution, Workflow } from '$lib/types';

export const load: PageServerLoad = async ({ params, cookies }) => {
	const token = cookies.get('session');

	let execution: Execution;
	try {
		execution = await getExecution(token, params.id);
	} catch (err) {
		if (err instanceof ExecutionsApiError) error(404, 'Execution not found');
		throw err;
	}

	// Everything below is supporting detail: a run is still worth showing with a missing workflow
	// (a child whose type matched nothing stored) or an unreachable log.
	const [events, children, workflow, parent] = await Promise.all([
		listExecutionEvents(token, params.id).catch(() => []),
		listChildExecutions(token, params.id).catch(() => []),
		execution.workflowId
			? getWorkflow(token, execution.workflowId).catch((err) => {
					if (err instanceof WorkflowsApiError) return null;
					throw err;
				})
			: Promise.resolve<Workflow | null>(null),
		execution.parentExecutionId
			? getExecution(token, execution.parentExecutionId).catch(() => null)
			: Promise.resolve<Execution | null>(null)
	]);

	return { execution, events, children, workflow, parent };
};

export const actions: Actions = {
	// Re-runs the same workflow with the same input — the quickest way to retry after a failure.
	rerun: async ({ params, cookies }) => {
		const token = cookies.get('session');

		try {
			const execution = await getExecution(token, params.id);
			if (!execution.workflowId) {
				return fail(422, { error: 'This run has no workflow to re-run.' });
			}
			const started = await createExecution(token, execution.workflowId, {
				input: (execution.input ?? {}) as Record<string, unknown>
			});
			return { success: true, execution: started };
		} catch (err) {
			if (err instanceof ExecutionsApiError) return fail(502, { error: err.message });
			throw err;
		}
	}
};
