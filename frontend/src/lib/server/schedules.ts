import { API_BASE_URL, authHeaders } from '$lib/server/http';
import type { Schedule } from '$lib/types';

export class SchedulesApiError extends Error {}

export async function listSchedules(
	token: string | undefined,
	workflowId?: string
): Promise<Schedule[]> {
	const url = new URL(`${API_BASE_URL}/schedules`);
	if (workflowId) url.searchParams.set('workflowId', workflowId);

	let response: Response;
	try {
		response = await fetch(url, { headers: authHeaders(token) });
	} catch {
		throw new SchedulesApiError('Unable to reach the schedules service');
	}

	if (!response.ok) {
		throw new SchedulesApiError('Unable to load schedules');
	}
	return response.json();
}

export async function createSchedule(
	token: string | undefined,
	input: { workflowId: string; cron: string; timezone?: string; enabled?: boolean }
): Promise<Schedule> {
	let response: Response;
	try {
		response = await fetch(`${API_BASE_URL}/schedules`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', ...authHeaders(token) },
			body: JSON.stringify(input)
		});
	} catch {
		throw new SchedulesApiError('Unable to reach the schedules service');
	}

	if (!response.ok) {
		throw new SchedulesApiError('Unable to create the schedule');
	}
	return response.json();
}

export async function updateSchedule(
	token: string | undefined,
	id: string,
	input: { cron?: string; timezone?: string; enabled?: boolean }
): Promise<Schedule> {
	let response: Response;
	try {
		response = await fetch(`${API_BASE_URL}/schedules/${id}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json', ...authHeaders(token) },
			body: JSON.stringify(input)
		});
	} catch {
		throw new SchedulesApiError('Unable to reach the schedules service');
	}

	if (!response.ok) {
		throw new SchedulesApiError('Unable to update the schedule');
	}
	return response.json();
}

export async function deleteSchedule(token: string | undefined, id: string): Promise<void> {
	let response: Response;
	try {
		response = await fetch(`${API_BASE_URL}/schedules/${id}`, {
			method: 'DELETE',
			headers: authHeaders(token)
		});
	} catch {
		throw new SchedulesApiError('Unable to reach the schedules service');
	}

	if (!response.ok) {
		throw new SchedulesApiError('Unable to delete the schedule');
	}
}
