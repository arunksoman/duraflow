import type { Node, Edge } from '@xyflow/svelte';

/**
 * Orders a single scope's nodes into one execution chain. Unlike the old whole-canvas
 * `topoSort`, this never needs to handle fan-out: every Fork branch lives in its own separate
 * drill-in scope (see `scopeKey.ts`), so within any one scope the nodes always form, at most,
 * a single linear chain from an entry node (the `start` node at the root scope, or whichever
 * node has no incoming edge in a nested scope) to the end.
 */
export function orderNodesInScope(nodes: Node[], edges: Edge[]): Node[] {
	if (nodes.length === 0) return [];
	const nextMap = new Map<string, string>();
	const hasIncoming = new Set<string>();
	for (const e of edges) {
		nextMap.set(e.source, e.target);
		hasIncoming.add(e.target);
	}
	const entryCandidates = nodes.filter((n) => !hasIncoming.has(n.id));
	const entry = entryCandidates.find((n) => n.type === 'start') ?? entryCandidates[0] ?? nodes[0];

	const ordered: Node[] = [];
	const visited = new Set<string>();
	let current: Node | undefined = entry;
	while (current && !visited.has(current.id)) {
		visited.add(current.id);
		ordered.push(current);
		const nextId = nextMap.get(current.id);
		current = nextId ? nodes.find((n) => n.id === nextId) : undefined;
	}
	// Safety net for malformed/disconnected graphs — append anything not reached above.
	for (const n of nodes) if (!visited.has(n.id)) ordered.push(n);
	return ordered;
}

export interface LayoutOptions {
	originX?: number;
	originY?: number;
	rowHeight?: number;
}

/** Lays out a scope's nodes as a single vertical chain (mutates each node's `position`). */
export function layoutScope(nodes: Node[], edges: Edge[], opts: LayoutOptions = {}): void {
	const { originX = 200, originY = 80, rowHeight = 120 } = opts;
	const ordered = orderNodesInScope(nodes, edges);
	ordered.forEach((n, i) => {
		n.position = { x: originX, y: originY + i * rowHeight };
	});
}

/** Matches `WorkflowNode.svelte`'s card width (`w-44` = 11rem @ 16px root = 176px). */
export const NODE_CARD_WIDTH = 176;

/** Horizontal offset (in flow coordinates) of a try node's inline try-lane; catch-lane is 2x this. */
export const INLINE_LANE_OFFSET_X = 260;

export interface InlineTryLane {
	tryNodes: Node[];
	tryEdges: Edge[];
	catchNodes: Node[];
	catchEdges: Edge[];
}

export interface LaneBounds {
	x: number;
	yStart: number;
	yEnd: number;
	width: number;
}

export interface InlineLayoutResult {
	/** try-node id -> its try-lane's bounding box (absent if the lane is empty). */
	tryBounds: Map<string, LaneBounds>;
	/** try-node id -> its catch-lane's bounding box (absent if the lane is empty). */
	catchBounds: Map<string, LaneBounds>;
}

/**
 * Lays out a scope's main chain exactly like `layoutScope`, except that for every node present
 * as a key in `tryLanes`, its try-lane and catch-lane nodes are laid out as two extra side columns
 * immediately below it, and the main chain's row cursor is bumped past whichever is taller (the
 * next main-chain row, or the lane extent) before resuming — so a second `try` node further down
 * the same chain never has its lanes collide with an earlier one's.
 */
export function layoutScopeWithInlineTry(
	mainNodes: Node[],
	mainEdges: Edge[],
	tryLanes: Map<string, InlineTryLane>,
	opts: LayoutOptions = {}
): InlineLayoutResult {
	const { originX = 200, originY = 80, rowHeight = 120 } = opts;
	const laneOffsetX = INLINE_LANE_OFFSET_X;
	const tryBounds = new Map<string, LaneBounds>();
	const catchBounds = new Map<string, LaneBounds>();

	const ordered = orderNodesInScope(mainNodes, mainEdges);
	let row = 0;

	for (const node of ordered) {
		node.position = { x: originX, y: originY + row * rowHeight };
		row++;

		const lanes = tryLanes.get(node.id);
		if (!lanes) continue;

		const tryOrdered = orderNodesInScope(lanes.tryNodes, lanes.tryEdges);
		const catchOrdered = orderNodesInScope(lanes.catchNodes, lanes.catchEdges);
		const laneStartRow = row;

		tryOrdered.forEach((n, i) => {
			n.position = { x: originX + laneOffsetX, y: originY + (laneStartRow + i) * rowHeight };
		});
		catchOrdered.forEach((n, i) => {
			n.position = { x: originX + laneOffsetX * 2, y: originY + (laneStartRow + i) * rowHeight };
		});

		// Reserve at least one row's worth of bounds even for an empty lane — otherwise there's no
		// bounding box to drop-target until *something* is already in it (a chicken-and-egg gap:
		// the very first node could never be dragged in).
		tryBounds.set(node.id, {
			x: originX + laneOffsetX,
			yStart: originY + laneStartRow * rowHeight,
			yEnd: originY + (laneStartRow + Math.max(tryOrdered.length, 1)) * rowHeight,
			width: NODE_CARD_WIDTH
		});
		catchBounds.set(node.id, {
			x: originX + laneOffsetX * 2,
			yStart: originY + laneStartRow * rowHeight,
			yEnd: originY + (laneStartRow + Math.max(catchOrdered.length, 1)) * rowHeight,
			width: NODE_CARD_WIDTH
		});

		row += Math.max(tryOrdered.length, catchOrdered.length);
	}

	return { tryBounds, catchBounds };
}
