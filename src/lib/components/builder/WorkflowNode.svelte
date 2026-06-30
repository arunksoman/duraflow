<script lang="ts">
	import { Handle, Position } from '@xyflow/svelte';
	import { NODE_META } from './builderConfig';
	import type { WorkflowNodeType } from '$lib/types';

	let {
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

	const nodeType = $derived((type as WorkflowNodeType) in NODE_META ? (type as WorkflowNodeType) : 'task');
	const meta = $derived(NODE_META[nodeType]);
	const label = $derived((data.label as string) || meta.label);
	const Icon = $derived(meta.icon);
</script>

<Handle type="target" position={Position.Top} />

<div
	class="bg-base-100 border-base-300 w-44 select-none overflow-hidden rounded-lg border shadow-sm transition-shadow"
	class:ring-2={selected}
	class:ring-offset-1={selected}
	style:border-left="4px solid {meta.color}"
	style:--tw-ring-color={meta.color}
>
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
		<span class="text-base-content/40 font-mono text-[10px] uppercase tracking-wide"
			>{nodeType === 'childWorkflow' ? 'child-flow' : nodeType}</span
		>
	</div>
</div>

<Handle type="source" position={Position.Bottom} />
