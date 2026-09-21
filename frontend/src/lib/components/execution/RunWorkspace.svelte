<script lang="ts">
	import { untrack, type Snippet } from 'svelte';
	import {
		SvelteFlow,
		Controls,
		Background,
		MiniMap,
		BackgroundVariant,
		type Node,
		type Edge
	} from '@xyflow/svelte';
	import '@xyflow/svelte/dist/style.css';

	import WorkflowNode from '$lib/components/builder/WorkflowNode.svelte';
	import ReconnectableEdge from '$lib/components/builder/ReconnectableEdge.svelte';
	import SwitchCaseEdge from '$lib/components/builder/SwitchCaseEdge.svelte';
	import LaneBoxLayer from '$lib/components/builder/LaneBoxLayer.svelte';
	import { NODE_META, NODE_TYPES } from '$lib/components/builder/builderConfig';
	import { TriangleAlert } from '@lucide/svelte';
	import { RUN_TONE_VAR, runTone } from '$lib/components/builder/runStatus';
	import RunInspector, { type RunSelection } from './RunInspector.svelte';
	import type { RunSession } from '$lib/runtime/runSession.svelte';
	import type { RunIndex } from '$lib/zigflow-engine/runIndex';
	import type { ScopeGraph } from '$lib/zigflow-engine/graph';
	import type { NodeRunDetail, NodeRunState } from '$lib/zigflow-engine/runState';
	import {
		composeScopeForDisplay,
		OWNER_SCOPE_TAG,
		SWITCH_CASE_EDGE_TYPE,
		type LaneBox
	} from '$lib/zigflow-engine/inlineScopeView';
	import { ROOT_SCOPE_ID, flowScopeOf } from '$lib/zigflow-engine/scopeKey';
	import type { WorkflowNodeType } from '$lib/types';

	/**
	 * Everything about one run, laid out to be read side by side: the workflow coloured by what
	 * happened (left) and the selected node's input, output and variable changes (right). The
	 * canvas colours carry the path — there is no separate steps list. Shared by the builder's run window and the execution page, so a
	 * live run and a replayed one look identical.
	 *
	 * `scopes` and `index` must describe the DSL that was actually run — the caller freezes both
	 * when the run starts, so later canvas edits can't misattribute events.
	 */

	interface Props {
		session: RunSession;
		index: RunIndex;
		scopes: Record<string, ScopeGraph>;
		/** Rendered over the top of the canvas, e.g. a "canvas changed" notice. */
		canvasBanner?: Snippet;
	}

	let { session, index, scopes, canvasBanner }: Props = $props();

	const nodeTypes = Object.fromEntries(NODE_TYPES.map((t) => [t, WorkflowNode]));
	const edgeTypes = {
		default: ReconnectableEdge,
		[SWITCH_CASE_EDGE_TYPE]: SwitchCaseEdge
	};

	let selection = $state<RunSelection | null>(null);

	const composed = $derived(
		Object.keys(scopes).length > 0
			? composeScopeForDisplay(scopes, ROOT_SCOPE_ID)
			: { nodes: [] as Node[], edges: [] as Edge[], laneBoxes: new Map<string, LaneBox>() }
	);

	const labelById = $derived(
		new Map(
			composed.nodes.map((n) => {
				const type = n.type as WorkflowNodeType;
				const fallback = type in NODE_META ? NODE_META[type].label : (n.type ?? n.id);
				return [n.id, ((n.data?.label as string) || fallback) ?? n.id];
			})
		)
	);
	const labelOf = (nodeId: string) => labelById.get(nodeId) ?? nodeId;

	let nodes: Node[] = $state.raw([]);
	let edges: Edge[] = $state.raw([]);

	/** Each named workflow's steps, by its scope — what its Start/End fall back to (see below). */
	const namedFlowMembers = $derived.by(() => {
		const members: Record<string, string[]> = {};
		for (const n of composed.nodes) {
			const owner = (n.data as Record<string, unknown> | undefined)?.[OWNER_SCOPE_TAG] as
				string | undefined;
			if (!owner || n.type === 'start' || n.type === 'end') continue;
			const flow = flowScopeOf(owner);
			if (flow === ROOT_SCOPE_ID) continue;
			members[flow] = [...(members[flow] ?? []), n.id];
		}
		return members;
	});

	function flowOf(node: Node): string {
		const owner = (node.data as Record<string, unknown> | undefined)?.[OWNER_SCOPE_TAG] as
			string | undefined;
		return owner ? flowScopeOf(owner) : ROOT_SCOPE_ID;
	}

	/**
	 * A named workflow runs only when a switch case starts it, so its Start and End are coloured by
	 * whether *it* ran — not by the primary workflow's progress. The backend reports its own
	 * start/finish (`RunState.namedWorkflows`); runs recorded before it did fall back to "one of its
	 * steps ran".
	 */
	function namedFlowState(
		node: Node,
		flow: string,
		byNode: Record<string, NodeRunDetail>
	): NodeRunState | undefined {
		const reported = session.run.namedWorkflows?.[flow];
		const started =
			reported !== undefined ||
			(namedFlowMembers[flow] ?? []).some((id) => RAN.has(byNode[id]?.state));
		if (node.type === 'start') {
			if (started) return 'success';
			return session.run.finalized ? 'skipped' : undefined;
		}
		if (reported === 'completed') return 'success';
		if (!session.run.finalized) return undefined;
		return started && session.status === 'completed' ? 'success' : 'skipped';
	}

	/** Start/end emit no events of their own; they're "reached" when the run got that far. */
	function stateOf(node: Node, byNode: Record<string, NodeRunDetail>): NodeRunState | undefined {
		if (node.type === 'start' || node.type === 'end') {
			const flow = flowOf(node);
			if (flow !== ROOT_SCOPE_ID) return namedFlowState(node, flow, byNode);
		}
		if (node.type === 'start') {
			return session.status === 'idle' || session.status === 'starting' ? undefined : 'success';
		}
		if (node.type === 'end') {
			// The root workflow's own completion event is enough: it arrives before the server's
			// terminal status, and is right even if that status is stale.
			if (session.status === 'completed' || session.run.workflowCompleted) return 'success';
			return session.run.finalized ? 'skipped' : undefined;
		}
		return byNode[node.id]?.state;
	}

	function projectNodes(current: Node[], selectedId: string | null): Node[] {
		const byNode = session.run.byNode;
		let changed = false;
		const next = current.map((node) => {
			const detail = byNode[node.id];
			const data = node.data as Record<string, unknown>;
			const runState = stateOf(node, byNode);
			const runAttempts = detail?.history.length ?? 0;
			const childExecutionId = detail?.childExecutionId;
			const selected = node.id === selectedId;
			if (
				data.runState === runState &&
				data.runAttempts === runAttempts &&
				data.childExecutionId === childExecutionId &&
				Boolean(node.selected) === selected
			) {
				return node;
			}
			changed = true;
			return { ...node, selected, data: { ...data, runState, runAttempts, childExecutionId } };
		});
		return changed ? next : current;
	}

	const RAN: ReadonlySet<NodeRunState | undefined> = new Set([
		'success',
		'error',
		'running',
		'unknown'
	]);

	/** Colours the edges the run actually travelled: both ends ran (start/end included). */
	function projectEdges(current: Edge[], nodeList: Node[]): Edge[] {
		const stateById = new Map(
			nodeList.map((n) => [n.id, n.data?.runState as NodeRunState | undefined])
		);
		const typeById = new Map(nodeList.map((n) => [n.id, n.type]));
		let changed = false;
		const next = current.map((edge) => {
			const target = stateById.get(edge.target);
			let travelled = RAN.has(stateById.get(edge.source)) && RAN.has(target);
			// A case edge is only "travelled" when it started the named workflow it points at: that
			// workflow ran, so this case was taken. A directive case (continue/exit/end) can't be told
			// apart from the switch simply falling through — its target running proves nothing, so it
			// stays unlit rather than lighting every case at once.
			if ((edge.data as Record<string, unknown> | undefined)?.kind === 'switchCase') {
				travelled = travelled && typeById.get(edge.target) === 'start';
			}
			// In-progress edges are blue dashes that turn solid green (or red) once the target settles.
			const style = travelled
				? `stroke: ${RUN_TONE_VAR[runTone(target)]}; stroke-width: 3;`
				: undefined;
			const animated = travelled && target === 'running';
			if (edge.style === style && Boolean(edge.animated) === animated) return edge;
			changed = true;
			return { ...edge, style, animated };
		});
		return changed ? next : current;
	}

	// A new run can carry a different graph (the design changed between runs): rebuild from it.
	$effect.pre(() => {
		const base = composed.nodes.map((n) => ({
			...n,
			draggable: false,
			deletable: false,
			// Hides the node's hover delete button — this canvas only shows a run.
			data: { ...n.data, readOnly: true }
		}));
		untrack(() => {
			nodes = projectNodes(base, selection?.nodeId ?? null);
			edges = projectEdges(
				composed.edges.map((e) => ({ ...e, deletable: false, selectable: false })),
				nodes
			);
		});
	});

	// Re-project as events arrive or the selection moves. `nodes`/`edges` are written here, so
	// they're read untracked — tracking them would re-trigger this effect on its own write.
	$effect(() => {
		void session.run;
		void session.status;
		const selectedId = selection?.nodeId ?? null;
		untrack(() => {
			nodes = projectNodes(nodes, selectedId);
			edges = projectEdges(edges, nodes);
		});
	});

	function selectNode(nodeId: string) {
		const history = session.run.byNode[nodeId]?.history ?? [];
		selection = { nodeId, attemptIndex: Math.max(0, history.length - 1) };
	}
