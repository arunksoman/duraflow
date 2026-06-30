<script lang="ts">
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

	import { ArrowLeft, CircleCheck, Save, Trash2, Workflow } from '@lucide/svelte';
	import type { PageProps } from './$types';

	import WorkflowNode from '$lib/components/builder/WorkflowNode.svelte';
	import NodePalette from '$lib/components/builder/NodePalette.svelte';
	import FlowInterop from '$lib/components/builder/FlowInterop.svelte';
	import RightPanel from '$lib/components/builder/RightPanel.svelte';
	import { NODE_META, NODE_TYPES } from '$lib/components/builder/builderConfig';
	import { generateDsl } from '$lib/utils/dsl';
	import type { WorkflowNodeType } from '$lib/types';

	let { data }: PageProps = $props();

	// Build nodeTypes safely (avoids reserved-word property names like do/for/switch/try)
	const nodeTypes = Object.fromEntries(NODE_TYPES.map((t) => [t, WorkflowNode]));

	let nodes: Node[] = $state.raw([
		{
			id: '1',
			type: 'call',
			position: { x: 220, y: 40 },
			data: { type: 'call', label: 'Fetch Order', method: 'get', endpoint: 'https://api.example.com/orders' }
		},
		{
			id: '2',
			type: 'switch',
			position: { x: 220, y: 200 },
			data: { type: 'switch', label: 'Validate Status' }
		},
		{
			id: '3',
			type: 'fork',
			position: { x: 60, y: 360 },
			data: { type: 'fork', label: 'Process in Parallel' }
		},
		{
			id: '4',
			type: 'set',
			position: { x: 400, y: 360 },
			data: { type: 'set', label: 'Log Error', variable: 'error', value: 'message' }
		},
		{
			id: '5',
			type: 'wait',
			position: { x: 60, y: 520 },
			data: { type: 'wait', label: 'Wait for Confirm', duration: 300 }
		},
		{
			id: '6',
			type: 'raise',
			position: { x: 230, y: 520 },
			data: { type: 'raise', label: 'Order Completed', eventType: 'com.example.order.completed' }
		}
	]);

	let edges: Edge[] = $state.raw([
		{ id: 'e1-2', source: '1', target: '2' },
		{ id: 'e2-3', source: '2', target: '3', label: 'success' },
		{ id: 'e2-4', source: '2', target: '4', label: 'failure' },
		{ id: 'e3-5', source: '3', target: '5' },
		{ id: 'e3-6', source: '3', target: '6' }
	]);

	let nodeCounter = $state(10);
	let saved = $state(false);
	let screenToFlowPosition:
		| ((pos: { x: number; y: number }) => { x: number; y: number })
		| undefined = $state();

	const selectedNode = $derived(nodes.find((n) => n.selected) ?? null);
	const dsl = $derived(generateDsl(nodes, edges));

	function addNode(type: WorkflowNodeType) {
		const meta = NODE_META[type];
		nodeCounter++;
		const col = (nodeCounter - 1) % 3;
		const row = Math.floor((nodeCounter - 1) / 3);
		const newNode: Node = {
			id: `node-${Date.now()}`,
			type,
			position: { x: 80 + col * 220, y: 60 + row * 160 },
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
			: { x: 100 + ((nodeCounter * 40) % 500), y: 100 };
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

	function deleteSelected() {
		const ids = new Set(nodes.filter((n) => n.selected).map((n) => n.id));
		if (ids.size === 0) return;
		nodes = nodes.filter((n) => !ids.has(n.id));
		edges = edges.filter((e) => !ids.has(e.source) && !ids.has(e.target));
	}

	function handleSave() {
		saved = true;
		setTimeout(() => {
			saved = false;
		}, 2000);
	}

	function onFlowReady(fn: (pos: { x: number; y: number }) => { x: number; y: number }) {
		screenToFlowPosition = fn;
	}
</script>

<svelte:head>
	<title>{data.workflowName} · Builder · DuraFlow</title>
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
				{data.projectName}
			</a>
			<span class="text-base-content/30 text-xs">/</span>
			<span class="text-sm font-medium">{data.workflowName}</span>
		</div>
		<div class="flex-1"></div>
		{#if selectedNode}
			<button
				class="btn btn-ghost btn-sm text-error"
				onclick={deleteSelected}
				title="Delete selected node"
			>
				<Trash2 size={14} />
				Delete
			</button>
		{/if}
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

	<!-- Main canvas area -->
	<div class="flex min-h-0 flex-1">
		<NodePalette onaddnode={addNode} />

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
				fitView
				deleteKey={['Backspace', 'Delete']}
				style="width: 100%; height: 100%;"
			>
				<FlowInterop onready={onFlowReady} />
				<Background variant={BackgroundVariant.Dots} gap={20} size={1.2} />
				<Controls />
				<MiniMap zoomable pannable />
			</SvelteFlow>
		</div>

		<RightPanel {selectedNode} {dsl} onupdate={updateNodeData} />
	</div>
</div>

<style>
	:global(.svelte-flow__node) {
		font-family: inherit;
	}
	:global(.svelte-flow__edge-path) {
		stroke: var(--color-base-content);
		opacity: 0.25;
		stroke-width: 2;
	}
	:global(.svelte-flow__edge.selected .svelte-flow__edge-path),
	:global(.svelte-flow__edge:hover .svelte-flow__edge-path) {
		opacity: 0.6;
	}
	:global(.svelte-flow__edge-textbg) {
		fill: var(--color-base-100);
	}
	:global(.svelte-flow__edge-text) {
		fill: var(--color-base-content);
		font-size: 10px;
		opacity: 0.55;
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
