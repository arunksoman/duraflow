/**
 * Deterministic scope-id scheme. Every nested task body (a `for` loop's `do`, a `try`'s guarded
 * body, a `try`'s `catch.do`, one `fork` branch's body) is stored as its own independent
 * `{nodes, edges}` graph, keyed by a path built from its ancestor scope + node id. Both `graph.ts`
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

/**
 * A named workflow's body. A root-level `do:` task is a whole Temporal workflow of its own (the
 * document's `do:` list may declare several), and its steps live under the same key shape as any
 * other nested body so every consumer — lanes, frames, drag-and-drop — treats it uniformly.
 */
export function workflowScopeKey(nodeId: string): string {
	return forScopeKey(ROOT_SCOPE_ID, nodeId);
}
