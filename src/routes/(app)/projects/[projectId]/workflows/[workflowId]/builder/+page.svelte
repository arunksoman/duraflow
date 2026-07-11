<script lang="ts">
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
	import { NODE_META, NODE_TYPES } from '$lib/components/builder/builderConfig';
	import { generateDsl } from '$lib/utils/dsl';
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
		namespace: 'default',
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

	// ── Canvas state ─────────────────────────────────────────────────

	let nodes: Node[] = $state.raw([
		{
			id: 'start',
			type: 'start',
			position: { x: 200, y: 100 },
			data: { type: 'start', label: 'Start', variables: [] },
			deletable: false
		}
	]);

	let edges: Edge[] = $state.raw([]);

	// ── UI state ─────────────────────────────────────────────────────

	let saved = $state(false);
	let showDsl = $state(false);
	let showVariables = $state(false);
	let configNodeId = $state<string | null>(null);
	let screenToFlowPosition:
		| ((pos: { x: number; y: number }) => { x: number; y: number })
		| undefined = $state();

	const configNode = $derived(configNodeId ? (nodes.find((n) => n.id === configNodeId) ?? null) : null);
	const dsl = $derived(generateDsl(nodes, edges, workflowMeta));

	// ── Node operations ──────────────────────────────────────────────

	function addNode(type: WorkflowNodeType) {
		const meta = NODE_META[type];
		const newNode: Node = {
			id: `node-${Date.now()}`,
			type,
			position: { x: 120 + Math.random() * 200, y: 120 + Math.random() * 200 },
			data: { type, ...meta.defaultData }
		};
		nodes = [...nodes, newNode];
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
			id: `node-${Date.now()}`,
			type,
			position,
			data: { type, ...meta.defaultData }
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
			onclick={() => (showDsl = !showDsl)}
			title="View generated Zigflow DSL"
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

<!-- DSL modal -->
{#if showDsl}
	<div class="modal modal-open z-50">
		<div class="modal-box w-full max-w-2xl">
			<div class="mb-3 flex items-center justify-between">
				<div>
					<h3 class="font-semibold">Generated DSL</h3>
					<p class="text-base-content/40 text-xs">Zigflow YAML · 1.0.0-alpha5</p>
				</div>
				<div class="flex gap-2">
					<button
						class="btn btn-ghost btn-sm"
						onclick={() => navigator.clipboard.writeText(dsl)}
						title="Copy to clipboard"
					>
						Copy
					</button>
					<button class="btn btn-ghost btn-sm btn-circle" onclick={() => (showDsl = false)}>✕</button>
				</div>
			</div>
			<pre class="bg-base-200 max-h-[60vh] overflow-auto rounded-lg p-4 font-mono text-[11px] leading-relaxed text-base-content/80 whitespace-pre">{dsl}</pre>
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
	:global(.svelte-flow__edge-textbg) { fill: #f8fafc; }
	:global(.svelte-flow__edge-text) { fill: #64748b; font-size: 10px; font-weight: 500; }
	:global([data-theme='dark'] .svelte-flow__edge-textbg) { fill: #1e293b; }
	:global([data-theme='dark'] .svelte-flow__edge-text) { fill: #94a3b8; }
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
	:global(.svelte-flow__controls-button:hover) { background: var(--color-base-200); }
	:global(.svelte-flow__minimap) {
		background: var(--color-base-100);
		border: 1px solid var(--color-base-300);
		border-radius: 8px;
	}
</style>
