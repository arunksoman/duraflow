import { ROOT_SCOPE_ID } from './scopeKey';
import { scopeNameKey, type ChildScopeRef, type RunIndex } from './runIndex';

/**
 * Turns the scope path the backend derives from a Temporal child-workflow id chain
 * ("for_0", "try", "for_0_try", "fork_send-email") into a canvas scope id.
 *
 * zigflow builds those ids from the *construct*, not the task — `<parent>_for_<iterationKey>`,
 * `<parent>_try`, `<parent>_catch`, `<parent>_fork_<branchKey>` — so only fork branches are
 * self-identifying. Two sibling `for` tasks in one scope are genuinely indistinguishable here;
 * `RunIndex.ambiguousScopes` flags those at build time and this resolver refuses to guess,
 * falling back to matching on task name alone rather than lighting up the wrong node.
 */

export interface ScopeResolution {
	scopeId: string | null;
	ambiguous: boolean;
	reason?: string;
}

export type MatchConfidence = 'exact' | 'name-only' | 'none';

export interface NodeResolution {
	nodeId: string | null;
	scopeId: string | null;
	confidence: MatchConfidence;
}

export function resolveScopePath(index: RunIndex, scopePath: string): ScopeResolution {
	if (!scopePath) return { scopeId: ROOT_SCOPE_ID, ambiguous: false };

	const tokens = scopePath.split('_').filter(Boolean);
	let scopeId = ROOT_SCOPE_ID;

	for (let i = 0; i < tokens.length; i++) {
		const children = index.childScopesByParent.get(scopeId) ?? [];
		const token = tokens[i];

		if (token === 'try' || token === 'catch') {
			const match = uniqueChildOfKind(children, token);
			if (!match) {
				return { scopeId: null, ambiguous: true, reason: `no unique ${token} scope in ${scopeId}` };
			}
			scopeId = match.childScopeId;
			continue;
		}

		if (token === 'for') {
			// The iteration key follows and is not needed: every iteration replays the same nodes.
			i++;
			const match = uniqueChildOfKind(children, 'for');
			if (!match) {
				return { scopeId: null, ambiguous: true, reason: `no unique for scope in ${scopeId}` };
			}
			scopeId = match.childScopeId;
			continue;
		}

		if (token === 'fork') {
			// A hand-authored branch name can slug to something containing "_", so try the longest
			// remaining key first and shrink until a branch matches.
			const rest = tokens.slice(i + 1);
			const match = matchForkBranch(children, rest);
			if (!match) {
				return { scopeId: null, ambiguous: true, reason: `no fork branch matching "${rest.join('_')}"` };
			}
			scopeId = match.child.childScopeId;
			i += match.consumed;
			continue;
		}

		return { scopeId: null, ambiguous: true, reason: `unrecognised scope segment "${token}"` };
	}

	return { scopeId, ambiguous: index.ambiguousScopes.has(scopeId) };
}

function uniqueChildOfKind(children: ChildScopeRef[], kind: string): ChildScopeRef | null {
	const matches = children.filter((c) => c.kind === kind);
	return matches.length === 1 ? matches[0] : null;
}

function matchForkBranch(
	children: ChildScopeRef[],
	rest: string[]
): { child: ChildScopeRef; consumed: number } | null {
	for (let take = rest.length; take >= 1; take--) {
		const key = rest.slice(0, take).join('_');
		const child = children.find((c) => c.kind === 'fork' && c.branchKey === key);
		if (child) return { child, consumed: take };
	}
	return null;
}

/**
 * Locates the canvas node a single run event belongs to. Falls back through three levels of
 * certainty and reports which one it used, so the UI can say "this didn't resolve" instead of
 * quietly highlighting whatever matched first.
 */
export function resolveNode(index: RunIndex, scopePath: string, taskName: string): NodeResolution {
	if (!taskName) return { nodeId: null, scopeId: null, confidence: 'none' };

	const scope = resolveScopePath(index, scopePath);
	if (scope.scopeId && !scope.ambiguous) {
		const nodeId = index.byScopeAndName.get(scopeNameKey(scope.scopeId, taskName));
		if (nodeId) return { nodeId, scopeId: scope.scopeId, confidence: 'exact' };

		// A bare `do` block runs inside the same Temporal workflow as its parent, so its tasks
		// arrive carrying the parent's scope path.
		const inlineMatch = findInInlineDescendants(index, scope.scopeId, taskName);
		if (inlineMatch) return { ...inlineMatch, confidence: 'exact' };
	}

	const candidates = index.nodeIdsByName.get(taskName) ?? [];
	if (candidates.length === 1) {
		return {
			nodeId: candidates[0],
			scopeId: index.scopeIdByNodeId.get(candidates[0]) ?? null,
			confidence: 'name-only'
		};
	}

	return { nodeId: null, scopeId: scope.scopeId, confidence: 'none' };
}

function findInInlineDescendants(
	index: RunIndex,
	scopeId: string,
	taskName: string
): { nodeId: string; scopeId: string } | null {
	for (const child of index.childScopesByParent.get(scopeId) ?? []) {
		if (!child.inline) continue;
		const nodeId = index.byScopeAndName.get(scopeNameKey(child.childScopeId, taskName));
		if (nodeId) return { nodeId, scopeId: child.childScopeId };
		const deeper = findInInlineDescendants(index, child.childScopeId, taskName);
		if (deeper) return deeper;
	}
	return null;
}

/** Human-readable trail for the run log — "root → for[0] → try". */
export function describeScopePath(scopePath: string): string {
	if (!scopePath) return 'root';

	const tokens = scopePath.split('_').filter(Boolean);
	const parts: string[] = ['root'];

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token === 'for') {
			parts.push(`for[${tokens[++i] ?? '?'}]`);
		} else if (token === 'fork') {
			parts.push(`fork:${tokens.slice(i + 1).join('_') || '?'}`);
			i = tokens.length;
		} else {
			parts.push(token);
		}
	}
	return parts.join(' → ');
}
