import { listWorkers } from '$lib/server/workers';
import type { Worker } from '$lib/types';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ cookies }) => {
	try {
		const workers = await listWorkers(cookies.get('session'));
		return { workers, apiError: false };
	} catch {
		return { workers: [] as Worker[], apiError: true };
	}
};
