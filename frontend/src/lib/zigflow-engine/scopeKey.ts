/**
 * Deterministic scope-id scheme. Every nested task body (a `for` loop's `do`, a `try`'s guarded
 * body, a `try`'s `catch.do`, one `fork` branch's body) is stored as its own independent
 * `{nodes, edges}` graph, keyed by a path built from its ancestor scope + node id (the root of that
 * path is `ROOT_SCOPE_ID` for the primary workflow, or a named workflow's `workflowScopeKey`). Both `graph.ts`
 * (AST <-> node-graph conversion) and `inlineScopeView.ts` (which flattens these into one
 * always-visible, recursively-inlined canvas — there is no drill-in navigation) must use these
 * exact same builders so a node's nested-scope reference always resolves to the same key.
 */

export const ROOT_SCOPE_ID = 'root';

export function forScopeKey(parentScopeId: string, nodeId: string): string {
	return `${parentScopeId}/${nodeId}/do`;
}

export function tryScopeKey(parentScopeId: string, nodeId: string): string {
	return `${parentScopeId}/${nodeId}/try`;
}

export function catchScopeKey(parentScopeId: string, nodeId: string): string {
	return `${parentScopeId}/${nodeId}/catch`;
}

export function forkBranchScopeKey(
	parentScopeId: string,
	forkNodeId: string,
	branchId: string
): string {
	return `${parentScopeId}/${forkNodeId}/branch/${branchId}`;
}

const WORKFLOW_SCOPE_PREFIX = 'workflow/';

/**
 * A named workflow's scope. A `do:` task that follows a non-`do:` task — in *any* task list, at
 * any depth — is not run in place: zigflow registers it as a Temporal workflow of its own, named by
 * its task key, and a switch case's `then:` starts it as a child workflow. So it is drawn exactly
 * like the primary workflow: its own `start` node (`startNodeId`, which is also the scope's
 * identity), its body, and its own `end` node — all held in this one scope.
 *
 * The key is deliberately *not* prefixed by the scope that declares it: where a named workflow is
 * declared only decides where the DSL writes it, not how it runs, and a prefixed key would make it
 * read as a nested body of that scope (lane frames, drop targeting, terminal edges).
 */
export function workflowScopeKey(startNodeId: string): string {
	return `${WORKFLOW_SCOPE_PREFIX}${startNodeId}`;
}

/** True only for a named workflow's own scope, not for a body nested inside one. */
export function isWorkflowScopeKey(scopeId: string): boolean {
	return (
		scopeId.startsWith(WORKFLOW_SCOPE_PREFIX) &&
		!scopeId.includes('/', WORKFLOW_SCOPE_PREFIX.length)
	);
}

/**
 * The top-level flow a scope belongs to: `ROOT_SCOPE_ID` for the primary workflow and everything
 * nested in it, or the named workflow's own scope key. Every nested key is prefixed by its
 * ancestor's, so this is a string operation, not a tree walk.
 */
export function flowScopeOf(scopeId: string): string {
	if (!scopeId.startsWith(WORKFLOW_SCOPE_PREFIX)) return ROOT_SCOPE_ID;
	const end = scopeId.indexOf('/', WORKFLOW_SCOPE_PREFIX.length);
	return end < 0 ? scopeId : scopeId.slice(0, end);
}

/** The `end` node id of a named workflow, derived from its start node id. */
export function workflowEndNodeId(startNodeId: string): string {
	return `${startNodeId}--end`;
}

/** The start node id a named workflow's scope key was built from. */
export function workflowStartNodeId(workflowScopeId: string): string {
	return workflowScopeId.slice(WORKFLOW_SCOPE_PREFIX.length);
}
