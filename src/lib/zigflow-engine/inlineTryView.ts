import type { Node, Edge } from '@xyflow/svelte';
import type { ScopeGraph } from './graph';
import { tryScopeKey, catchScopeKey } from './scopeKey';
import {
	layoutScopeWithInlineTry,
	orderNodesInScope,
	NODE_CARD_WIDTH,
	INLINE_LANE_OFFSET_X,
	type InlineTryLane,
	type InlineLayoutResult,
	type LaneBounds
} from './layout';

/** Approximate rendered height of a `WorkflowNode` card, for live bounding-box purposes only. */
const NODE_CARD_HEIGHT = 80;
const ROW_HEIGHT = 120;

/**
 * Runtime-only tag recording which real `scopes[...]` entry a displayed node actually belongs to.
 * Lives inside `node.data` (xyflow's `Node` has no first-class metadata slot outside `data`),
 * `__`-prefixed to mark it as engine-internal. Never read by `zigflow-engine/graph.ts` (which
 * only ever sees real per-scope arrays, not this composed/flattened view) and stripped again by
 * `decomposeDisplayedScope` before anything is written back to `scopes`.
 */
export const OWNER_SCOPE_TAG = '__ownerScopeId';

/** Marks a synthetic "try"/"catch" labeled edge — computed fresh every compose, never persisted. */
export const SYNTHETIC_TRY_EDGE_TAG = 'syntheticTryEdge';

export interface ComposedScope extends InlineLayoutResult {
	nodes: Node[];
	edges: Edge[];
}

function tagNode(node: Node, ownerScopeId: string): Node {
	return { ...node, data: { ...node.data, [OWNER_SCOPE_TAG]: ownerScopeId } };
}

function syntheticEdge(tryNodeId: string, branch: 'try' | 'catch', targetId: string): Edge {
	return {
		id: `${branch}-edge-${tryNodeId}`,
		source: tryNodeId,
		target: targetId,
		type: 'default',
		label: branch,
		// `deletable`/`selectable: false` are real Edge fields xyflow itself enforces (delete-key
		// and click-select both no-op). There's no `reconnectable` field on this version's Edge
		// type — reconnect-drag is instead blocked by `ReconnectableEdge.svelte` checking this same
		// `syntheticTryEdge` tag and skipping its `EdgeReconnectAnchor`s for tagged edges.
		data: { [SYNTHETIC_TRY_EDGE_TAG]: true, tryNodeId, branch },
		deletable: false,
		selectable: false
	};
}

/**
 * Flattens a scope for display: its own nodes/edges, plus — for every `try` node directly in it —
 * that try node's try-scope and catch-scope nodes/edges inlined as tagged siblings, connected via
 * synthetic labeled edges. A scope with no `try` nodes passes through unchanged (every node tagged
 * with the scope's own id, zero synthetic edges) — `for`/`fork`/plain `do` scopes are unaffected.
 *
 * Does not read or write `scopes` outside the one lookup pass here — safe to call from anywhere,
 * including reactive contexts, without risking the "effect reads and writes the same state"
 * infinite-loop trap documented in the Svelte layer.
 */
export function composeScopeForDisplay(
	scopes: Record<string, ScopeGraph>,
	scopeId: string
): ComposedScope {
	const base = scopes[scopeId] ?? { nodes: [], edges: [] };
	const mainNodes = base.nodes.map((n) => tagNode(n, scopeId));
	const mainEdges = [...base.edges];

	const tryLanes = new Map<string, InlineTryLane>();
	const laneNodes: Node[] = [];
	const laneEdges: Edge[] = [];

	for (const n of mainNodes) {
		if (n.type !== 'try') continue;
		const tryKey = tryScopeKey(scopeId, n.id);
		const catchKey = catchScopeKey(scopeId, n.id);
		const tScope = scopes[tryKey] ?? { nodes: [], edges: [] };
		const cScope = scopes[catchKey] ?? { nodes: [], edges: [] };

		const tryNodes = tScope.nodes.map((tn) => tagNode(tn, tryKey));
		const catchNodes = cScope.nodes.map((cn) => tagNode(cn, catchKey));

		laneNodes.push(...tryNodes, ...catchNodes);
		laneEdges.push(...tScope.edges, ...cScope.edges);

		tryLanes.set(n.id, { tryNodes, tryEdges: tScope.edges, catchNodes, catchEdges: cScope.edges });
	}

	const { tryBounds, catchBounds } = layoutScopeWithInlineTry(mainNodes, mainEdges, tryLanes);

	const allNodes = [...mainNodes, ...laneNodes];
	const allRealEdges = [...mainEdges, ...laneEdges];
	return {
		nodes: allNodes,
		edges: [...allRealEdges, ...computeLiveSyntheticEdges(allNodes, allRealEdges)],
		tryBounds,
		catchBounds
	};
}

/**
 * Computes the "try"/"catch" labeled synthetic edges directly from the *currently displayed*
 * `nodes`/`edges` (via their `__ownerScopeId` tags), rather than from a one-off scope lookup.
 * Unlike the edges baked into `composeScopeForDisplay`'s one-time result (only fresh right after a
 * scope switch), this can be recomputed as a plain reactive `$derived`/effect input off
 * `nodes`/`edges` in the Svelte layer, so a node dropped into a lane after the initial load still
 * gets a synthetic edge pointing at it instead of silently having none.
 */
