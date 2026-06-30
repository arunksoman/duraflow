import { dev } from '$app/environment';
import { API_BASE_URL, authHeaders } from '$lib/server/http';
import type { Session, User } from '$lib/types';

export class AuthError extends Error {}

// Statically false in production builds, so this whole branch is dead code there.
export const DEV_BYPASS_TOKEN = 'dev-bypass';

const DEV_USER: User = {
	id: 'dev-user',
	email: 'dev@duraflow.local',
	name: 'Dev User',
	role: 'designer'
};

export async function login(email: string, password: string): Promise<Session> {
	let response: Response;
	try {
		response = await fetch(`${API_BASE_URL}/auth/login`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ email, password })
		});
	} catch {
		throw new AuthError('Unable to reach the authentication service');
	}

	if (response.status === 401) {
		throw new AuthError('Invalid email or password');
	}
	if (!response.ok) {
		throw new AuthError('Unable to reach the authentication service');
	}

	return response.json();
}

export async function getSessionUser(token: string | undefined): Promise<User | null> {
	if (!token) return null;
	if (dev && token === DEV_BYPASS_TOKEN) return DEV_USER;

	try {
		const response = await fetch(`${API_BASE_URL}/auth/me`, { headers: authHeaders(token) });
		return response.ok ? await response.json() : null;
	} catch {
		return null;
	}
}
