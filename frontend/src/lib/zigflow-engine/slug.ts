/** Slug/name helpers shared by the graph<->AST converters. */

export function toSlug(str: string): string {
	return (
		(str ?? '')
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '') || 'task'
	);
}

/**
 * Task/case names the DSL can carry verbatim. Zigflow puts no pattern on them (they are plain
 * YAML mapping keys), so anything identifier-shaped survives a round-trip untouched — which is
 * what keeps a hand-written `processElectronicOrder` from coming back as `processelectronicorder`
 * the first time its workflow is re-saved from the canvas.
 */
const TASK_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/** A task name for `label`: itself when it is already identifier-shaped, else its slug. */
export function toTaskName(label: string): string {
	const trimmed = (label ?? '').trim();
	return TASK_NAME_RE.test(trimmed) ? trimmed : toSlug(trimmed);
}

/** Ensures every generated task name is unique within its own scope/taskList. */
export function uniqueSlug(base: string, taken: Set<string>): string {
	return dedupe(toSlug(base), taken);
}

/** `toTaskName`, made unique within one scope/task list — the naming used for every emitted task. */
export function uniqueTaskName(base: string, taken: Set<string>): string {
	return dedupe(toTaskName(base), taken);
}

function dedupe(name: string, taken: Set<string>): string {
	let candidate = name;
	let i = 2;
	while (taken.has(candidate)) {
		candidate = `${name}-${i}`;
		i++;
	}
	taken.add(candidate);
	return candidate;
}
