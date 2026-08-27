import { API_BASE_URL, authHeaders } from '$lib/server/http';
import type { Worker } from '$lib/types';

export class WorkersApiError extends Error {}

export async function listWorkers(token: string | undefined): Promise<Worker[]> {
	let response: Response;
	try {
		response = await fetch(`${API_BASE_URL}/workers`, { headers: authHeaders(token) });
	} catch {
		throw new WorkersApiError('Unable to reach the workers service');
	}

	if (!response.ok) {
		throw new WorkersApiError('Unable to load workers');
	}
	return response.json();
}
