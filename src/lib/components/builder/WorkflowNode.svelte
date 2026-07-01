<script lang="ts">
	import { Handle, Position, useSvelteFlow } from '@xyflow/svelte';
	import { Trash2 } from '@lucide/svelte';
	import { NODE_META } from './builderConfig';
	import type { WorkflowNodeType } from '$lib/types';

	let {
		id,
		data = {},
		selected = false,
		type = 'task'
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
		(type as WorkflowNodeType) in NODE_META ? (type as WorkflowNodeType) : 'task'
	);
	const meta = $derived(NODE_META[nodeType]);
	const label = $derived((data.label as string) || meta.label);
	const Icon = $derived(meta.icon);

	let isHovered = $state(false);

	const { deleteElements } = useSvelteFlow();

	function handleDelete(e: MouseEvent) {
		e.stopPropagation();
		deleteElements({ nodes: [{ id }] });
	}
</script>

{#if nodeType !== 'start'}
	<Handle type="target" position={Position.Top} />
{/if}

<div
	role="group"
	aria-label="{label} {nodeType} node"
	class="bg-base-100 border-base-300 relative w-44 select-none overflow-visible rounded-lg border shadow-sm transition-shadow"
	class:ring-2={selected}
	class:ring-offset-1={selected}
	style:border-left="4px solid {meta.color}"
	style:--tw-ring-color={meta.color}
	onmouseenter={() => (isHovered = true)}
	onmouseleave={() => (isHovered = false)}
>
	{#if isHovered && nodeType !== 'start'}
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
	<div class="border-base-200 border-t px-2.5 py-1.5">
		<span class="text-base-content/40 font-mono text-[10px] uppercase tracking-wide">
			{nodeType === 'childWorkflow' ? 'child-flow' : nodeType}
		</span>
	</div>
</div>

{#if nodeType !== 'end'}
	<Handle type="source" position={Position.Bottom} />
{/if}
