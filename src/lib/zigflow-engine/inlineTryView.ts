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

function syntheticEdge(
	sourceId: string,
	branch: 'try' | 'catch' | 'continue',
	targetId: string,
	tryNodeId: string
): Edge {
	return {
		id: `${branch}-edge-${tryNodeId}`,
		source: sourceId,
		target: targetId,
		type: 'default',
		// A plain, unlabeled arrow for the "what runs after this try/catch finishes" continuation —
		// only "try"/"catch" get a label, since those are the two branches worth naming.
		label: branch === 'continue' ? undefined : branch,
		// `deletable`/`selectable: false` are real Edge fields xyflow itself enforces (delete-key
		// and click-select both no-op). There's no `reconnectable` field on this version's Edge
		// type — reconnect-drag is instead blocked by `ReconnectableEdge.svelte` checking this same
		// `syntheticTryEdge` tag and skipping its `EdgeReconnectAnchor`s for tagged edges.
		data: { [SYNTHETIC_TRY_EDGE_TAG]: true, tryNodeId, branch },
		deletable: false,
		selectable: false
	};
}

interface TryNodeAnalysis {
	tryNode: Node;
	tryFirst?: Node;
	tryLast?: Node;
	catchFirst?: Node;
	/** The real (persisted) edge from the try node to whatever runs after this try/catch. */
	mainContinuationEdge?: Edge;
}

/**
 * Shared traversal behind both `computeLiveSyntheticEdges` and `computeHiddenRealEdgeIds`: for
 * every `try` node in the currently-displayed `nodes`, works out its try/catch lane ordering and
 * finds the real edge representing "what runs after this try/catch" (if any — a trailing try node
 * in its scope has none).
 */
function analyzeTryNodes(nodes: Node[], edges: Edge[]): TryNodeAnalysis[] {
	const ownerOf = new Map<string, string>();
	for (const n of nodes) {
		const owner = (n.data as Record<string, unknown> | undefined)?.[OWNER_SCOPE_TAG] as
			string | undefined;
		if (owner) ownerOf.set(n.id, owner);
	}

	const result: TryNodeAnalysis[] = [];
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

		const tryOrdered = orderNodesInScope(tryLaneNodes, tryLaneEdges);
		const catchOrdered = orderNodesInScope(catchLaneNodes, catchLaneEdges);

		const mainContinuationEdge = edges.find(
			(e) =>
				e.source === n.id &&
				!(e.data as Record<string, unknown> | undefined)?.[SYNTHETIC_TRY_EDGE_TAG]
		);

		result.push({
			tryNode: n,
			tryFirst: tryOrdered[0],
			tryLast: tryOrdered[tryOrdered.length - 1],
			catchFirst: catchOrdered[0],
			mainContinuationEdge
		});
	}
	return result;
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
	const hiddenIds = computeHiddenRealEdgeIds(allNodes, allRealEdges);
	const displayRealEdges = allRealEdges.map((e) =>
		hiddenIds.has(e.id) ? { ...e, hidden: true } : e
	);
	return {
		nodes: allNodes,
		edges: [...displayRealEdges, ...computeLiveSyntheticEdges(allNodes, allRealEdges)],
		tryBounds,
		catchBounds
	};
}

/**
 * Computes the "try"/"catch"/continuation synthetic edges directly from the *currently displayed*
 * `nodes`/`edges` (via their `__ownerScopeId` tags), rather than from a one-off scope lookup.
 * Unlike the edges baked into `composeScopeForDisplay`'s one-time result (only fresh right after a
 * scope switch), this can be recomputed as a plain reactive `$derived`/effect input off
 * `nodes`/`edges` in the Svelte layer, so a node dropped into a lane after the initial load still
 * gets a synthetic edge pointing at it instead of silently having none.
 *
 * Semantics matter here: a `try` node isn't a fork between "try" and "catch" — the try body always
 * runs, and only *if it errors* does control jump to catch. So the "try" edge leaves the control
 * node, but the "catch" edge (and the plain "what runs next" continuation edge) both leave the
 * *last node of the try body* instead — visually showing "try body runs, and only on error does it
 * detour to catch", matching the user-provided mockup, rather than "the control node picks one of
 * two branches". When the try body is empty, both fall back to leaving the control node itself.
 */
export function computeLiveSyntheticEdges(nodes: Node[], edges: Edge[]): Edge[] {
	const synthesized: Edge[] = [];
	for (const a of analyzeTryNodes(nodes, edges)) {
		if (a.tryFirst)
			synthesized.push(syntheticEdge(a.tryNode.id, 'try', a.tryFirst.id, a.tryNode.id));

		const catchSourceId = a.tryLast?.id ?? a.tryNode.id;
		if (a.catchFirst) {
			synthesized.push(syntheticEdge(catchSourceId, 'catch', a.catchFirst.id, a.tryNode.id));
		}
		if (a.tryLast && a.mainContinuationEdge) {
			synthesized.push(
				syntheticEdge(a.tryLast.id, 'continue', a.mainContinuationEdge.target, a.tryNode.id)
			);
		}
	}
	return synthesized;
}

/**
 * Ids of real (persisted) edges that `computeLiveSyntheticEdges` has visually replaced with a
 * relocated continuation edge (see above) — these must be rendered `hidden: true` rather than
 * removed outright, since the real edge (`tryNode -> next`) still has to survive in `scopes` for
 * DSL ordering to stay correct; only its on-canvas presentation is superseded.
 *
 * Known limitation: because the visible replacement is a non-reconnectable synthetic edge (see
 * `ReconnectableEdge.svelte`), there's currently no drag-to-reconnect way to change "what runs
 * after this try/catch" from the canvas — use the DSL editor for that instead.
 */
export function computeHiddenRealEdgeIds(nodes: Node[], edges: Edge[]): Set<string> {
	const ids = new Set<string>();
	for (const a of analyzeTryNodes(nodes, edges)) {
		if (a.tryLast && a.mainContinuationEdge) ids.add(a.mainContinuationEdge.id);
	}
	return ids;
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
		// `hidden` is a display-only flag set when a continuation edge was visually relocated (see
		// `computeHiddenRealEdgeIds`) — never persist it, or the edge would come back permanently
		// hidden even once nothing is superseding it.
		const edgeRest = { ...e } as Edge & { hidden?: boolean };
		delete edgeRest.hidden;
		grouped[owner].edges.push(edgeRest);
	}

	return grouped;
}
