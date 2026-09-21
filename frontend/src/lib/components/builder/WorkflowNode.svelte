<script lang="ts">
	import { Handle, Position, useSvelteFlow } from '@xyflow/svelte';
	import { ExternalLink, Trash2 } from '@lucide/svelte';
	import { NODE_META } from './builderConfig';
	import { RUN_TONE_VAR, runTone } from './runStatus';
	import type { WorkflowNodeType } from '$lib/types';
	import type { NodeRunState } from '$lib/zigflow-engine/runState';

	let {
		id,
		data = {},
		selected = false,
		type = 'set'
	}: {
		id: string;
		data: Record<string, unknown>;
		selected?: boolean;
		type?: string;
		dragging?: boolean;
		positionAbsoluteX?: number;
		positionAbsoluteY?: number;
		isConnectable?: boolean;
		zIndex?: number;
	} = $props();

	const nodeType = $derived(
		(type as WorkflowNodeType) in NODE_META ? (type as WorkflowNodeType) : 'set'
	);
	const meta = $derived(NODE_META[nodeType]);
	const label = $derived((data.label as string) || meta.label);
	const Icon = $derived(meta.icon);
	// Run state, projected onto the node by whichever page is showing a run. `skipped` is the one
	// that answers "which path did it take?" — it means the run finished without ever reaching
	// this node.
	const runState = $derived(data.runState as NodeRunState | undefined);
	const runAttempts = $derived((data.runAttempts as number) ?? 0);
	const childExecutionId = $derived(data.childExecutionId as string | undefined);
	// Every node shares one neutral border at rest — the icon carries the node type — and takes its
	// run status colour once a run touches it.
	const tone = $derived(runTone(runState));
	const toneColor = $derived(RUN_TONE_VAR[tone]);

	/** The primary workflow's Start — fixed. (A named workflow's Start is a `start` node too.) */
	const isPrimaryStart = $derived(nodeType === 'start' && id === 'start');

	let isHovered = $state(false);

	const { deleteElements } = useSvelteFlow();

	function handleDelete(e: MouseEvent) {
		e.stopPropagation();
		deleteElements({ nodes: [{ id }] });
	}
</script>

<!-- The primary Start has nothing before it. A named workflow's Start does: the switch cases that
     start it arrive here. -->
{#if !isPrimaryStart}
	<Handle type="target" position={Position.Top} />
{/if}

<div
	role="group"
	aria-label="{label} {nodeType} node"
	class="bg-base-100 relative w-44 select-none overflow-visible rounded-lg border-2 shadow-sm transition-[box-shadow,border-color,opacity]"
	class:outline-2={selected}
	class:outline-offset-4={selected}
	class:outline-primary={selected}
	class:run-pulse={runState === 'running'}
	class:border-dashed={runState === 'skipped'}
	class:opacity-70={runState === 'skipped'}
	style:border-color={toneColor}
	style:--run-tone={toneColor}
	style:box-shadow={tone === 'neutral'
		? undefined
		: `0 0 0 3px color-mix(in oklab, ${toneColor} 22%, transparent)`}
	onmouseenter={() => (isHovered = true)}
	onmouseleave={() => (isHovered = false)}
>
	<!-- The primary Start and every End are fixed; a named workflow's Start deletes that workflow. -->
	{#if isHovered && !isPrimaryStart && nodeType !== 'end' && !data.readOnly}
		<button
			class="bg-error text-error-content absolute -right-2 -top-2 z-10 flex size-5 cursor-pointer items-center justify-center rounded-full shadow-md transition-transform hover:scale-110"
			onclick={handleDelete}
			title="Delete node"
		>
			<Trash2 size={10} />
		</button>
	{/if}

	<div class="flex items-center gap-2 p-2.5 pb-2">
		<div
			class="flex size-7 shrink-0 items-center justify-center rounded-md"
			style:background="{meta.color}22"
			style:color={meta.color}
		>
			<Icon size={14} />
		</div>
		<span class="text-base-content min-w-0 flex-1 truncate text-xs font-semibold">{label}</span>
	</div>
	<div class="border-base-200 flex items-center gap-1.5 border-t px-2.5 py-1.5">
		<span class="text-base-content/40 font-mono text-[10px] uppercase tracking-wide">
			{nodeType === 'childWorkflow'
				? 'child-flow'
				: nodeType === 'grpcCall'
					? 'grpc-call'
					: nodeType}
		</span>
		{#if runState === 'skipped'}
			<span class="text-[10px]" style:color={toneColor} title="Not on the path this run took">
				not run
			</span>
		{:else if runState === 'unknown'}
			<span class="text-warning text-[10px]" title="The run ended before this task reported back">
				unresolved
			</span>
		{/if}
		{#if runAttempts > 1}
			<span class="badge badge-ghost badge-xs" title="{runAttempts} attempts">×{runAttempts}</span>
		{/if}
		{#if childExecutionId}
			<a
				class="text-base-content/60 hover:text-primary ml-auto"
				href="/executions/{childExecutionId}"
				title="Open this child workflow's run"
				onclick={(e) => e.stopPropagation()}
			>
				<ExternalLink size={11} />
			</a>
		{/if}
	</div>
</div>

{#if nodeType !== 'end'}
	<Handle type="source" position={Position.Bottom} />
{/if}

<style>
	/* A glow that breathes around a running node, instead of fading the whole card. */
	.run-pulse {
		animation: run-pulse 1.4s ease-in-out infinite;
	}

	@keyframes run-pulse {
		0%,
		100% {
			box-shadow: 0 0 0 2px color-mix(in oklab, var(--run-tone) 25%, transparent);
		}
		50% {
			box-shadow: 0 0 0 6px color-mix(in oklab, var(--run-tone) 10%, transparent);
		}
	}
</style>
