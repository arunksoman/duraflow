import { API_BASE_URL, authHeaders } from '$lib/server/http';
import type { Execution } from '$lib/types';

export class ExecutionsApiError extends Error {}

export async function listExecutions(
	token: string | undefined,
	workflowId: string
): Promise<Execution[]> {
	let response: Response;
	try {
		response = await fetch(`${API_BASE_URL}/workflows/${workflowId}/executions`, {
			headers: authHeaders(token)
		});
	} catch {
		throw new ExecutionsApiError('Unable to reach the executions service');
	}

	if (!response.ok) {
		throw new ExecutionsApiError('Unable to load executions');
	}
	return response.json();
}

export async function createExecution(
	token: string | undefined,
	workflowId: string,
	input: { input?: Record<string, unknown> }
): Promise<Execution> {
	let response: Response;
	try {
		response = await fetch(`${API_BASE_URL}/workflows/${workflowId}/executions`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', ...authHeaders(token) },
			body: JSON.stringify(input)
		});
	} catch {
		throw new ExecutionsApiError('Unable to reach the executions service');
	}

	if (!response.ok) {
		let detail = 'Unable to start the execution';
		try {
			const body = await response.json();
			if (typeof body?.detail === 'string') detail = body.detail;
		} catch {
			// keep the default message
		}
		throw new ExecutionsApiError(detail);
	}
	return response.json();
}
