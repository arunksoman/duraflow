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

/** Horizontal pitch (in flow coordinates) between one inline lane/column and the next. */
export const INLINE_LANE_OFFSET_X = 260;

export interface LaneBounds {
	x: number;
	yStart: number;
	yEnd: number;
	width: number;
}

/**
 * One inline lane belonging to a container node (a `for`/bare-`do`'s body, one of `try`'s two
 * lanes, or one `fork` branch). `laneMap` is this lane's own nested lanes (empty if nothing inside
 * this lane's chain itself has further nested lanes) — this is what lets `layoutScopeRecursive`
 * recurse to arbitrary depth instead of stopping at one level.
 */
export interface ScopeLane {
	key: string;
	nodes: Node[];
	edges: Edge[];
	laneMap: LaneMap;
}

/** Owning node id -> its ordered list of lanes (1 for for/do, 2 for try, N for fork). */
export type LaneMap = Map<string, ScopeLane[]>;

interface ChainFootprint {
	/** Rows this chain (including any of its own nested lanes) occupies vertically. */
	rows: number;
	/** Columns this chain (including any of its own nested lanes) occupies horizontally, in units of `INLINE_LANE_OFFSET_X`. */
	columns: number;
}

/**
 * Lays out a scope's main chain like `layoutScope`, except that for every node present as a key in
 * `laneMap`, its lanes are laid out as extra side columns starting immediately to the right of it,
 * recursing into each lane's own `laneMap` to place any further-nested containers (a `fork` branch
 * that itself has a nested `for`, etc.) — to arbitrary depth. A lane's column footprint is measured
 * bottom-up (via each recursive call's return value) *before* its next sibling lane is positioned,
 * so a lane widened by deep nesting never overlaps the next lane over. The main chain's row cursor
 * is bumped past whichever is taller (the next main-chain row, or the tallest sibling lane) before
 * resuming, generalizing the row-bump idea to N lanes instead of a hardcoded 2.
 *
 * Returns one flat `Map<laneKey, LaneBounds>` (keyed by the lane's own scope key, e.g.
 * `root/fork1/branch/abc` — already globally unique, so no owner-id prefix is needed) covering
 * every lane at every depth, used for drag-and-drop hit-testing.
 */
export function layoutScopeRecursive(
	mainNodes: Node[],
	mainEdges: Edge[],
	laneMap: LaneMap,
	opts: LayoutOptions = {}
): Map<string, LaneBounds> {
	const { originX = 200, originY = 80, rowHeight = 120 } = opts;
	const laneBounds = new Map<string, LaneBounds>();
	positionChain(mainNodes, mainEdges, laneMap, originX, originY, rowHeight, laneBounds);
	return laneBounds;
}

function positionChain(
	nodes: Node[],
	edges: Edge[],
	laneMap: LaneMap,
	originX: number,
	originY: number,
	rowHeight: number,
	laneBoundsOut: Map<string, LaneBounds>
): ChainFootprint {
	const ordered = orderNodesInScope(nodes, edges);
	let row = 0;
	let columns = 1;

	for (const node of ordered) {
		node.position = { x: originX, y: originY + row * rowHeight };
		row++;

		const lanes = laneMap.get(node.id);
		if (!lanes || lanes.length === 0) continue;

		const laneStartRow = row;
		let colOffset = 1;
		// Reserve at least one row even when every lane is empty — otherwise there's no bounding
		// box to drop-target until *something* is already in it (a chicken-and-egg gap: the very
		// first node could never be dragged into a brand-new empty lane).
		let maxLaneRows = 1;

		for (const lane of lanes) {
			const laneX = originX + colOffset * INLINE_LANE_OFFSET_X;
			const laneY = originY + laneStartRow * rowHeight;
			const laneOrdered = orderNodesInScope(lane.nodes, lane.edges);
			const footprint = positionChain(
				lane.nodes,
				lane.edges,
				lane.laneMap,
				laneX,
				laneY,
				rowHeight,
				laneBoundsOut
			);

			laneBoundsOut.set(lane.key, {
				x: laneX,
				yStart: laneY,
				yEnd: laneY + Math.max(laneOrdered.length, 1) * rowHeight,
				width: NODE_CARD_WIDTH
			});

			colOffset += footprint.columns;
			maxLaneRows = Math.max(maxLaneRows, footprint.rows);
		}

		columns = Math.max(columns, colOffset);
		row += maxLaneRows;
	}

	return { rows: Math.max(row, 1), columns };
}
