<script lang="ts">
	import { NODE_META, NODE_TYPES, CATEGORY_LABELS } from './builderConfig';
	import type { WorkflowNodeType } from '$lib/types';
	import { ChevronLeft, ChevronRight } from '@lucide/svelte';

	interface Props {
		onaddnode: (type: WorkflowNodeType) => void;
		open?: boolean;
		ontoggle?: () => void;
	}

	let { onaddnode, open = true, ontoggle }: Props = $props();

	const categories = ['action', 'control', 'event', 'structure', 'terminal'] as const;

	const grouped = $derived(
		categories
			.map((cat) => ({
				key: cat,
				label: CATEGORY_LABELS[cat],
				types: NODE_TYPES.filter((t) => NODE_META[t].category === cat && NODE_META[t].showInPalette)
			}))
			.filter((g) => g.types.length > 0)
	);

	function handleDragStart(e: DragEvent, nodeType: WorkflowNodeType) {
		e.dataTransfer?.setData('application/workflow-node-type', nodeType);
		if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy';
	}
</script>

{#if open}
	<aside class="bg-base-100 border-base-300 flex w-52 shrink-0 flex-col overflow-y-auto border-r">
		<div class="border-base-200 flex items-center justify-between border-b px-3 py-2.5">
			<div>
				<p class="text-base-content/50 text-[10px] font-semibold uppercase tracking-wider">
					Node Palette
				</p>
				<p class="text-base-content/40 mt-0.5 text-[10px]">Drag or click to add</p>
			</div>
			<button
				class="btn btn-ghost btn-xs btn-circle shrink-0"
				onclick={ontoggle}
				title="Collapse palette"
			>
				<ChevronLeft size={14} />
			</button>
		</div>

		{#each grouped as group (group.key)}
			<div class="border-base-200 border-b px-3 py-2">
				<p class="text-base-content/40 mb-1.5 px-1 text-[10px] font-semibold uppercase tracking-wider">
					{group.label}
				</p>
				<div class="flex flex-col gap-0.5">
					{#each group.types as nodeType (nodeType)}
						{@const meta = NODE_META[nodeType]}
						{@const Icon = meta.icon}
						<div
							role="button"
							tabindex="0"
							draggable="true"
							ondragstart={(e) => handleDragStart(e, nodeType)}
							onclick={() => onaddnode(nodeType)}
							onkeydown={(e) => e.key === 'Enter' && onaddnode(nodeType)}
							class="hover:bg-base-200 flex cursor-grab items-center gap-2 rounded-lg px-2 py-1.5 transition active:cursor-grabbing"
							title={meta.description}
						>
							<div
								class="flex size-6 shrink-0 items-center justify-center rounded"
								style:background="{meta.color}22"
								style:color={meta.color}
							>
								<Icon size={13} />
							</div>
							<span class="text-base-content/80 text-xs font-medium">{meta.label}</span>
						</div>
					{/each}
				</div>
			</div>
		{/each}
	</aside>
{:else}
	<!-- Collapsed strip -->
	<aside
		class="bg-base-100 border-base-300 flex w-8 shrink-0 flex-col items-center gap-2 border-r py-2"
	>
		<button class="btn btn-ghost btn-xs btn-circle" onclick={ontoggle} title="Expand palette">
			<ChevronRight size={14} />
		</button>
	</aside>
{/if}
