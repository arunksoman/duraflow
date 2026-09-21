import type { Node } from '@xyflow/svelte';
import type { CaseEntry, CaseRouting } from '../components/builder/builderConfig';

/**
 * Shared reading of a `switch` node's cases, so `graph.ts` (DSL <-> canvas), `inlineScopeView.ts`
 * (what is drawn) and `runIndex.ts` (run correlation) can never disagree about where a case goes.
 *
 * Every case is a condition plus a routing: start a named workflow (zigflow runs a named `then:` as
 * a child workflow, then carries on after the switch), or one of the DSL's three flow directives.
 * A case never owns a body — the steps it runs are that named workflow, drawn as its own flow.
 */

export const DIRECTIVE_ROUTINGS = ['continue', 'exit', 'end'] as const;

export function isDirectiveRouting(routing: CaseRouting): boolean {
	return (DIRECTIVE_ROUTINGS as readonly string[]).includes(routing);
}

/**
 * Cases as stored on the node, with anything missing filled in. A case that somehow arrives
 * without a `routing` (hand-poked node data) is read as `continue` — the directive that changes
 * nothing — rather than being dropped.
 */
export function switchCasesOf(node: Node | undefined): CaseEntry[] {
	const raw = (node?.data as Record<string, unknown> | undefined)?.cases;
	if (!Array.isArray(raw)) return [];
	return (raw as CaseEntry[]).map((c, i) => ({
		...c,
		id: c.id || `case-${i}`,
		name: c.name ?? '',
		condition: c.condition ?? '',
		routing: c.routing ?? 'continue'
	}));
}

/** Only the cases drawn as an edge to another task, rather than as a flow directive. */
export function jumpCasesOf(node: Node | undefined): CaseEntry[] {
	return switchCasesOf(node).filter((c) => c.routing === 'task');
}

/**
 * What a switch case can start, for the case pickers: every named workflow's Start, wherever it is
 * declared (zigflow registers them document-wide). A sibling task one of this switch's cases
 * already names — only possible from hand-written DSL — is kept in the list, flagged, so opening
 * that case doesn't silently retarget it.
 */
export function caseTargetOptions(
	switchNode: Node,
	nodes: Node[]
): { value: string; label: string }[] {
	const current = new Set(switchCasesOf(switchNode).map((c) => c.targetNodeId));
	return nodes
		.filter(
			(n) =>
				n.id !== switchNode.id &&
				((n.type === 'start' && n.id !== PRIMARY_START_NODE_ID) || current.has(n.id))
		)
		.map((n) => {
			const label = String(n.data?.label ?? n.type);
			return {
				value: n.id,
				label: n.type === 'start' ? label : `${label} (task — not a workflow)`
			};
		});
}

/** Mirrors `graph.ts`'s `PRIMARY_START_ID`, kept local so this module doesn't import the engine. */
const PRIMARY_START_NODE_ID = 'start';

/** A fresh case jumping at a given node — the one place a case's stable id is minted. */
export function newJumpCase(name: string, targetNodeId: string, condition = ''): CaseEntry {
	return { id: crypto.randomUUID(), name, condition, routing: 'task', targetNodeId };
}

/** A fresh case routed at a flow directive. */
export function newDirectiveCase(name: string, routing: CaseRouting, condition = ''): CaseEntry {
	return { id: crypto.randomUUID(), name, condition, routing };
}
