<script lang="ts">
	import { untrack } from 'svelte';
	import {
		SvelteFlow,
		Controls,
		Background,
		MiniMap,
		BackgroundVariant,
		type Node,
		type Edge,
		type Connection
	} from '@xyflow/svelte';
	import '@xyflow/svelte/dist/style.css';

	import { page } from '$app/state';
	import { ArrowLeft, CircleCheck, Code2, Save, SlidersHorizontal, Workflow } from '@lucide/svelte';
	import ThemeToggle from '$lib/components/ThemeToggle.svelte';

	import WorkflowNode from '$lib/components/builder/WorkflowNode.svelte';
	import ReconnectableEdge from '$lib/components/builder/ReconnectableEdge.svelte';
	import NodePalette from '$lib/components/builder/NodePalette.svelte';
	import FlowInterop from '$lib/components/builder/FlowInterop.svelte';
	import NodePanel from '$lib/components/builder/NodePanel.svelte';
	import WorkflowVariablesModal from '$lib/components/builder/WorkflowVariablesModal.svelte';
	import CodeMirrorEditor from '$lib/components/editor/CodeMirrorEditor.svelte';
	import { NODE_META, NODE_TYPES } from '$lib/components/builder/builderConfig';
	import { astToGraph, graphToAst, type ScopeGraph } from '$lib/zigflow-engine/graph';
	import { serializeZigflowDocument } from '$lib/zigflow-engine/serialize';
	import {
		deserializeZigflowDocument,
		type DeserializeError
	} from '$lib/zigflow-engine/deserialize';
	import { ROOT_SCOPE_ID, forkBranchScopeKey } from '$lib/zigflow-engine/scopeKey';
	import {
		composeScopeForDisplay,
		decomposeDisplayedScope,
		computeLiveLaneBounds,
		computeLiveSyntheticEdges,
		computeHiddenRealEdgeIds,
		computeTerminalEdges,
		collectDescendantScopeKeysForNode,
		collectDescendantScopeKeysForLaneKey,
		OWNER_SCOPE_TAG
	} from '$lib/zigflow-engine/inlineScopeView';
	import type { Diagnostic } from '@codemirror/lint';
	import type { WorkflowNodeType, WorkflowMeta } from '$lib/types';

	const projectId = $derived(page.params.projectId);
	const workflowId = $derived(page.params.workflowId);
	const projectName = $derived(projectId === 'demo' ? 'Demo Project' : 'Project');
	const workflowName = $derived(workflowId === 'demo' ? 'Order Fulfillment' : 'New Workflow');

	const nodeTypes = Object.fromEntries(NODE_TYPES.map((t) => [t, WorkflowNode]));
	const edgeTypes = { default: ReconnectableEdge };

	// ── Workflow metadata & variables ────────────────────────────────

	let workflowMeta = $state<WorkflowMeta>({
		workflowType: '',
		taskQueue: 'default',
		version: '0.1.0',
		inputSchema: [],
		envVars: []
	});

	function updateWorkflowMeta(patch: Partial<WorkflowMeta>) {
		workflowMeta = { ...workflowMeta, ...patch };
	}

	// ── Panel layout state ────────────────────────────────────────────

	let paletteOpen = $state(true);
	let panelWidth = $state(400);

	$effect(() => {
		if (configNodeId) paletteOpen = false;
	});

	function startResize(e: MouseEvent) {
		e.preventDefault();
		const startX = e.clientX;
		const startW = panelWidth;
		document.body.style.cursor = 'col-resize';
		document.body.style.userSelect = 'none';

		function onMove(ev: MouseEvent) {
			panelWidth = Math.max(360, Math.min(680, startW + (startX - ev.clientX)));
		}
		function onUp() {
			document.body.style.cursor = '';
			document.body.style.userSelect = '';
			window.removeEventListener('mousemove', onMove);
			window.removeEventListener('mouseup', onUp);
		}
		window.addEventListener('mousemove', onMove);
		window.addEventListener('mouseup', onUp);
	}

	// ── Canvas state — one {nodes, edges} graph per drill-in scope ────

	// `scopes` has several independent writers (initial state below, the continuous per-scope
	// mirror effect, a wholesale replace when DSL text is synced back to the canvas in
	// applyDslToCanvas, and pruning orphaned try/catch scopes on delete) rather than a single
	// overridable formula, so it can't be a writable $derived.
	let scopes = $state<Record<string, ScopeGraph>>({
		[ROOT_SCOPE_ID]: {
			nodes: [
				{
					id: 'start',
					type: 'start',
					position: { x: 200, y: 100 },
					data: { type: 'start', label: 'Start', variables: [] },
					deletable: false
				},
				{
					id: 'end',
					type: 'end',
					position: { x: 200, y: 220 },
					data: { type: 'end', label: 'End' },
					deletable: false
				}
			],
			edges: [{ id: 'e-start-end', source: 'start', target: 'end' }]
		}
	});

	// `nodes`/`edges` are the always-fully-composed view of the whole workflow, rooted at
	// `ROOT_SCOPE_ID` — every `for`/`try`/`fork`/bare-`do` node's nested body renders inline as
	// tagged sibling nodes (recursively, to arbitrary depth — see `inlineScopeView.ts`), so there is
	// no separate "drilled-in" scope to switch to; the composed view IS the canvas.
	let nodes: Node[] = $state.raw(
		untrack(() => composeScopeForDisplay(scopes, ROOT_SCOPE_ID).nodes)
	);
	let edges: Edge[] = $state.raw(
		untrack(() => composeScopeForDisplay(scopes, ROOT_SCOPE_ID).edges)
	);

	/**
	 * Inline-lane bounding boxes (one per lane, at any nesting depth), used to target
	 * drag-and-drop — derived live from `nodes`' actual current positions (not the one-off layout
	 * pass at initial load), so it never goes stale after a node is added or dragged.
	 */
	const currentLaneBounds = $derived(computeLiveLaneBounds(nodes));

	// Keep the active scope's graph mirrored into `scopes` as the canvas is edited, so the DSL
	// preview (which reads the full `scopes` map) and scope-switching always see current data.
	// `scopes` itself is read untracked — otherwise this effect's own write would re-trigger it
	// (reading and writing the same state in one effect is an infinite-loop trap in Svelte 5).
	// `decomposeDisplayedScope` returns a partial map (only the scopes actually present in the
	// displayed view) — always spread over `prevScopes`, never replace, or every other scope not
	// currently in view (e.g. a sibling `for` loop's body) would be silently dropped.
	$effect(() => {
		const prevScopes = untrack(() => scopes);
		scopes = { ...prevScopes, ...decomposeDisplayedScope(nodes, edges) };
	});

	// Refresh the synthetic lane/continuation/terminal edges whenever `nodes` changes — e.g. a node
	// just dropped into a lane needs a fresh edge pointing at it, since `composeScopeForDisplay`
	// only computes these once, at scope-load time. Tracks `nodes` only; `edges` is read untracked
	// (same self-read guard as the mirror effect above) so reassigning it here can't re-trigger
	// this same effect.
	$effect(() => {
		const currentEdges = untrack(() => edges);
		const synthetic = computeLiveSyntheticEdges(nodes, currentEdges);
		const hiddenIds = computeHiddenRealEdgeIds(nodes, currentEdges);
		const real = currentEdges
			.filter((e) => !(e.data as Record<string, unknown> | undefined)?.syntheticScopeEdge)
			.map((e) => ({ ...e, hidden: hiddenIds.has(e.id) }));
		const terminal = computeTerminalEdges(nodes, [...real, ...synthetic]);
		edges = [...real, ...synthetic, ...terminal];
	});

	/** Recompose `nodes`/`edges` from `scopes` — only needed after `applyDslToCanvas` replaces `scopes` wholesale. */
	function reloadFromScopes() {
		const composed = composeScopeForDisplay(scopes, ROOT_SCOPE_ID);
		nodes = composed.nodes;
		edges = composed.edges;
	}

	// ── UI state ─────────────────────────────────────────────────────

	let saved = $state(false);
	let showDsl = $state(false);
	let showVariables = $state(false);
	let configNodeId = $state<string | null>(null);
	let screenToFlowPosition:
		((pos: { x: number; y: number }) => { x: number; y: number }) | undefined = $state();

	const configNode = $derived(
		configNodeId ? (nodes.find((n) => n.id === configNodeId) ?? null) : null
	);
	const dsl = $derived(serializeZigflowDocument(graphToAst({ scopes }, workflowMeta)));

	// ── DSL panel — bidirectional editor, gated by grammar validation ─

	let dslSyncEnabled = $state(true);
	let dslDraft = $state('');
	let dslErrors = $state<DeserializeError[]>([]);
	let dslDebounceHandle: ReturnType<typeof setTimeout> | undefined;

	const dslDiagnostics = $derived<Diagnostic[]>(
		dslErrors
			.filter((e) => e.range)
			.map((e) => ({
				from: e.range!.start,
				to: e.range!.end,
				severity: 'error',
				message: e.message
			}))
	);

	function toggleDslModal() {
		if (!showDsl) {
			dslDraft = dsl;
			dslErrors = [];
		}
		showDsl = !showDsl;
	}

	function resetDslDraft() {
		dslDraft = dsl;
		dslErrors = [];
	}

	function applyDslToCanvas(text: string) {
		const result = deserializeZigflowDocument(text);
		if (!result.ok) {
			dslErrors = result.errors;
			return;
		}
		dslErrors = [];
		const { graph, header } = astToGraph(result.document);
		scopes = graph.scopes;
		configNodeId = null;
		workflowMeta = { ...workflowMeta, ...header };
		reloadFromScopes();
	}

	function handleDslChange(text: string) {
		dslDraft = text;
		if (!dslSyncEnabled) {
			dslErrors = [];
			return;
		}
		if (dslDebounceHandle) clearTimeout(dslDebounceHandle);
		dslDebounceHandle = setTimeout(() => applyDslToCanvas(text), 600);
	}

	// ── Node operations ──────────────────────────────────────────────

	function addNode(type: WorkflowNodeType) {
		const meta = NODE_META[type];
		const newNode: Node = {
			id: `node-${crypto.randomUUID()}`,
			type,
			position: { x: 120 + Math.random() * 200, y: 120 + Math.random() * 200 },
			data: { type, ...meta.defaultData, [OWNER_SCOPE_TAG]: ROOT_SCOPE_ID }
		};
		nodes = [...nodes, newNode];
	}

	/**
	 * Which real scope a drag-and-drop at `position` should target: the main flow, or — if the
	 * drop lands inside an inline lane's bounding box (with some padding tolerance so drops don't
	 * have to hit an existing node precisely) — that lane's own scope, at whatever nesting depth.
	 */
	function resolveDropOwnerScope(position: { x: number; y: number }): string {
		const PADDING = 40;
		for (const [laneKey, bounds] of currentLaneBounds) {
			if (
				position.x >= bounds.x - PADDING &&
				position.x <= bounds.x + bounds.width + PADDING &&
				position.y >= bounds.yStart - PADDING
			) {
				return laneKey;
			}
		}
		return ROOT_SCOPE_ID;
	}

	function handleDrop(e: DragEvent) {
		e.preventDefault();
		const type = e.dataTransfer?.getData('application/workflow-node-type') as WorkflowNodeType;
		if (!type || !(type in NODE_META)) return;
		const meta = NODE_META[type];
		const position = screenToFlowPosition
			? screenToFlowPosition({ x: e.clientX, y: e.clientY })
			: { x: 200, y: 200 };
		const newNode: Node = {
			id: `node-${crypto.randomUUID()}`,
			type,
			position,
			data: { type, ...meta.defaultData, [OWNER_SCOPE_TAG]: resolveDropOwnerScope(position) }
		};
		nodes = [...nodes, newNode];
	}

	function updateNodeData(id: string, patch: Record<string, unknown>) {
		nodes = nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n));
	}

	function handleNodeClick(event: { node: Node }) {
		configNodeId = event.node.id;
	}

	function handleReconnect(oldEdge: Edge, newConnection: Connection) {
		edges = edges.map((e) =>
			e.id === oldEdge.id
				? {
						...e,
						source: newConnection.source,
						target: newConnection.target,
						sourceHandle: newConnection.sourceHandle ?? null,
						targetHandle: newConnection.targetHandle ?? null
					}
				: e
		);
	}

	/** Removes every scope key in `orphanScopeKeys` plus any now-orphaned lane nodes/edges still on the canvas. */
	function pruneOrphanedScopes(orphanScopeKeys: string[]) {
		if (orphanScopeKeys.length === 0) return;

		const orphanNodeIds = nodes
			.filter((n) =>
				orphanScopeKeys.includes(
					(n.data as Record<string, unknown> | undefined)?.[OWNER_SCOPE_TAG] as string
				)
			)
			.map((n) => n.id);
		if (orphanNodeIds.length > 0) {
			nodes = nodes.filter((n) => !orphanNodeIds.includes(n.id));
			edges = edges.filter(
				(e) => !orphanNodeIds.includes(e.source) && !orphanNodeIds.includes(e.target)
			);
		}

		const next = { ...scopes };
		for (const key of orphanScopeKeys) delete next[key];
		scopes = next;
	}

	/**
	 * Deleting a container node (`for`/`try`/`fork`/bare-`do`) leaves its inline lane nodes behind —
	 * xyflow's own `deleteElements` only removes the node you selected plus edges touching it, not
	 * other nodes that were merely tagged as "belonging" to it. Without this, they'd linger as
	 * stray disconnected cards on the canvas (harmless for the DSL — `decomposeDisplayedScope` only
	 * ever writes scopes actually reachable from the current view, so they'd never be serialized —
	 * but visually messy) and their `scopes[...]` entries would leak forever. Recurses through every
	 * descendant lane (a fork branch containing a nested for-loop, etc.), at any nesting depth.
	 */
	function handleElementsDeleted(payload: { nodes: Node[]; edges: Edge[] }) {
		const orphanScopeKeys = payload.nodes.flatMap((n) => {
			const ownerScopeId = (n.data as Record<string, unknown> | undefined)?.[OWNER_SCOPE_TAG] as
				string | undefined;
			if (!ownerScopeId) return [];
			return collectDescendantScopeKeysForNode(n, ownerScopeId, nodes);
		});
		pruneOrphanedScopes(orphanScopeKeys);
	}

	/** A `fork` branch was removed (not the whole node) — prune just that branch's scope + descendants. */
	function handleRemoveBranch(forkNodeId: string, branchId: string) {
		const forkNode = nodes.find((n) => n.id === forkNodeId);
		const ownerScopeId = (forkNode?.data as Record<string, unknown> | undefined)?.[
			OWNER_SCOPE_TAG
		] as string | undefined;
		if (!ownerScopeId) return;
		const laneKey = forkBranchScopeKey(ownerScopeId, forkNodeId, branchId);
		pruneOrphanedScopes(collectDescendantScopeKeysForLaneKey(laneKey, nodes));
	}

	function handleSave() {
		saved = true;
		setTimeout(() => (saved = false), 2000);
	}

	function onFlowReady(fn: (pos: { x: number; y: number }) => { x: number; y: number }) {
		screenToFlowPosition = fn;
	}