</script>

<div class="flex h-full min-h-0">
	<div class="bg-base-200 relative min-w-0 flex-1">
		{@render canvasBanner?.()}
		{#if session.run.unmatched.length > 0 || index.ambiguousScopes.size > 0}
			<div
				class="alert alert-warning absolute bottom-2 left-1/2 z-10 w-auto max-w-[80%] -translate-x-1/2 gap-1.5 px-2 py-1.5 text-[11px] shadow"
			>
				<TriangleAlert size={12} class="shrink-0" />
				<span>
					{#if session.run.unmatched.length > 0}
						{session.run.unmatched.length} event(s) matched no node ({[
							...new Set(session.run.unmatched.map((u) => u.taskName))
						]
							.slice(0, 3)
							.join(', ')}).
					{/if}
					{#if index.ambiguousScopes.size > 0}
						Sibling loops/try blocks in one scope can't be told apart — highlighting there may be
						approximate.
					{/if}
				</span>
			</div>
		{/if}
		{#if nodes.length > 0}
			{#key composed}
				<SvelteFlow
					bind:nodes
					bind:edges
					{nodeTypes}
					{edgeTypes}
					nodesDraggable={false}
					nodesConnectable={false}
					elementsSelectable={false}
					deleteKey={null}
					fitView
					fitViewOptions={{ maxZoom: 1.1 }}
					style="width: 100%; height: 100%;"
					onnodeclick={({ node }) => selectNode(node.id)}
					onpaneclick={() => (selection = null)}
				>
					<LaneBoxLayer boxes={[...composed.laneBoxes.values()]} />
					<Background variant={BackgroundVariant.Dots} gap={20} size={1.2} />
					<Controls showLock={false} />
					<MiniMap zoomable pannable />
				</SvelteFlow>
			{/key}
		{:else}
			<div
				class="text-base-content/50 flex h-full items-center justify-center p-6 text-center text-sm"
			>
				No canvas for this run — its workflow couldn't be drawn. Workflow input and output are still
				available on the right.
			</div>
		{/if}
	</div>

	<aside class="border-base-300 bg-base-100 flex w-104 shrink-0 flex-col border-l">
		<RunInspector {session} {selection} {labelOf} onselect={(s) => (selection = s)} />
	</aside>
</div>
