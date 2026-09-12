import { API_BASE_URL, authHeaders } from '$lib/server/http';
import type { Execution, ExecutionEvent } from '$lib/types';

export class ExecutionsApiError extends Error {}

export async function getExecution(
	token: string | undefined,
	executionId: string
): Promise<Execution> {
	let response: Response;
	try {
		response = await fetch(`${API_BASE_URL}/executions/${executionId}`, {
			headers: authHeaders(token)
		});
	} catch {
		throw new ExecutionsApiError('Unable to reach the executions service');
	}

	if (!response.ok) {
		throw new ExecutionsApiError('Unable to load the execution');
	}
	return response.json();
}

/** The recorded task timeline for a run — what each node received, returned, or failed with. */
export async function listExecutionEvents(
	token: string | undefined,
	executionId: string,
	afterSeq = 0
): Promise<ExecutionEvent[]> {
	let response: Response;
	try {
		response = await fetch(
			`${API_BASE_URL}/executions/${executionId}/events?afterSeq=${afterSeq}`,
			{ headers: authHeaders(token) }
		);
	} catch {
		throw new ExecutionsApiError('Unable to reach the executions service');
	}

	if (!response.ok) {
		throw new ExecutionsApiError('Unable to load the run log');
	}
	const body = (await response.json()) as { events?: ExecutionEvent[] };
	return body.events ?? [];
}

export async function listChildExecutions(
	token: string | undefined,
	executionId: string
): Promise<Execution[]> {
	let response: Response;
	try {
		response = await fetch(`${API_BASE_URL}/executions/${executionId}/children`, {
			headers: authHeaders(token)
		});
	} catch {
		throw new ExecutionsApiError('Unable to reach the executions service');
	}

	if (!response.ok) {
		throw new ExecutionsApiError('Unable to load child runs');
	}
	return response.json();
}

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
