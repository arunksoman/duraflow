<script lang="ts">
	import { untrack } from 'svelte';
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
	import { enhance } from '$app/forms';
	import { AlertTriangle, ArrowLeft, RefreshCw } from '@lucide/svelte';

	import WorkflowNode from '$lib/components/builder/WorkflowNode.svelte';
	import ReconnectableEdge from '$lib/components/builder/ReconnectableEdge.svelte';
	import RunView from '$lib/components/execution/RunView.svelte';
	import ThemeToggle from '$lib/components/ThemeToggle.svelte';
	import { NODE_TYPES } from '$lib/components/builder/builderConfig';
	import { astToGraph, type ScopeGraph } from '$lib/zigflow-engine/graph';
	import { deserializeZigflowDocument } from '$lib/zigflow-engine/deserialize';
	import { composeScopeForDisplay } from '$lib/zigflow-engine/inlineScopeView';
	import { ROOT_SCOPE_ID } from '$lib/zigflow-engine/scopeKey';
	import { buildRunIndex } from '$lib/zigflow-engine/runIndex';
	import { RunSession } from '$lib/runtime/runSession.svelte';
	import type { ExecutionStatus } from '$lib/types';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const nodeTypes = Object.fromEntries(NODE_TYPES.map((t) => [t, WorkflowNode]));
	const edgeTypes = { default: ReconnectableEdge };

	const statusClass: Record<ExecutionStatus, string> = {
		running: 'badge-info',
		completed: 'badge-success',
		failed: 'badge-error',
		cancelled: 'badge-warning',
		terminated: 'badge-warning',
		timed_out: 'badge-error'
	};

	// The canvas is rebuilt from the workflow's stored DSL, which is the same source the builder
	// draws from — so the highlighted graph matches what the designer authored.
	const parsed = untrack(() => {
		if (!data.workflow?.dsl) return null;
		const result = deserializeZigflowDocument(data.workflow.dsl);
		if (!result.ok) return null;
		return astToGraph(result.document);
	});

	const scopes: Record<string, ScopeGraph> = parsed?.graph.scopes ?? {};
	const runIndex = buildRunIndex({ scopes });
	const composed = parsed ? composeScopeForDisplay(scopes, ROOT_SCOPE_ID) : { nodes: [], edges: [] };

	let nodes: Node[] = $state.raw(composed.nodes);
	let edges: Edge[] = $state.raw(composed.edges);
	let selectedNodeId = $state<string | null>(null);

	const session = new RunSession();

	// A finished run renders from the events the server already sent; a still-running one attaches
	// to the live stream and keeps going from where those events left off.
	untrack(() => {
		if (data.execution.status === 'running') {
			session.start(data.execution.id, runIndex, data.events);
			session.childRuns = data.children;
		} else {
			session.replay(data.execution, runIndex, data.events, data.children);
		}
	});

	$effect(() => {
		return () => session.stop();
	});

	$effect(() => {
		const byNode = session.run.byNode;
		const current = untrack(() => nodes);
		let changed = false;

		const next = current.map((node) => {
			const detail = byNode[node.id];
			const nodeData = node.data as Record<string, unknown>;
			if (
				nodeData.runState === detail?.state &&
				nodeData.runAttempts === (detail?.attempts ?? 0) &&
				nodeData.childExecutionId === detail?.childExecutionId
			) {
				return node;
			}
			changed = true;
			return {
				...node,
				data: {
					...nodeData,
					runState: detail?.state,
					runAttempts: detail?.attempts ?? 0,
					childExecutionId: detail?.childExecutionId
				}
			};
		});

		if (changed) nodes = next;
	});

	const durationLabel = $derived.by(() => {
		const { startedAt, completedAt } = data.execution;
		if (!completedAt) return '';
		const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
		if (!Number.isFinite(ms) || ms < 0) return '';
		return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`;
	});

	const workflowLabel = $derived(
		data.execution.workflowName || data.execution.workflowType || 'Unknown workflow'
	);
</script>

<svelte:head>
	<title>{workflowLabel} run · DuraFlow</title>
</svelte:head>

<div class="flex h-[calc(100vh-2rem)] flex-col gap-3">
	<!-- Header -->
	<div class="flex flex-wrap items-center gap-3">
		<a class="btn btn-ghost btn-sm gap-1.5" href="/executions">
			<ArrowLeft size={14} />
			Executions
		</a>

		{#if data.parent}
			<span class="text-base-content/40">/</span>
			<a class="link link-hover text-sm" href="/executions/{data.parent.id}">
				{data.parent.workflowName || 'parent run'}
				{#if data.execution.parentTaskName}
					<span class="text-base-content/50">· {data.execution.parentTaskName}</span>
				{/if}
			</a>
		{/if}

		<span class="text-base-content/40">/</span>
		<h1 class="text-lg font-semibold">{workflowLabel}</h1>
		<code class="text-base-content/50 text-xs">{data.execution.id.slice(0, 8)}</code>

		<span class="badge {statusClass[data.execution.status]} badge-sm">
			{session.status === 'running' ? 'running' : data.execution.status}
		</span>

		<span class="text-base-content/50 text-xs">
			{new Date(data.execution.startedAt).toLocaleString()}
			{#if durationLabel}· {durationLabel}{/if}
		</span>

		<div class="ml-auto flex items-center gap-2">
			{#if data.execution.workflowId}
				<a
					class="btn btn-ghost btn-sm"
					href="/projects/{data.workflow?.projectId}/workflows/{data.execution.workflowId}/builder"
				>
					Open in builder
				</a>
				<form method="POST" action="?/rerun" use:enhance>
					<button class="btn btn-sm gap-1.5" type="submit">
						<RefreshCw size={14} />
						Re-run
					</button>
				</form>
			{/if}
			<ThemeToggle />
		</div>
	</div>

	{#if data.execution.error}
		<div class="alert alert-error gap-2 py-2 text-sm">
			<AlertTriangle size={16} />
			<span class="whitespace-pre-wrap">{data.execution.error}</span>
		</div>
	{/if}

	<!-- Canvas + run panel -->
	<div class="flex min-h-0 flex-1 flex-col">
		{#if nodes.length > 0}
			<div class="border-base-300 min-h-0 flex-1 overflow-hidden rounded-lg border">
				<SvelteFlow
					bind:nodes
					bind:edges
					{nodeTypes}
					{edgeTypes}
					nodesDraggable={false}
					nodesConnectable={false}
					elementsSelectable
					fitView
					onnodeclick={({ node }) => (selectedNodeId = node.id)}
				>
					<Background variant={BackgroundVariant.Dots} gap={16} />
					<Controls />
					<MiniMap zoomable pannable />
				</SvelteFlow>
			</div>
		{:else}
			<div class="alert alert-info py-2 text-sm">
				<span>
					No canvas for this run — its workflow {data.execution.workflowId
						? "couldn't be parsed"
						: 'is not stored in DuraFlow'}. The log below still shows everything it did.
				</span>
			</div>
		{/if}

		<div class="h-[22rem] shrink-0">
			<RunView
				{session}
				index={runIndex}
				{nodes}
				{selectedNodeId}
				onselectnode={(nodeId) => (selectedNodeId = nodeId)}
			/>
		</div>
	</div>
</div>
