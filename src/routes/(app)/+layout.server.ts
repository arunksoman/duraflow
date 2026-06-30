import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ locals, url }) => {
	if (!locals.user) {
		const params = new URLSearchParams({ redirectTo: url.pathname + url.search });
		redirect(303, `/login?${params}`);
	}

	return { user: locals.user };
};
