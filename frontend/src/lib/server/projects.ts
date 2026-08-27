import { API_BASE_URL, authHeaders } from '$lib/server/http';
import type { Project } from '$lib/types';

export class ProjectsApiError extends Error {}

export async function listProjects(token: string | undefined): Promise<Project[]> {
	let response: Response;
	try {
		response = await fetch(`${API_BASE_URL}/projects`, { headers: authHeaders(token) });
	} catch {
		throw new ProjectsApiError('Unable to reach the projects service');
	}

	if (!response.ok) {
		throw new ProjectsApiError('Unable to load projects');
	}
	return response.json();
}

export async function createProject(
	token: string | undefined,
	input: { name: string; description?: string }
): Promise<Project> {
	let response: Response;
	try {
		response = await fetch(`${API_BASE_URL}/projects`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', ...authHeaders(token) },
			body: JSON.stringify(input)
		});
	} catch {
		throw new ProjectsApiError('Unable to reach the projects service');
	}

	if (!response.ok) {
		throw new ProjectsApiError('Unable to create the project');
	}
	return response.json();
}
