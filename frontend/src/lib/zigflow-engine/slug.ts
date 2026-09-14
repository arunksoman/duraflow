/** Slug/name helpers shared by the graph<->AST converters. */

export function toSlug(str: string): string {
	return (
		(str ?? '')
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '') || 'task'
	);
}

const TASK_NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/**
 * The DSL task name for a node label. A label that is already a valid name (`fetchProfile`,
 * `set-user`) is kept exactly — lowercasing it would rename tasks loaded from hand-written DSL and
 * break every `$data.<task>` reference and `then:` jump to them. Anything else (`Set Variables`)
 * becomes camelCase, so the name can be read back as `$data.setVariables` without jq quoting.
 */
export function toTaskName(label: string): string {
	const raw = (label ?? '').trim();
	if (TASK_NAME_RE.test(raw)) return raw;
	const words = raw.split(/[^A-Za-z0-9]+/).filter(Boolean);
	if (words.length === 0) return 'task';
	const name = words
		.map((w, i) =>
			i > 0
				? w.charAt(0).toUpperCase() + w.slice(1)
				: w === w.toUpperCase()
					? w.toLowerCase()
					: w.charAt(0).toLowerCase() + w.slice(1)
		)
		.join('');
	return /^[0-9]/.test(name) ? `task${name}` : name;
}

/** Ensures every generated task name is unique within its own scope/taskList. */
export function uniqueSlug(base: string, taken: Set<string>): string {
	const root = toTaskName(base);
	let slug = root;
	let i = 2;
	while (taken.has(slug)) {
		slug = `${root}${i}`;
		i++;
	}
	taken.add(slug);
	return slug;
}
