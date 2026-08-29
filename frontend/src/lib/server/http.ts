import { env } from '$env/dynamic/private';

export const API_BASE_URL = env.API_BASE_URL ?? 'http://localhost:8000/api';

export function authHeaders(token: string | undefined): Record<string, string> {
	return token ? { authorization: `Bearer ${token}` } : {};
}
