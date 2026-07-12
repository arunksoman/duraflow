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
	import {
		ArrowLeft,
		ChevronRight,
		CircleCheck,
		Code2,
		Save,
		SlidersHorizontal,
		Workflow
	} from '@lucide/svelte';
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
	import {
		ROOT_SCOPE_ID,
		forScopeKey,
		tryScopeKey,
		catchScopeKey
	} from '$lib/zigflow-engine/scopeKey';
	import {
		composeScopeForDisplay,
		decomposeDisplayedScope,
		computeLiveLaneBounds,
		computeLiveSyntheticEdges,
		computeHiddenRealEdgeIds,
		OWNER_SCOPE_TAG
	} from '$lib/zigflow-engine/inlineTryView';
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

	/** Breadcrumb trail of scope ids — last entry is the scope currently shown on the canvas. */
	let scopeStack = $state<string[]>([ROOT_SCOPE_ID]);
	/** Human-readable labels for non-root scopes, set when drilling in. */
	let scopeLabels = $state<Record<string, string>>({ [ROOT_SCOPE_ID]: 'Workflow' });

	const currentScopeId = $derived(scopeStack[scopeStack.length - 1]);

	// `nodes`/`edges` are the currently-displayed (composed) view of `currentScopeId` — for a
	// scope containing `try` nodes, this is flattened to also include their try/catch lane nodes
	// inline (see `inlineTryView.ts`), tagged with which real scope each node belongs to so edits
	// demultiplex back correctly. For every other scope shape (for/fork/plain do), composing is a
	// no-op passthrough.
	let nodes: Node[] = $state.raw(
		untrack(() => composeScopeForDisplay(scopes, ROOT_SCOPE_ID).nodes)
	);
	let edges: Edge[] = $state.raw(
		untrack(() => composeScopeForDisplay(scopes, ROOT_SCOPE_ID).edges)
	);

	/**
	 * Try/catch lane bounding boxes, used to target drag-and-drop — derived live from `nodes`'
	 * actual current positions (not the one-off layout pass in `loadScope`), so it never goes
	 * stale after a node is added or dragged without a full scope switch.
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

	// Refresh the synthetic "try"/"catch" labeled edges whenever `nodes` changes — e.g. a node
	// just dropped into a lane needs a fresh edge pointing at it, since `composeScopeForDisplay`
	// only computes these once, at scope-load time. Tracks `nodes` only; `edges` is read untracked
	// (same self-read guard as the mirror effect above) so reassigning it here can't re-trigger
	// this same effect.
	$effect(() => {
		const currentEdges = untrack(() => edges);
		const synthetic = computeLiveSyntheticEdges(nodes, currentEdges);
		const hiddenIds = computeHiddenRealEdgeIds(nodes, currentEdges);
		const real = currentEdges
			.filter((e) => !(e.data as Record<string, unknown> | undefined)?.syntheticTryEdge)
			.map((e) => ({ ...e, hidden: hiddenIds.has(e.id) }));
		edges = [...real, ...synthetic];
	});

	function loadScope(scopeId: string) {
		const composed = composeScopeForDisplay(scopes, scopeId);
		nodes = composed.nodes;
		edges = composed.edges;
	}

	/**
	 * Flush `nodes`/`edges` into `scopes` synchronously (same partial-map merge as the mirror
	 * effect above). The mirror `$effect` does this too, but only on its next microtask flush —
	 * too late if we're about to switch scopes (and thus overwrite `nodes`/`edges`) in the same
	 * synchronous call, e.g. right after adding a node and immediately auto-drilling into it.
	 */
	function persistCurrentScope() {
		scopes = { ...scopes, ...decomposeDisplayedScope(nodes, edges) };
	}

	function drillInto(childScopeId: string, label: string) {
		persistCurrentScope();
		if (!scopes[childScopeId]) scopes = { ...scopes, [childScopeId]: { nodes: [], edges: [] } };
		scopeLabels = { ...scopeLabels, [childScopeId]: label };
		scopeStack = [...scopeStack, childScopeId];
		configNodeId = null;
		loadScope(childScopeId);
	}

	function goToBreadcrumb(index: number) {
		if (index >= scopeStack.length - 1) return;
		persistCurrentScope();
		scopeStack = scopeStack.slice(0, index + 1);
		configNodeId = null;
		loadScope(currentScopeId);
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
	let dslSyncNotice = $state('');
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
			dslSyncNotice = '';
		}
		showDsl = !showDsl;
	}

	function resetDslDraft() {
		dslDraft = dsl;
		dslErrors = [];
		dslSyncNotice = '';
	}

	function applyDslToCanvas(text: string) {
		const result = deserializeZigflowDocument(text);
		if (!result.ok) {
			dslErrors = result.errors;
			return;
		}
		dslErrors = [];
		const { graph, header } = astToGraph(result.document);
		const wasNested = scopeStack.length > 1;
		scopes = graph.scopes;
		scopeStack = [ROOT_SCOPE_ID];
		scopeLabels = { [ROOT_SCOPE_ID]: 'Workflow' };
		configNodeId = null;
		workflowMeta = { ...workflowMeta, ...header };
		loadScope(ROOT_SCOPE_ID);
		dslSyncNotice = wasNested
			? 'Canvas rebuilt from the edited DSL — returned to the root view.'
			: '';
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

	/**
	 * For nodes have a nested body but start out empty and easy to miss — jump straight into it
	 * the moment the node is created, so authoring the body is the very next thing you do. Try no
	 * longer drills in (its try/catch bodies render inline, see `inlineTryView.ts`). Fork has no
	 * default scope to jump into (it starts with zero branches, added explicitly in its panel), so
	 * both are left showing their own config panel like any other node.
	 *
	 * Only wired up for the palette's click-to-add gesture (see `addNode`), not drag-and-drop
	 * (`handleDrop`) — dropping a node onto a specific canvas position reads as "place it here",
	 * so immediately navigating away to an empty nested scope felt like the node had vanished.
	 */
	function maybeAutoDrillIn(node: Node) {
		const meta = NODE_META[node.type as WorkflowNodeType];
		const label = (node.data?.label as string) ?? meta.label;
		if (meta.nestedScopes === 'do') {
			drillInto(forScopeKey(currentScopeId, node.id), `${label} → body`);
		}
	}

	function addNode(type: WorkflowNodeType) {
		const meta = NODE_META[type];
		const newNode: Node = {
			id: `node-${crypto.randomUUID()}`,
			type,
			position: { x: 120 + Math.random() * 200, y: 120 + Math.random() * 200 },
			data: { type, ...meta.defaultData, [OWNER_SCOPE_TAG]: currentScopeId }
		};
		nodes = [...nodes, newNode];
		maybeAutoDrillIn(newNode);
	}

	/**
	 * Which real scope a drag-and-drop at `position` should target: the main flow, or — if the
	 * drop lands inside a `try` node's inline try-lane/catch-lane bounding box (with some padding
	 * tolerance so drops don't have to hit an existing node precisely) — that lane's scope.
	 */
	function resolveDropOwnerScope(position: { x: number; y: number }): string {
		const PADDING = 40;
		for (const [tryId, bounds] of currentLaneBounds.tryBounds) {
			if (
				position.x >= bounds.x - PADDING &&
				position.x <= bounds.x + bounds.width + PADDING &&
				position.y >= bounds.yStart - PADDING
			) {
				return tryScopeKey(currentScopeId, tryId);
			}
		}
		for (const [tryId, bounds] of currentLaneBounds.catchBounds) {
			if (
				position.x >= bounds.x - PADDING &&
				position.x <= bounds.x + bounds.width + PADDING &&
				position.y >= bounds.yStart - PADDING
			) {
				return catchScopeKey(currentScopeId, tryId);
			}
		}
		return currentScopeId;
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

	/**
	 * Deleting a `try` node leaves its inline try-lane/catch-lane nodes behind — xyflow's own
	 * `deleteElements` only removes the node you selected plus edges touching it, not other nodes
	 * that were merely tagged as "belonging" to it. Without this, they'd linger as stray
	 * disconnected cards on the canvas (harmless for the DSL — `decomposeDisplayedScope` only ever
	 * writes scopes actually reachable from the current view, so they'd never be serialized — but
	 * visually messy) and their `scopes[...]` entries would leak forever. Only prunes try nodes
	 * that belonged to the currently-viewed scope (a `try` placed inside another try's lane isn't
	 * inlined recursively in this pass, so its scopes/lane nodes are left alone here too).
	 */
	function handleElementsDeleted(payload: { nodes: Node[]; edges: Edge[] }) {
		const deletedTryIds = payload.nodes
			.filter(
				(n) =>
					n.type === 'try' &&
					(n.data as Record<string, unknown> | undefined)?.[OWNER_SCOPE_TAG] === currentScopeId
			)
			.map((n) => n.id);
		if (deletedTryIds.length === 0) return;

		const orphanScopeKeys = deletedTryIds.flatMap((tryId) => [
			tryScopeKey(currentScopeId, tryId),
			catchScopeKey(currentScopeId, tryId)
		]);

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

	<!-- Breadcrumb — visible once drilled into a nested scope (For/Fork-branch/Try/Catch body) -->
	{#if scopeStack.length > 1}
		<div
			class="bg-base-100 border-base-300 flex h-8 shrink-0 items-center gap-1 border-b px-3 text-xs"
		>
			{#each scopeStack as sid, i (sid)}
				<button
					type="button"
					class="hover:text-primary shrink-0 {i === scopeStack.length - 1
						? 'text-base-content font-semibold'
						: 'text-base-content/50'}"
					disabled={i === scopeStack.length - 1}
					onclick={() => goToBreadcrumb(i)}
				>
					{scopeLabels[sid] ?? sid}
				</button>
				{#if i < scopeStack.length - 1}
					<ChevronRight size={12} class="text-base-content/30 shrink-0" />
				{/if}
			{/each}
		</div>
	{/if}

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
				scopeId={currentScopeId}
				width={panelWidth}
				onclose={() => (configNodeId = null)}
				onupdate={updateNodeData}
				ondrillin={drillInto}
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

			{#if dslSyncNotice}
				<div class="alert alert-info mb-2 shrink-0 py-1.5 text-xs">
					<span>{dslSyncNotice}</span>
				</div>
			{/if}

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
