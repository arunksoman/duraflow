/** Slug/name helpers shared by the graph<->AST converters. */

export function toSlug(str: string): string {
	return (
		(str ?? '')
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '') || 'task'
	);
}

/** Ensures every generated task name is unique within its own scope/taskList. */
export function uniqueSlug(base: string, taken: Set<string>): string {
	let slug = toSlug(base);
	let i = 2;
	while (taken.has(slug)) {
		slug = `${toSlug(base)}-${i}`;
		i++;
	}
	taken.add(slug);
	return slug;
}