</script>

<svelte:head>
	<title>{workflowName} · Builder · DuraFlow</title>
</svelte:head>

<div class="bg-base-200 flex h-screen flex-col overflow-hidden">
	<!-- Toolbar -->
	<header class="bg-base-100 border-base-300 flex h-12 shrink-0 items-center gap-2 border-b px-3">
		<a href="/dashboard" class="btn btn-ghost btn-sm btn-circle" title="Back to dashboard">
			<ArrowLeft size={16} />
		</a>
		<div class="bg-primary/10 text-primary rounded p-1">
			<Workflow size={15} />
		</div>
		<div class="flex items-center gap-1">
			<a href="/dashboard" class="text-base-content/50 hover:text-base-content text-xs transition">
				{projectName}
			</a>
			<span class="text-base-content/30 text-xs">/</span>
			<span class="text-sm font-medium">{workflowName}</span>
		</div>
		<div class="flex-1"></div>
		<button
			class="btn btn-ghost btn-sm gap-1.5"
			class:btn-active={showVariables}
			onclick={() => (showVariables = true)}
			title="Workflow variables — $input schema, $env vars"
		>
			<SlidersHorizontal size={14} />
			Variables
		</button>
		<ThemeToggle />
		<button
			class="btn btn-ghost btn-sm gap-1.5"
			class:btn-active={showDsl}
			onclick={toggleDslModal}
			title="View and edit the generated Zigflow DSL"
		>
			<Code2 size={14} />
			DSL
		</button>
		<button class="btn btn-sm" class:btn-success={saved} onclick={handleSave}>
			{#if saved}
				<CircleCheck size={14} />
				Saved
			{:else}
				<Save size={14} />
				Save
			{/if}
		</button>
	</header>

	<!-- Main area: palette | canvas | resize-handle | node panel -->
	<div class="flex min-h-0 flex-1">
		<!-- Node palette (left, collapsible) -->
		<NodePalette
			open={paletteOpen}
			ontoggle={() => (paletteOpen = !paletteOpen)}
			onaddnode={addNode}
		/>

		<!-- Canvas -->
		<div
			class="relative min-w-0 flex-1"
			ondrop={handleDrop}
			ondragover={(e) => e.preventDefault()}
			role="application"
			aria-label="Workflow canvas"
		>
			<SvelteFlow
				bind:nodes
				bind:edges
				{nodeTypes}
				{edgeTypes}
				fitView
				style="width: 100%; height: 100%;"
				deleteKey={['Delete', 'Backspace']}
				onnodeclick={handleNodeClick}
				onreconnect={handleReconnect}
				ondelete={handleElementsDeleted}
			>
				<FlowInterop onready={onFlowReady} />
				<Background variant={BackgroundVariant.Dots} gap={20} size={1.2} />
				<Controls />
				<MiniMap zoomable pannable />
			</SvelteFlow>
		</div>

		<!-- Right node config panel (slides in when a node is selected) -->
		{#if configNode}
			<!-- Drag-to-resize splitter -->
			<button
				class="bg-base-300 hover:bg-primary/40 active:bg-primary/60 z-10 w-1 shrink-0 cursor-col-resize border-0 p-0 transition-colors"
				onmousedown={startResize}
				aria-label="Drag to resize panel"
			></button>
			<NodePanel
				node={configNode}
				{nodes}
				{edges}
				{workflowMeta}
				width={panelWidth}
				onclose={() => (configNodeId = null)}
				onupdate={updateNodeData}
				onremovebranch={handleRemoveBranch}
				onupdatemeta={updateWorkflowMeta}
			/>
		{/if}
	</div>
</div>

<!-- Workflow Variables modal -->
{#if showVariables}
	<WorkflowVariablesModal
		meta={workflowMeta}
		onclose={() => (showVariables = false)}
		onupdate={updateWorkflowMeta}
	/>
{/if}

<!-- DSL modal — bidirectional YAML editor, gated by grammar validation -->
{#if showDsl}
	<div class="modal modal-open z-50">
		<div class="modal-box flex h-[80vh] w-full max-w-3xl flex-col">
			<div class="mb-3 flex shrink-0 items-center justify-between">
				<div>
					<h3 class="font-semibold">Zigflow DSL</h3>
					<p class="text-base-content/40 text-xs">YAML · dsl 1.0.0</p>
				</div>
				<div class="flex items-center gap-3">
					<label class="flex cursor-pointer items-center gap-1.5 text-xs">
						<input
							type="checkbox"
							class="toggle toggle-xs"
							checked={dslSyncEnabled}
							onchange={(e) => (dslSyncEnabled = (e.target as HTMLInputElement).checked)}
						/>
						Sync to canvas
					</label>
					<button
						class="btn btn-ghost btn-sm"
						onclick={resetDslDraft}
						title="Discard edits and reload from the canvas"
					>
						Reset
					</button>
					<button
						class="btn btn-ghost btn-sm"
						onclick={() => navigator.clipboard.writeText(dslDraft)}
						title="Copy to clipboard"
					>
						Copy
					</button>
					<button class="btn btn-ghost btn-sm btn-circle" onclick={() => (showDsl = false)}
						>✕</button
					>
				</div>
			</div>

			<div class="border-base-300 min-h-0 flex-1 overflow-hidden rounded-lg border">
				<CodeMirrorEditor
					value={dslDraft}
					language="yaml"
					diagnostics={dslDiagnostics}
					onchange={handleDslChange}
				/>
			</div>

			{#if dslErrors.length > 0}
				<div
					class="border-error/30 bg-error/5 mt-2 max-h-32 shrink-0 overflow-y-auto rounded-lg border p-2"
				>
					<p class="text-error mb-1 text-[10px] font-semibold uppercase tracking-wider">
						{dslSyncEnabled ? 'Not applied to canvas — fix to resume sync' : 'Grammar errors'}
					</p>
					<ul class="flex flex-col gap-0.5">
						{#each dslErrors as err, i (i)}
							<li class="text-base-content/70 font-mono text-[10px]">
								<span class="text-error/70">{err.path}</span> — {err.message}
							</li>
						{/each}
					</ul>
				</div>
			{/if}
		</div>
		<form method="dialog" class="modal-backdrop">
			<button onclick={() => (showDsl = false)}>close</button>
		</form>
	</div>
{/if}

<style>
	:global(.svelte-flow__node) {
		font-family: inherit;
	}
	:global(.svelte-flow__edge-path) {
		stroke: #94a3b8;
		stroke-width: 2;
	}
	:global(.svelte-flow__edge.selected .svelte-flow__edge-path),
	:global(.svelte-flow__edge:hover .svelte-flow__edge-path) {
		stroke: #6366f1;
	}
	:global([data-theme='dark'] .svelte-flow__edge-path) {
		stroke: #475569;
	}
	:global([data-theme='dark'] .svelte-flow__edge.selected .svelte-flow__edge-path),
	:global([data-theme='dark'] .svelte-flow__edge:hover .svelte-flow__edge-path) {
		stroke: #818cf8;
	}
	:global(.svelte-flow__edge-textbg) {
		fill: #f8fafc;
	}
	:global(.svelte-flow__edge-text) {
		fill: #64748b;
		font-size: 10px;
		font-weight: 500;
	}
	:global([data-theme='dark'] .svelte-flow__edge-textbg) {
		fill: #1e293b;
	}
	:global([data-theme='dark'] .svelte-flow__edge-text) {
		fill: #94a3b8;
	}
	:global(.svelte-flow__handle) {
		background: var(--color-base-300);
		border-color: var(--color-base-100);
		width: 10px;
		height: 10px;
	}
	:global(.svelte-flow__handle:hover),
	:global(.svelte-flow__handle.connectingto) {
		background: var(--color-primary);
	}
	:global(.svelte-flow__controls) {
		background: var(--color-base-100);
		border: 1px solid var(--color-base-300);
		border-radius: 8px;
		box-shadow: none;
	}
	:global(.svelte-flow__controls-button) {
		background: var(--color-base-100);
		border-bottom-color: var(--color-base-200);
		fill: var(--color-base-content);
	}
	:global(.svelte-flow__controls-button:hover) {
		background: var(--color-base-200);
	}
	:global(.svelte-flow__minimap) {
		background: var(--color-base-100);
		border: 1px solid var(--color-base-300);
		border-radius: 8px;
	}
</style>
