import type { Node, Edge } from '@xyflow/svelte';
import type { ScopeGraph } from './graph';
import { forScopeKey, tryScopeKey, catchScopeKey, forkBranchScopeKey } from './scopeKey';
import type { BranchEntry, CaseEntry } from '../components/builder/builderConfig';
import {
	layoutScopeRecursive,
	orderNodesInScope,
	NODE_CARD_WIDTH,
	INLINE_LANE_OFFSET_X,
	type LaneMap,
	type ScopeLane,
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

/** Marks a synthetic inline-lane edge (entry or continuation) — computed fresh every compose, never persisted. */
export const SYNTHETIC_SCOPE_EDGE_TAG = 'syntheticScopeEdge';

/** `edge.type` for a switch case's jump edge — resolves to `SwitchCaseEdge.svelte` via `edgeTypes`. */
export const SWITCH_CASE_EDGE_TYPE = 'switchCase';

/** Matches `NODE_META.switch.color`, so a case edge reads as belonging to the switch that owns it. */
const SWITCH_CASE_COLOR = '#06b6d4';

/**
 * How far left of the main column a case edge bows, and how much each further case of the same
 * switch adds — nesting the bows keeps sibling cases from overdrawing one another.
 */
const CASE_BOW_BASE = 72;
const CASE_BOW_STEP = 34;

export interface ComposedScope {
	nodes: Node[];
	edges: Edge[];
	/** Bounding box per lane, keyed by the lane's own scope key (already globally unique). */
	laneBounds: Map<string, LaneBounds>;
}

function tagNode(node: Node, ownerScopeId: string): Node {
	return { ...node, data: { ...node.data, [OWNER_SCOPE_TAG]: ownerScopeId } };
}

function ownerTag(node: Node): string | undefined {
	return (node.data as Record<string, unknown> | undefined)?.[OWNER_SCOPE_TAG] as
		string | undefined;
}

function buildOwnerMap(nodes: Node[]): Map<string, string> {
	const ownerOf = new Map<string, string>();
	for (const n of nodes) {
		const owner = ownerTag(n);
		if (owner) ownerOf.set(n.id, owner);
	}
	return ownerOf;
}

/**
 * One inline lane a container node (`for`/bare-`do`, `try`, `fork`) needs on the canvas, and
 * the real scope key backing it. `redirectContinuation` is set ONLY for try's first (try-body)
 * lane — see `analyzeContainerNodes` below for what that actually changes.
 */
interface LaneSpec {
	key: string;
	label: string;
	redirectContinuation?: boolean;
}

/**
 * Single data-driven table replacing what used to be three separate `if (n.type !== 'try')
 * continue` guards. Re-derives fresh from `node.data.branches` every call, so fork branch
 * add/remove needs no special-casing anywhere else — every consumer just calls this again.
 */
function laneSpecsFor(node: Node, parentScopeId: string): LaneSpec[] {
	switch (node.type) {
		case 'for':
		case 'do':
			return [{ key: forScopeKey(parentScopeId, node.id), label: 'body' }];
		case 'try':
			return [
				{ key: tryScopeKey(parentScopeId, node.id), label: 'try', redirectContinuation: true },
				{ key: catchScopeKey(parentScopeId, node.id), label: 'catch' }
			];
		case 'fork': {
			const branches = (node.data?.branches as BranchEntry[] | undefined) ?? [];
			return branches.map((b) => ({
				key: forkBranchScopeKey(parentScopeId, node.id, b.id),
				label: b.name || 'branch'
			}));
		}
		default:
			return [];
	}
}

function laneEntryEdge(
	sourceId: string,
	label: string,
	targetId: string,
	ownerNodeId: string,
	laneKey: string
): Edge {
	return {
		id: `lane-entry-${laneKey}`,
		source: sourceId,
		target: targetId,
		type: 'default',
		label,
		// `deletable`/`selectable: false` are real Edge fields xyflow itself enforces (delete-key
		// and click-select both no-op). There's no `reconnectable` field on this version's Edge
		// type — reconnect-drag is instead blocked by `ReconnectableEdge.svelte` checking this same
		// `syntheticScopeEdge` tag and skipping its `EdgeReconnectAnchor`s for tagged edges.
		data: { [SYNTHETIC_SCOPE_EDGE_TAG]: true, ownerNodeId, laneKey, kind: 'entry' },
		deletable: false,
		selectable: false
	};
}

function continuationEdge(sourceId: string, targetId: string, ownerNodeId: string): Edge {
	return {
		id: `continue-edge-${ownerNodeId}`,
		source: sourceId,
		target: targetId,
		type: 'default',
		data: { [SYNTHETIC_SCOPE_EDGE_TAG]: true, ownerNodeId, kind: 'continue' },
		deletable: false,
		selectable: false
	};
}

function terminalEdge(sourceId: string, targetId: string): Edge {
	return {
		id: `terminal-edge-${sourceId}`,
		source: sourceId,
		target: targetId,
		type: 'default',
		data: { [SYNTHETIC_SCOPE_EDGE_TAG]: true, kind: 'terminal' },
		deletable: false,
		selectable: false
	};
}

interface LaneAnalysis {
	spec: LaneSpec;
	first?: Node;
	last?: Node;
}

interface ContainerNodeAnalysis {
	node: Node;
	lanes: LaneAnalysis[];
	/** Entry-edge source id for each lane, parallel to `lanes` — the control node, unless a prior lane was flagged `redirectContinuation`. */
	entrySources: string[];
	/** Set only when some lane was flagged `redirectContinuation` (currently: try's first lane). */
	continuationSourceId?: string;
	/** The real (persisted) edge from this node to whatever runs after it, if any. */
	mainContinuationEdge?: Edge;
}

/**
 * Shared traversal behind `computeLiveSyntheticEdges` and `computeHiddenRealEdgeIds`: for every
 * container node (any type with lane specs) in the currently-displayed `nodes`, works out each
 * lane's ordering and — only for lanes flagged `redirectContinuation` — where the *next* lane's
 * entry edge and the main continuation edge should actually be sourced from instead of the control
 * node. `for`/`do`/`fork` lanes never redirect (they're genuine pass-throughs/fan-outs, not
 * "maybe-diverts-but-still-continues" like `try`), so this only ever fires for `try`.
 */
function analyzeContainerNodes(nodes: Node[], edges: Edge[]): ContainerNodeAnalysis[] {
	const ownerOf = buildOwnerMap(nodes);
	const result: ContainerNodeAnalysis[] = [];

	for (const n of nodes) {
		const parentScopeId = ownerOf.get(n.id);
		if (!parentScopeId) continue;
		const specs = laneSpecsFor(n, parentScopeId);
		if (specs.length === 0) continue;

		const lanes: LaneAnalysis[] = [];
		const entrySources: string[] = [];
		let entrySourceId = n.id;
		let continuationSourceId: string | undefined;

		for (const spec of specs) {
			entrySources.push(entrySourceId);
			const laneNodes = nodes.filter((ln) => ownerOf.get(ln.id) === spec.key);
			const laneEdges = edges.filter(
				(e) => ownerOf.get(e.source) === spec.key && ownerOf.get(e.target) === spec.key
			);
			const ordered = orderNodesInScope(laneNodes, laneEdges);
			const first = ordered[0];
			const last = ordered[ordered.length - 1];
			lanes.push({ spec, first, last });

			if (spec.redirectContinuation) {
				entrySourceId = last?.id ?? entrySourceId;
				continuationSourceId = last?.id ?? n.id;
			} else {
				entrySourceId = n.id;
			}
		}

		const mainContinuationEdge = continuationSourceId
			? edges.find(
					(e) =>
						e.source === n.id &&
						!(e.data as Record<string, unknown> | undefined)?.[SYNTHETIC_SCOPE_EDGE_TAG]
				)
			: undefined;

		result.push({ node: n, lanes, entrySources, continuationSourceId, mainContinuationEdge });
	}

	return result;
}

/**
 * Computes every inline lane's entry edge (e.g. "body", "try", "catch", or a fork branch's real
 * `name`) plus, only for `try`, the relocated continuation edge — directly from the *currently
 * displayed* `nodes`/`edges` (via their `__ownerScopeId` tags) rather than a one-off scope lookup,
 * so this can be recomputed as a plain reactive `$derived`/effect input off `nodes`/`edges` in the
 * Svelte layer (a node dropped into a lane after the initial load still gets an edge pointing at
 * it, and a fork branch added/removed at runtime is reflected with no extra bookkeeping).
 */
export function computeLiveSyntheticEdges(nodes: Node[], edges: Edge[]): Edge[] {
	const synthesized: Edge[] = [];
	for (const a of analyzeContainerNodes(nodes, edges)) {
		a.lanes.forEach((lane, i) => {
			if (lane.first) {
				synthesized.push(
					laneEntryEdge(a.entrySources[i], lane.spec.label, lane.first.id, a.node.id, lane.spec.key)
				);
			}
		});
		if (a.continuationSourceId && a.mainContinuationEdge) {
			synthesized.push(
				continuationEdge(a.continuationSourceId, a.mainContinuationEdge.target, a.node.id)
			);
		}
	}
	return synthesized;
}

/**
 * Every node in the composed canvas that has no outgoing edge at all — a fork branch's last task,
 * a for/do body's last task, an empty container with nothing in its lane and no continuation —
 * gets a synthetic edge pointing at the workflow's `end` node, so no path on the canvas trails off
 * looking open-ended (matching the same "always show where a path terminates" convention `start`/
 * `end` already establish for the main chain). Purely visual: tagged synthetic, never persisted.
 *
 * `edges` must already include every other synthetic edge (`computeLiveSyntheticEdges`'s output),
 * or a node whose only "outgoing" connection is itself synthetic (e.g. try's redirected
 * continuation source) would be wrongly treated as a dead end.
 */
export function computeTerminalEdges(nodes: Node[], edges: Edge[]): Edge[] {
	const endNode = nodes.find((n) => n.type === 'end');
	if (!endNode) return [];
	const hasOutgoing = new Set(edges.map((e) => e.source));
	const terminal: Edge[] = [];
	for (const n of nodes) {
		if (n.id === endNode.id || hasOutgoing.has(n.id)) continue;
		terminal.push(terminalEdge(n.id, endNode.id));
	}
	return terminal;
}

function isSyntheticEdge(edge: Edge): boolean {
	return Boolean((edge.data as Record<string, unknown> | undefined)?.[SYNTHETIC_SCOPE_EDGE_TAG]);
}

function switchCasesOf(node: Node): CaseEntry[] {
	const cases = (node.data as Record<string, unknown> | undefined)?.cases;
	return Array.isArray(cases) ? (cases as CaseEntry[]) : [];
}

/** The real (persisted) "and then the next sibling runs" edge leaving a node, if there is one. */
function fallThroughTargetOf(nodeId: string, edges: Edge[]): string | undefined {
	return edges.find((e) => e.source === nodeId && !isSyntheticEdge(e))?.target;
}

/**
 * Where a single `switch` case actually sends the run, as a node id on the composed canvas:
 *
 * - `continue` — the switch's own fall-through target (the next sibling task).
 * - `exit` / `end` — both stop the path being drawn. They differ in the DSL (leave the current
 *   scope vs. terminate the workflow) but the canvas has exactly one `end` node, so both point
 *   there rather than inventing a second terminator per nesting level.
 * - anything else — a task id, valid only when it names a sibling in the switch's *own* scope
 *   (the Zigflow spec forbids cross-scope `then`, and `NodePanel`'s picker enforces the same), so
 *   a stale id left over from a moved/deleted node draws nothing instead of a wrong arrow.
 */
function switchCaseTargetId(
	then: string,
	switchScopeId: string | undefined,
	ownerOf: Map<string, string>,
	byId: Map<string, Node>,
	fallThroughId: string | undefined,
	endNodeId: string | undefined
): string | undefined {
	if (then === 'continue') return fallThroughId ?? endNodeId;
	if (then === 'exit' || then === 'end') return endNodeId;
	const target = byId.get(then);
	if (!target || ownerOf.get(target.id) !== switchScopeId) return undefined;
	return target.id;
}

/**
 * One labeled edge per `switch` case, from the switch to wherever that case's `then` sends the run.
 *
 * Without these a switch is indistinguishable from any other task on the canvas: its cases live
 * only in `node.data.cases`, while the only edges a scope persists are the plain "next sibling"
 * chain — so back-to-back switches rendered as a straight column, with nothing showing which task
 * each case actually jumps to. These are display-only (tagged synthetic, so
 * `decomposeDisplayedScope` never writes them back): the DSL's `then` remains the single source of
 * truth, edited in the node panel, never by dragging an edge.
 *
 * Note the plain chain edges are kept *as well* — a jumped-to task still falls through to the next
 * sibling once it finishes, so those arrows are real flow, not an artifact. The one case where they
 * lie is handled in `computeHiddenRealEdgeIds`.
 */
export function computeSwitchCaseEdges(nodes: Node[], edges: Edge[]): Edge[] {
	const ownerOf = buildOwnerMap(nodes);
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const endNodeId = nodes.find((n) => n.type === 'end')?.id;
	const caseEdges: Edge[] = [];

	for (const node of nodes) {
		if (node.type !== 'switch') continue;
		const cases = switchCasesOf(node);
		if (cases.length === 0) continue;

		const switchScopeId = ownerOf.get(node.id);
		const fallThroughId = fallThroughTargetOf(node.id, edges);
		let drawn = 0;

		cases.forEach((c, i) => {
			const targetId = switchCaseTargetId(
				c.then,
				switchScopeId,
				ownerOf,
				byId,
				fallThroughId,
				endNodeId
			);
			// A self-targeting case would render as a degenerate loop on top of the node; the `then`
			// picker can't produce one, but hand-written DSL can.
			if (!targetId || targetId === node.id) return;

			const name = c.name || `case ${i + 1}`;
			// Flow directives aren't visible from the target alone (`end` and a case that happens to
			// jump to the last task look identical), so they're spelled out next to the case name.
			const isDirective = c.then === 'continue' || c.then === 'exit' || c.then === 'end';
			caseEdges.push({
				id: `switch-case-${node.id}-${i}`,
				source: node.id,
				target: targetId,
				type: SWITCH_CASE_EDGE_TYPE,
				label: isDirective && name !== c.then ? `${name} · ${c.then}` : name,
				data: {
					[SYNTHETIC_SCOPE_EDGE_TAG]: true,
					kind: 'switchCase',
					bow: CASE_BOW_BASE + drawn * CASE_BOW_STEP
				},
				style: `stroke:${SWITCH_CASE_COLOR};stroke-width:1.5;stroke-dasharray:5 4;`,
				labelStyle: `color:${SWITCH_CASE_COLOR};font-size:10px;font-weight:600;background:var(--color-base-100);border:1px solid ${SWITCH_CASE_COLOR}55;border-radius:9999px;padding:1px 6px;white-space:nowrap;`,
				deletable: false,
				selectable: false
			});
			drawn++;
		});
	}

	return caseEdges;
}

/**
 * Ids of real (persisted) edges that `computeLiveSyntheticEdges` has visually replaced with a
 * relocated continuation edge — currently only ever fires for `try` (see `analyzeContainerNodes`).
 * These must be rendered `hidden: true` rather than removed outright, since the real edge (`try ->
 * next`) still has to survive in `scopes` for DSL ordering to stay correct; only its on-canvas
 * presentation is superseded.
 *
 * Known limitation: because the visible replacement is a non-reconnectable synthetic edge (see
 * `ReconnectableEdge.svelte`), there's currently no drag-to-reconnect way to change "what runs
 * after this try/catch" from the canvas — use the DSL editor for that instead.
 *
 * Also hides a `switch`'s fall-through edge in the one case it can't fire (see
 * `switchNeverFallsThrough`) — there the case edges from `computeSwitchCaseEdges` are the whole
 * truth, and leaving the straight chain arrow up reads as "this switch continues to the next task"
 * when it never does.
 */
export function computeHiddenRealEdgeIds(nodes: Node[], edges: Edge[]): Set<string> {
	const ids = new Set<string>();
	for (const a of analyzeContainerNodes(nodes, edges)) {
		if (a.continuationSourceId && a.mainContinuationEdge) ids.add(a.mainContinuationEdge.id);
	}
	for (const node of nodes) {
		if (node.type !== 'switch' || !switchNeverFallsThrough(switchCasesOf(node))) continue;
		const fallThrough = edges.find((e) => e.source === node.id && !isSyntheticEdge(e));
		if (fallThrough) ids.add(fallThrough.id);
	}
	return ids;
}

/**
 * True when every run through this switch is guaranteed to leave via one of its own cases, so the
 * plain "next sibling" chain edge is unreachable: it needs an unconditional (default) case — one
 * with no `when`, which always matches if nothing before it did — and no case whose `then` is
 * `continue`, since that directive *is* the fall-through and gets its own labeled edge to the same
 * target. A switch whose cases are all conditional keeps its chain edge, because with nothing
 * matching the run really does carry on to the next task.
 */
function switchNeverFallsThrough(cases: CaseEntry[]): boolean {
	if (cases.length === 0) return false;
	const hasDefault = cases.some((c) => !c.condition?.trim());
	const hasContinue = cases.some((c) => c.then === 'continue');
	return hasDefault && !hasContinue;
}

/**
 * Computes bounding boxes for every inline lane directly from the *currently displayed* `nodes`
 * array's actual positions — no scope lookup, no re-layout. Returns one flat map keyed by the
 * lane's own scope key (already globally unique across the whole workflow, at any nesting depth),
 * so it covers `for`'s single lane, `try`'s two, and `fork`'s N branches uniformly. Falls back to a
 * placeholder box positioned relative to the owning node when a lane has no nodes in it yet (so the
 * very first node dropped into an empty lane still has something to hit-test against).
 */
export function computeLiveLaneBounds(nodes: Node[]): Map<string, LaneBounds> {
	const ownerOf = buildOwnerMap(nodes);
	const laneBounds = new Map<string, LaneBounds>();

	for (const n of nodes) {
		const parentScopeId = ownerOf.get(n.id);
		if (!parentScopeId) continue;
		const specs = laneSpecsFor(n, parentScopeId);
		if (specs.length === 0) continue;

		specs.forEach((spec, i) => {
			const laneNodes = nodes.filter((ln) => ownerOf.get(ln.id) === spec.key);
			laneBounds.set(
				spec.key,
				laneBoundsFromNodes(
					laneNodes,
					n.position.x + INLINE_LANE_OFFSET_X * (i + 1),
					n.position.y + ROW_HEIGHT
				)
			);
		});
	}

	return laneBounds;
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
 * For a container node (`for`/`do`/`try`/`fork`) about to be deleted, recursively collects every
 * descendant scope key reachable from it — a lane's own tagged member nodes can themselves own
 * further lanes (a fork branch containing a nested for-loop, etc.), so callers can prune every one
 * of them from `scopes`, not just the immediate lane(s). `nodes` is the live displayed array, used
 * to find each lane's current members via `OWNER_SCOPE_TAG`.
 */
export function collectDescendantScopeKeysForNode(
	node: Node,
	ownerScopeId: string,
	nodes: Node[]
): string[] {
	return laneSpecsFor(node, ownerScopeId).flatMap((spec) =>
		collectDescendantScopeKeysForLaneKey(spec.key, nodes)
	);
}

/**
 * Same as `collectDescendantScopeKeysForNode`, but starting from a single lane's scope key directly
 * — used when removing one `fork` branch (not the whole fork node), so only that branch's own
 * descendants get pruned, not its sibling branches'.
 */
export function collectDescendantScopeKeysForLaneKey(laneKey: string, nodes: Node[]): string[] {
	const keys: string[] = [laneKey];
	for (const child of nodes.filter((n) => ownerTag(n) === laneKey)) {
		keys.push(...collectDescendantScopeKeysForNode(child, laneKey, nodes));
	}
	return keys;
}

interface CollectResult {
	/** This scope's own top-level chain (not recursed into) — what `layoutScopeRecursive` positions directly. */
	mainNodes: Node[];
	mainEdges: Edge[];
	/** Fully flattened, recursively-tagged nodes/edges — this scope's own plus every descendant lane's. */
	allNodes: Node[];
	allEdges: Edge[];
	laneMap: LaneMap;
}

/**
 * Recursively flattens a scope for display: its own nodes/edges, plus — for every container node
 * directly in it (`for`/bare-`do`/`try`/`fork`) — that node's lane scope(s) inlined as tagged
 * siblings, which are themselves recursed into (a fork branch containing a nested for-loop shows
 * that for-loop's body inline too, to arbitrary depth). A scope with no container nodes passes
 * through unchanged (every node tagged with the scope's own id, empty lane map).
 *
 * Does not read or write `scopes` outside the lookups made in this one recursive walk — safe to
 * call from anywhere, including reactive contexts, without risking the "effect reads and writes the
 * same state" infinite-loop trap documented in the Svelte layer.
 */
function collectInline(scopes: Record<string, ScopeGraph>, scopeId: string): CollectResult {
	const base = scopes[scopeId] ?? { nodes: [], edges: [] };
	const mainNodes = base.nodes.map((n) => tagNode(n, scopeId));
	const mainEdges = [...base.edges];
	const laneMap: LaneMap = new Map();
	const allNodes: Node[] = [...mainNodes];
	const allEdges: Edge[] = [...mainEdges];

	for (const n of mainNodes) {
		const specs = laneSpecsFor(n, scopeId);
		if (specs.length === 0) continue;

		const lanes: ScopeLane[] = [];
		for (const spec of specs) {
			const child = collectInline(scopes, spec.key);
			lanes.push({
				key: spec.key,
				nodes: child.mainNodes,
				edges: child.mainEdges,
				laneMap: child.laneMap
			});
			allNodes.push(...child.allNodes);
			allEdges.push(...child.allEdges);
		}
		laneMap.set(n.id, lanes);
	}

	return { mainNodes, mainEdges, allNodes, allEdges, laneMap };
}

export function composeScopeForDisplay(
	scopes: Record<string, ScopeGraph>,
	scopeId: string
): ComposedScope {
	const {
		mainNodes,
		mainEdges,
		allNodes,
		allEdges: allRealEdges,
		laneMap
	} = collectInline(scopes, scopeId);

	const laneBounds = layoutScopeRecursive(mainNodes, mainEdges, laneMap);

	const hiddenIds = computeHiddenRealEdgeIds(allNodes, allRealEdges);
	const displayRealEdges = allRealEdges.map((e) =>
		hiddenIds.has(e.id) ? { ...e, hidden: true } : e
	);
	const laneSynthetic = computeLiveSyntheticEdges(allNodes, allRealEdges);
	const switchSynthetic = computeSwitchCaseEdges(allNodes, allRealEdges);
	const terminalSynthetic = computeTerminalEdges(allNodes, [
		...displayRealEdges,
		...laneSynthetic,
		...switchSynthetic
	]);

	return {
		nodes: allNodes,
		edges: [...displayRealEdges, ...laneSynthetic, ...switchSynthetic, ...terminalSynthetic],
		laneBounds
	};
}

/**
 * Inverse of `composeScopeForDisplay` — splits a displayed (possibly deeply-flattened) node/edge
 * list back into a partial `scopes` map, one entry per distinct owner scope actually present, at
 * any nesting depth (grouping is purely by `OWNER_SCOPE_TAG` string equality, with no assumption
 * about *why* a node has a given tag, so this needs no change as nesting gets deeper). Always merge
 * (spread) the result over the existing `scopes`, never replace it wholesale — this returns only
 * the scopes touched by what's currently displayed, and a naive replace would silently drop every
 * other scope not in view (e.g. a sibling `for` loop's body).
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
		if ((e.data as Record<string, unknown> | undefined)?.[SYNTHETIC_SCOPE_EDGE_TAG]) continue;
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
