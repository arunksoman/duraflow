import type { Node, Edge } from '@xyflow/svelte';
import type { ScopeGraph } from './graph';
import {
	ROOT_SCOPE_ID,
	forScopeKey,
	tryScopeKey,
	catchScopeKey,
	forkBranchScopeKey,
	flowScopeOf,
	isWorkflowScopeKey
} from './scopeKey';
import type { BranchEntry, CaseEntry } from '../components/builder/builderConfig';
import { isDirectiveRouting, switchCasesOf } from './switchCases';
import {
	layoutFlows,
	orderNodesInScope,
	NODE_CARD_WIDTH,
	INLINE_LANE_OFFSET_X,
	LANE_CAP_GAP,
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

/** `edge.type` for a switch case's edge — resolves to `SwitchCaseEdge.svelte` via `edgeTypes`. */
export const SWITCH_CASE_EDGE_TYPE = 'switchCase';

/**
 * Tags on a case edge's `data`, read by the builder to open the case editor when one is clicked and
 * to know which case to drop when one is deleted. Present on both kinds of case edge — the entry
 * edge into a branch lane, and the jump edge a directive/`task` case draws.
 */
export const SWITCH_NODE_TAG = 'switchNodeId';
export const SWITCH_CASE_TAG = 'switchCaseId';

/** Matches `NODE_META.switch.color`, so a case edge reads as belonging to the switch that owns it. */
const SWITCH_CASE_COLOR = '#06b6d4';

/**
 * How far left of the main column a case edge bows, and how much each further case of the same
 * switch adds — nesting the bows keeps sibling cases from overdrawing one another.
 */
const CASE_BOW_BASE = 72;
const CASE_BOW_STEP = 48;

export interface ComposedScope {
	nodes: Node[];
	edges: Edge[];
	/** Bounding box per lane, keyed by the lane's own scope key (already globally unique). */
	laneBounds: Map<string, LaneBounds>;
	/** The same lanes as drawable, titled frames — see `LaneBox`. */
	laneBoxes: Map<string, LaneBox>;
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
 * One inline lane a container node (`for`/bare-`do`, `try`, `fork`, a branch-mode `switch`) needs
 * on the canvas, and the real scope key backing it.
 *
 * Two flags change how the owning node's *continuation* (what runs after it) is drawn, and at most
 * one of them is ever set on a given node's lanes:
 *
 * - `redirectContinuation` — try's first lane only: the continuation is re-sourced from the end of
 *   that one lane, because a try that doesn't throw carries straight on from its own body.
 * - `convergeContinuation` — every lane of a branch-mode switch: each lane gets its own edge to
 *   the continuation, because exactly one branch runs and then they all rejoin. This is what makes
 *   a switch draw as a diamond instead of a chain.
 */
interface LaneSpec {
	key: string;
	/** What the edge into this lane says. */
	label: string;
	/**
	 * What the lane's box on the canvas is called — the name the DSL knows this group of tasks by
	 * (`processElectronicOrder`, a fork branch's name, `try`/`catch`). Separate from `label` because
	 * a switch case's edge carries its condition while its box carries the task name.
	 */
	title: string;
	redirectContinuation?: boolean;
}

/**
 * Single data-driven table replacing what used to be three separate `if (n.type !== 'try')
 * continue` guards. Re-derives fresh from `node.data.branches` / `node.data.cases` every call, so
 * a fork branch or switch case added/removed needs no special-casing anywhere else — every
 * consumer just calls this again.
 */
function laneSpecsFor(node: Node, parentScopeId: string): LaneSpec[] {
	switch (node.type) {
		case 'for':
		case 'do':
			return [
				{
					key: forScopeKey(parentScopeId, node.id),
					label: 'body',
					// A bare `do` *is* its group: the DSL knows those tasks by the task's own name, so
					// that is what the box is called. A `for`'s body is one iteration of it.
					title: node.type === 'do' ? nodeLabel(node) : `${nodeLabel(node)} body`
				}
			];
		case 'try':
			return [
				{
					key: tryScopeKey(parentScopeId, node.id),
					label: 'try',
					title: `${nodeLabel(node)} try`,
					redirectContinuation: true
				},
				{
					key: catchScopeKey(parentScopeId, node.id),
					label: 'catch',
					title: `${nodeLabel(node)} catch`
				}
			];
		case 'fork': {
			const branches = (node.data?.branches as BranchEntry[] | undefined) ?? [];
			return branches.map((b) => ({
				key: forkBranchScopeKey(parentScopeId, node.id, b.id),
				label: b.name || 'branch',
				title: b.name || 'branch'
			}));
		}
		default:
			return [];
	}
}

function nodeLabel(node: Node): string {
	return ((node.data as Record<string, unknown> | undefined)?.label as string) || node.type || '';
}

function laneEntryEdge(
	sourceId: string,
	targetId: string,
	ownerNodeId: string,
	spec: LaneSpec
): Edge {
	return {
		id: `lane-entry-${spec.key}`,
		source: sourceId,
		target: targetId,
		type: 'default',
		label: spec.label,
		// Without an explicit style xyflow's HTML edge label falls back to its own white pill, which
		// reads as a blank white box on the dark theme (fork branch names were invisible).
		labelStyle: LANE_LABEL_STYLE,
		// `deletable`/`selectable: false` are real Edge fields xyflow itself enforces (delete-key
		// and click-select both no-op). There's no `reconnectable` field on this version's Edge
		// type — reconnect-drag is instead blocked by `ReconnectableEdge.svelte` checking this same
		// `syntheticScopeEdge` tag and skipping its `EdgeReconnectAnchor`s for tagged edges.
		data: {
			[SYNTHETIC_SCOPE_EDGE_TAG]: true,
			ownerNodeId,
			laneKey: spec.key,
			kind: 'entry'
		},
		deletable: false,
		selectable: false
	};
}

const LANE_LABEL_STYLE =
	'color:var(--color-base-content);font-size:10px;font-weight:500;background:var(--color-base-100);border:1px solid var(--color-base-300);border-radius:9999px;padding:1px 6px;white-space:nowrap;';

/** Shared presentation for a case's jump edge, so every case of a switch reads as one family. */
function caseEdgeStyling(): Partial<Edge> {
	return {
		style: `stroke:${SWITCH_CASE_COLOR};stroke-width:1.5;`,
		labelStyle: `color:${SWITCH_CASE_COLOR};font-size:10px;font-weight:600;background:var(--color-base-100);border:1px solid ${SWITCH_CASE_COLOR}55;border-radius:9999px;padding:1px 6px;white-space:nowrap;cursor:pointer;`
	};
}

/** How long a condition may be before the edge label truncates it. */
const CASE_LABEL_CONDITION_MAX = 16;

/** Same problem for the bowed jump edges, solved by walking each one's label further back. */
const JUMP_LABEL_T_BASE = 0.78;
const JUMP_LABEL_T_STEP = 0.19;

/**
 * What a case edge says: the case's name, plus its condition when it has one — the condition is the
 * thing a reader is actually trying to follow, and a diagram where every branch is labeled only
 * `case1`/`case2` explains nothing. A blank condition is the "otherwise" case and says so by
 * carrying just the name.
 */
export function caseEdgeLabel(c: CaseEntry, index: number): string {
	const name = c.name || `case ${index + 1}`;
	const condition = shortCondition(c);
	return condition ? `${name} · ${condition}` : name;
}

function shortCondition(c: CaseEntry): string {
	const condition = (c.condition ?? '').trim();
	if (!condition) return '';
	return condition.length > CASE_LABEL_CONDITION_MAX
		? `${condition.slice(0, CASE_LABEL_CONDITION_MAX - 1)}…`
		: condition;
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
 * lane's ordering and how the node's continuation should be drawn:
 *
 * - default (`for`/`do`/`fork`) — untouched. These are genuine pass-throughs/fan-outs: the
 *   real chain edge out of the node already says what happens next.
 * - `redirectContinuation` (try's first lane) — re-sourced from the end of that lane, superseding
 *   the real chain edge, which `computeHiddenRealEdgeIds` then hides.
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
 * Computes every inline lane's entry edge (e.g. "body", "try", "catch", a fork branch's real
 * `name`, or a switch case's) plus the relocated/converging continuation edges — directly from the
 * *currently displayed* `nodes`/`edges` (via their `__ownerScopeId` tags) rather than a one-off
 * scope lookup, so this can be recomputed as a plain reactive `$derived`/effect input off
 * `nodes`/`edges` in the Svelte layer (a node dropped into a lane after the initial load still gets
 * an edge pointing at it, and a fork branch or switch case added/removed at runtime is reflected
 * with no extra bookkeeping).
 */
export function computeLiveSyntheticEdges(nodes: Node[], edges: Edge[]): Edge[] {
	const synthesized: Edge[] = [];
	for (const a of analyzeContainerNodes(nodes, edges)) {
		a.lanes.forEach((lane, i) => {
			if (lane.first) {
				synthesized.push(laneEntryEdge(a.entrySources[i], lane.first.id, a.node.id, lane.spec));
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
 * gets a synthetic edge pointing at the `end` node of the workflow it belongs to, so no path on
 * the canvas trails off looking open-ended (matching the same "always show where a path
 * terminates" convention `start`/`end` already establish for the main chain). Purely visual:
 * tagged synthetic, never persisted.
 *
 * Each workflow runs to its *own* End: a named workflow's dead ends go to its End, never to the
 * primary workflow's, since that would draw a handover that does not happen.
 *
 * `edges` must already include every other synthetic edge (`computeLiveSyntheticEdges`'s output),
 * or a node whose only "outgoing" connection is itself synthetic (e.g. try's redirected
 * continuation source) would be wrongly treated as a dead end.
 */
export function computeTerminalEdges(nodes: Node[], edges: Edge[]): Edge[] {
	const hasOutgoing = new Set(edges.map((e) => e.source));
	const ownerOf = buildOwnerMap(nodes);
	const endOf = flowEndNodes(nodes, ownerOf);

	const terminal: Edge[] = [];
	for (const n of nodes) {
		if (n.type === 'end' || hasOutgoing.has(n.id)) continue;
		const endId = endOf.get(flowOfNode(n, ownerOf));
		if (endId) terminal.push(terminalEdge(n.id, endId));
	}
	return terminal;
}

/** The top-level flow a displayed node belongs to — the primary workflow when it is untagged. */
function flowOfNode(n: Node, ownerOf: Map<string, string>): string {
	return flowScopeOf(ownerOf.get(n.id) ?? ROOT_SCOPE_ID);
}

/** Each top-level flow's `end` node id, keyed by the flow's scope (see `flowScopeOf`). */
function flowEndNodes(nodes: Node[], ownerOf: Map<string, string>): Map<string, string> {
	const endOf = new Map<string, string>();
	for (const n of nodes) {
		if (n.type === 'end') endOf.set(flowOfNode(n, ownerOf), n.id);
	}
	return endOf;
}

/** Each named workflow's Start node, keyed by id — what a switch case's `then:` can start. */
function namedStarts(nodes: Node[], ownerOf: Map<string, string>): Set<string> {
	const ids = new Set<string>();
	for (const n of nodes) {
		const owner = ownerOf.get(n.id);
		if (n.type === 'start' && owner && isWorkflowScopeKey(owner)) ids.add(n.id);
	}
	return ids;
}

function isSyntheticEdge(edge: Edge): boolean {
	return Boolean((edge.data as Record<string, unknown> | undefined)?.[SYNTHETIC_SCOPE_EDGE_TAG]);
}

/** The real (persisted) "and then the next sibling runs" edge leaving a node, if there is one. */
function fallThroughTargetOf(nodeId: string, edges: Edge[]): string | undefined {
	return edges.find((e) => e.source === nodeId && !isSyntheticEdge(e))?.target;
}

/**
 * Where a case sends the run, as a node id on the composed canvas:
 *
 * - `continue` — the switch's own fall-through target (the next sibling task).
 * - `exit` / `end` — both stop the path being drawn. They differ in the DSL (leave the current
 *   task list vs. terminate the workflow) but each workflow has exactly one `end` node, so both
 *   point at the End of the workflow the switch is in rather than inventing a terminator per
 *   nesting level.
 * - `task` — the named workflow the case starts as a child workflow (zigflow runs every named
 *   `then:` that way, wherever the switch and the workflow are declared). A sibling task in the
 *   switch's own list is also drawn, for hand-written DSL that names one; anything else draws
 *   nothing rather than a wrong arrow.
 */
function caseJumpTargetId(
	c: CaseEntry,
	switchScopeId: string | undefined,
	ownerOf: Map<string, string>,
	starts: Set<string>,
	fallThroughId: string | undefined,
	endNodeId: string | undefined
): string | undefined {
	if (c.routing === 'continue') return fallThroughId ?? endNodeId;
	if (c.routing === 'exit' || c.routing === 'end') return endNodeId;
	const targetId = c.targetNodeId;
	if (!targetId) return undefined;
	if (starts.has(targetId)) return targetId;
	return ownerOf.get(targetId) === switchScopeId ? targetId : undefined;
}

/**
 * One labeled edge per case that owns no branch lane — a flow directive, or a raw jump at a sibling
 * task this engine couldn't safely lift into a lane (see `planSwitchCases`). Branch cases don't
 * come through here: their edge is the lane entry edge, drawn by `computeLiveSyntheticEdges`.
 *
 * Display-only (tagged synthetic, so `decomposeDisplayedScope` never writes them back): the case
 * list on the switch node stays the single source of truth, edited by clicking the edge or from the
 * node panel. They carry the same `switchNodeId`/`switchCaseId` tags a lane entry edge does, so the
 * builder handles a click or a delete on either one identically.
 */
export function computeSwitchCaseEdges(nodes: Node[], edges: Edge[]): Edge[] {
	const ownerOf = buildOwnerMap(nodes);
	const starts = namedStarts(nodes, ownerOf);
	const endOf = flowEndNodes(nodes, ownerOf);
	const caseEdges: Edge[] = [];

	for (const node of nodes) {
		if (node.type !== 'switch') continue;
		const switchScopeId = ownerOf.get(node.id);
		const fallThroughId = fallThroughTargetOf(node.id, edges);
		const endNodeId = endOf.get(flowOfNode(node, ownerOf));
		let drawn = 0;

		switchCasesOf(node).forEach((c, i) => {
			const targetId = caseJumpTargetId(
				c,
				switchScopeId,
				ownerOf,
				starts,
				fallThroughId,
				endNodeId
			);
			// A self-targeting case would render as a degenerate loop on top of the node; the case
			// editor can't produce one, but hand-written DSL can.
			if (!targetId || targetId === node.id) return;

			// The directive isn't visible from the target alone (`end` and a case that happens to jump
			// to the last task look identical), so it's spelled out next to the case name — unless the
			// case is named after it already, which would just read `end · end`.
			const label = caseEdgeLabel(c, i);
			const spellOut = isDirectiveRouting(c.routing) && c.name !== c.routing;
			caseEdges.push({
				id: `switch-case-${node.id}-${c.id}`,
				source: node.id,
				target: targetId,
				type: SWITCH_CASE_EDGE_TYPE,
				label: spellOut ? `${label} · ${c.routing}` : label,
				data: {
					[SYNTHETIC_SCOPE_EDGE_TAG]: true,
					kind: 'switchCase',
					[SWITCH_NODE_TAG]: node.id,
					[SWITCH_CASE_TAG]: c.id,
					bow: CASE_BOW_BASE + drawn * CASE_BOW_STEP,
					labelT: Math.max(0.15, JUMP_LABEL_T_BASE - drawn * JUMP_LABEL_T_STEP)
				},
				...caseEdgeStyling(),
				style: `stroke:${SWITCH_CASE_COLOR};stroke-width:1.5;stroke-dasharray:5 4;`,
				deletable: true,
				selectable: true
			});
			drawn++;
		});
	}

	return caseEdges;
}

/**
 * Ids of real (persisted) edges that `computeLiveSyntheticEdges` has visually replaced — currently
 * only `try`'s relocated continuation. Rendered `hidden: true` rather than removed outright, since
 * the real edge still has to survive in `scopes` for DSL ordering to stay correct; only its
 * on-canvas presentation is superseded.
 *
 * Nothing is hidden for a `switch`: its chain edge is real flow (a case that falls through runs the
 * next sibling), and hiding it would strand the following task with no visible way in.
 *
 * Known limitation: because the visible replacement is a non-reconnectable synthetic edge (see
 * `ReconnectableEdge.svelte`), there's currently no drag-to-reconnect way to change "what runs
 * after this try/catch" from the canvas — use the DSL editor for that instead.
 */
export function computeHiddenRealEdgeIds(nodes: Node[], edges: Edge[]): Set<string> {
	const ids = new Set<string>();
	for (const a of analyzeContainerNodes(nodes, edges)) {
		if (a.continuationSourceId && a.mainContinuationEdge) ids.add(a.mainContinuationEdge.id);
	}
	return ids;
}

/**
 * One inline lane's box on the canvas: where it is, and what the DSL calls the group of tasks in
 * it. Drawn as a titled dotted frame (`LaneBoxLayer.svelte`) so a nested body reads as the
 * self-contained sub-flow the DSL says it is, rather than as a loose column of cards.
 */
export interface LaneBox extends LaneBounds {
	key: string;
	title: string;
	/** The node the lane belongs to, so clicking the box's title can open its config. */
	ownerNodeId: string;
	caps: LaneCaps;
}

/**
 * Where a lane's start/end caps are drawn. The DSL gives every named group its own entry and exit
 * (`processElectronicOrder: do: [...]` runs from its first task to its last, then rejoins), and
 * without caps a framed lane is just a column of cards with no visible beginning — so each lane
 * gets an explicit start and end marker, connected to its chain by a short stub.
 *
 * All five numbers are flow coordinates of the lane's *own* column, captured before a frame is
 * grown to enclose its nested lanes — the caps belong to this lane's chain, not to the union.
 */
export interface LaneCaps {
	/** Centre of the lane's own column. */
	x: number;
	/** Centre of the start cap, and of the end cap. */
	startY: number;
	endY: number;
	/** Top of the lane's first node and bottom of its last — where the stubs meet the chain. */
	chainTop: number;
	chainBottom: number;
}

/**
 * Computes a box for every inline lane directly from the *currently displayed* `nodes` array's
 * actual positions — no scope lookup, no re-layout. Returns one flat map keyed by the lane's own
 * scope key (already globally unique across the whole workflow, at any nesting depth), so it covers
 * `for`'s single lane, `try`'s two, `fork`'s N branches and a `switch`'s branch lanes uniformly.
 * Falls back to a placeholder box positioned relative to the owning node when a lane has no nodes
 * in it yet (so the very first node dropped into an empty lane still has something to hit-test
 * against, and an empty branch still shows as an empty frame rather than vanishing).
 *
 * A lane's box also covers every lane nested inside it — a fork branch holding a for-loop draws
 * around that loop's body too — which is what makes nesting legible. Descendant lane keys are
 * always prefixed by their ancestor's (see `scopeKey.ts`), so the union needs no tree walk. The
 * caps are deliberately left out of that union: they mark where *this* lane's own chain begins and
 * ends, which a nested lane's extent has nothing to do with.
 */
export function computeLiveLaneBoxes(nodes: Node[]): Map<string, LaneBox> {
	const ownerOf = buildOwnerMap(nodes);
	const boxes = new Map<string, LaneBox>();

	for (const n of nodes) {
		const parentScopeId = ownerOf.get(n.id);
		if (!parentScopeId) continue;
		const specs = laneSpecsFor(n, parentScopeId);
		if (specs.length === 0) continue;

		specs.forEach((spec, i) => {
			const laneNodes = nodes.filter((ln) => ownerOf.get(ln.id) === spec.key);
			const own = laneBoundsFromNodes(
				laneNodes,
				n.position.x + INLINE_LANE_OFFSET_X * (i + 1),
				n.position.y + ROW_HEIGHT + LANE_CAP_GAP
			);
			const caps: LaneCaps = {
				x: own.x + NODE_CARD_WIDTH / 2,
				startY: own.yStart - LANE_CAP_GAP / 2,
				endY: own.yEnd + LANE_CAP_GAP / 2,
				chainTop: own.yStart,
				chainBottom: own.yEnd
			};
			boxes.set(spec.key, {
				...own,
				key: spec.key,
				title: spec.title,
				ownerNodeId: n.id,
				caps
			});
		});
	}

	for (const [key, box] of boxes) {
		for (const [otherKey, other] of boxes) {
			if (otherKey === key || !otherKey.startsWith(`${key}/`)) continue;
			box.x = Math.min(box.x, other.x);
			box.yStart = Math.min(box.yStart, other.yStart);
			box.yEnd = Math.max(box.yEnd, other.yEnd);
			box.width = Math.max(box.width, other.x + other.width - box.x);
		}
	}

	return boxes;
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

/**
 * Composes the canvas: the primary workflow rooted at `scopeId`, and — when that is the document
 * root — every named workflow the document declares, each as its own Start-to-End flow laid out to
 * the right of the one before. A named workflow is drawn exactly like the primary one; nothing
 * about it is boxed or nested, because it is not part of any other flow.
 */
export function composeScopeForDisplay(
	scopes: Record<string, ScopeGraph>,
	scopeId: string = ROOT_SCOPE_ID
): ComposedScope {
	const flowIds =
		scopeId === ROOT_SCOPE_ID
			? [ROOT_SCOPE_ID, ...Object.keys(scopes).filter(isWorkflowScopeKey)]
			: [scopeId];
	const flows = flowIds.map((id) => collectInline(scopes, id));

	const laneBounds = layoutFlows(
		flows.map((f) => ({ nodes: f.mainNodes, edges: f.mainEdges, laneMap: f.laneMap }))
	);

	const allNodes = flows.flatMap((f) => f.allNodes);
	const allRealEdges = flows.flatMap((f) => f.allEdges);

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
		laneBounds,
		laneBoxes: computeLiveLaneBoxes(allNodes)
	};
}

/**
 * The area each named workflow occupies on the canvas, from where its nodes actually are — used
 * only to decide which workflow a palette drop lands in (nothing is drawn for it). The primary
 * workflow needs no entry: a drop outside every named workflow belongs to it.
 */
export function computeFlowBounds(nodes: Node[]): Map<string, LaneBounds> {
	const ownerOf = buildOwnerMap(nodes);
	const members = new Map<string, Node[]>();
	for (const n of nodes) {
		const owner = ownerOf.get(n.id);
		if (!owner) continue;
		const flow = flowScopeOf(owner);
		if (flow === ROOT_SCOPE_ID) continue;
		const list = members.get(flow);
		if (list) list.push(n);
		else members.set(flow, [n]);
	}
	const bounds = new Map<string, LaneBounds>();
	for (const [flow, list] of members) {
		bounds.set(flow, laneBoundsFromNodes(list, 0, 0));
	}
	return bounds;
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
