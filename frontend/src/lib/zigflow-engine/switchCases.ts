import type { Node } from '@xyflow/svelte';
import type { CaseEntry, CaseRouting } from '../components/builder/builderConfig';

/**
 * Shared reading of a `switch` node's cases, so `graph.ts` (DSL <-> canvas), `inlineScopeView.ts`
 * (what is drawn) and `runIndex.ts` (run correlation) can never disagree about where a case goes.
 *
 * Every case is a condition plus a routing, and a routing is always a *jump*: at a task the switch
 * can reach, or at one of the DSL's three flow directives. A case never owns a body — the DSL has
 * no way to express "run these steps, then rejoin", because the named workflow a `then:` points at
 * runs to its own End (see `zigflow graph`).
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

/** A fresh case jumping at a given node — the one place a case's stable id is minted. */
export function newJumpCase(name: string, targetNodeId: string, condition = ''): CaseEntry {
	return { id: crypto.randomUUID(), name, condition, routing: 'task', targetNodeId };
}

/** A fresh case routed at a flow directive. */
export function newDirectiveCase(name: string, routing: CaseRouting, condition = ''): CaseEntry {
	return { id: crypto.randomUUID(), name, condition, routing };
}