export function computeLiveSyntheticEdges(nodes: Node[], edges: Edge[]): Edge[] {
	const ownerOf = new Map<string, string>();
	for (const n of nodes) {
		const owner = (n.data as Record<string, unknown> | undefined)?.[OWNER_SCOPE_TAG] as
			string | undefined;
		if (owner) ownerOf.set(n.id, owner);
	}

	const synthesized: Edge[] = [];
	for (const n of nodes) {
		if (n.type !== 'try') continue;
		const parentScopeId = ownerOf.get(n.id);
		if (!parentScopeId) continue;
		const tryKey = tryScopeKey(parentScopeId, n.id);
		const catchKey = catchScopeKey(parentScopeId, n.id);

		const tryLaneNodes = nodes.filter((ln) => ownerOf.get(ln.id) === tryKey);
		const catchLaneNodes = nodes.filter((ln) => ownerOf.get(ln.id) === catchKey);
		const tryLaneEdges = edges.filter(
			(e) => ownerOf.get(e.source) === tryKey && ownerOf.get(e.target) === tryKey
		);
		const catchLaneEdges = edges.filter(
			(e) => ownerOf.get(e.source) === catchKey && ownerOf.get(e.target) === catchKey
		);

		const tryFirst = orderNodesInScope(tryLaneNodes, tryLaneEdges)[0];
		const catchFirst = orderNodesInScope(catchLaneNodes, catchLaneEdges)[0];
		if (tryFirst) synthesized.push(syntheticEdge(n.id, 'try', tryFirst.id));
		if (catchFirst) synthesized.push(syntheticEdge(n.id, 'catch', catchFirst.id));
	}
	return synthesized;
}

/**
 * Computes try/catch lane bounding boxes directly from the *currently displayed* `nodes` array's
 * actual positions — no scope lookup, no re-layout. Unlike the bounds returned by
 * `composeScopeForDisplay` (only fresh right after a scope switch), this can be recomputed as a
 * plain reactive `$derived` off `nodes` in the Svelte layer, so it never goes stale after a node
 * is added or dragged without a full scope reload. Falls back to a placeholder box positioned
 * relative to the try node itself when a lane has no nodes in it yet (so the very first node
 * dropped into an empty lane still has something to hit-test against).
 */
export function computeLiveLaneBounds(nodes: Node[]): {
	tryBounds: Map<string, LaneBounds>;
	catchBounds: Map<string, LaneBounds>;
} {
	const tryBounds = new Map<string, LaneBounds>();
	const catchBounds = new Map<string, LaneBounds>();

	for (const n of nodes) {
		if (n.type !== 'try') continue;
		const parentScopeId = (n.data as Record<string, unknown> | undefined)?.[OWNER_SCOPE_TAG] as
			string | undefined;
		if (!parentScopeId) continue;

		const tryKey = tryScopeKey(parentScopeId, n.id);
		const catchKey = catchScopeKey(parentScopeId, n.id);
		const tryLaneNodes = nodes.filter(
			(ln) => (ln.data as Record<string, unknown> | undefined)?.[OWNER_SCOPE_TAG] === tryKey
		);
		const catchLaneNodes = nodes.filter(
			(ln) => (ln.data as Record<string, unknown> | undefined)?.[OWNER_SCOPE_TAG] === catchKey
		);

		tryBounds.set(
			n.id,
			laneBoundsFromNodes(
				tryLaneNodes,
				n.position.x + INLINE_LANE_OFFSET_X,
				n.position.y + ROW_HEIGHT
			)
		);
		catchBounds.set(
			n.id,
			laneBoundsFromNodes(
				catchLaneNodes,
				n.position.x + INLINE_LANE_OFFSET_X * 2,
				n.position.y + ROW_HEIGHT
			)
		);
	}

	return { tryBounds, catchBounds };
}

function laneBoundsFromNodes(laneNodes: Node[], fallbackX: number, fallbackY: number): LaneBounds {
	if (laneNodes.length === 0) {
		return {
			x: fallbackX,
			yStart: fallbackY,
			yEnd: fallbackY + ROW_HEIGHT,
			width: NODE_CARD_WIDTH
		};
	}
	const xs = laneNodes.map((n) => n.position.x);
	const ys = laneNodes.map((n) => n.position.y);
	return {
		x: Math.min(...xs),
		yStart: Math.min(...ys),
		yEnd: Math.max(...ys) + NODE_CARD_HEIGHT,
		width: Math.max(...xs) - Math.min(...xs) + NODE_CARD_WIDTH
	};
}

/**
 * Inverse of `composeScopeForDisplay` — splits a displayed (possibly flattened) node/edge list
 * back into a partial `scopes` map, one entry per distinct owner scope actually present. Always
 * merge (spread) the result over the existing `scopes`, never replace it wholesale — this returns
 * only the scopes touched by what's currently displayed, and a naive replace would silently drop
 * every other scope not in view (e.g. a sibling `for` loop's body).
 */
export function decomposeDisplayedScope(
	displayedNodes: Node[],
	displayedEdges: Edge[]
): Record<string, ScopeGraph> {
	const grouped: Record<string, ScopeGraph> = {};
	const ownerOf = new Map<string, string>();

	for (const n of displayedNodes) {
		const data = (n.data ?? {}) as Record<string, unknown>;
		const owner = (data[OWNER_SCOPE_TAG] as string | undefined) ?? '';
		if (!owner) continue;
		ownerOf.set(n.id, owner);
		if (!grouped[owner]) grouped[owner] = { nodes: [], edges: [] };
		const restData = { ...data };
		delete restData[OWNER_SCOPE_TAG];
		grouped[owner].nodes.push({ ...n, data: restData });
	}

	for (const e of displayedEdges) {
		if ((e.data as Record<string, unknown> | undefined)?.[SYNTHETIC_TRY_EDGE_TAG]) continue;
		const owner = ownerOf.get(e.source) ?? ownerOf.get(e.target);
		if (!owner) continue;
		if (!grouped[owner]) grouped[owner] = { nodes: [], edges: [] };
		grouped[owner].edges.push(e);
	}

	return grouped;
}
