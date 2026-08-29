import { API_BASE_URL, authHeaders } from '$lib/server/http';
import type { Workflow } from '$lib/types';

export class WorkflowsApiError extends Error {}

export async function listWorkflows(
	token: string | undefined,
	projectId: string
): Promise<Workflow[]> {
	let response: Response;
	try {
		response = await fetch(`${API_BASE_URL}/projects/${projectId}/workflows`, {
			headers: authHeaders(token)
		});
	} catch {
		throw new WorkflowsApiError('Unable to reach the workflows service');
	}

	if (!response.ok) {
		throw new WorkflowsApiError('Unable to load workflows');
	}
	return response.json();
}

export async function createWorkflow(
	token: string | undefined,
	projectId: string,
	input: { name: string; description?: string; dsl?: string }
): Promise<Workflow> {
	let response: Response;
	try {
		response = await fetch(`${API_BASE_URL}/projects/${projectId}/workflows`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', ...authHeaders(token) },
			body: JSON.stringify(input)
		});
	} catch {
		throw new WorkflowsApiError('Unable to reach the workflows service');
	}

	if (!response.ok) {
		throw new WorkflowsApiError('Unable to create the workflow');
	}
	return response.json();
}

export async function getWorkflow(token: string | undefined, id: string): Promise<Workflow> {
	let response: Response;
	try {
		response = await fetch(`${API_BASE_URL}/workflows/${id}`, { headers: authHeaders(token) });
	} catch {
		throw new WorkflowsApiError('Unable to reach the workflows service');
	}

	if (!response.ok) {
		throw new WorkflowsApiError('Unable to load the workflow');
	}
	return response.json();
}

export async function updateWorkflow(
	token: string | undefined,
	id: string,
	input: { name?: string; description?: string; dsl?: string }
): Promise<Workflow> {
	let response: Response;
	try {
		response = await fetch(`${API_BASE_URL}/workflows/${id}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json', ...authHeaders(token) },
			body: JSON.stringify(input)
		});
	} catch {
		throw new WorkflowsApiError('Unable to reach the workflows service');
	}

	if (!response.ok) {
		throw new WorkflowsApiError('Unable to save the workflow');
	}
	return response.json();
}

export async function deleteWorkflow(token: string | undefined, id: string): Promise<void> {
	let response: Response;
	try {
		response = await fetch(`${API_BASE_URL}/workflows/${id}`, {
			method: 'DELETE',
			headers: authHeaders(token)
		});
	} catch {
		throw new WorkflowsApiError('Unable to reach the workflows service');
	}

	if (!response.ok) {
		throw new WorkflowsApiError('Unable to delete the workflow');
	}
}
