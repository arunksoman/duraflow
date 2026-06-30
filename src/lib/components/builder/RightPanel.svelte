<script lang="ts">
	import type { Node } from '@xyflow/svelte';
	import { Code2, Settings2 } from '@lucide/svelte';
	import { NODE_META } from './builderConfig';
	import type { WorkflowNodeType } from '$lib/types';

	interface Props {
		selectedNode: Node | null;
		dsl: string;
		onupdate: (id: string, patch: Record<string, unknown>) => void;
	}

	let { selectedNode, dsl, onupdate }: Props = $props();

	let activeTab: 'inspector' | 'dsl' = $state('inspector');

	const nodeType = $derived<WorkflowNodeType>(
		selectedNode && (selectedNode.type ?? 'task') in NODE_META
			? (selectedNode.type as WorkflowNodeType)
			: 'task'
	);
	const meta = $derived(NODE_META[nodeType]);
	const HeaderIcon = $derived(meta.icon);

	function field(key: string): string {
		return (selectedNode?.data[key] as string) ?? '';
	}

	function patch(key: string, value: unknown) {
		if (selectedNode) onupdate(selectedNode.id, { [key]: value });
	}

	function numField(key: string, fallback: number): number {
		const v = selectedNode?.data[key];
		return typeof v === 'number' ? v : fallback;
	}
</script>

<aside class="bg-base-100 border-base-300 flex w-72 shrink-0 flex-col border-l">
	<!-- Tabs -->
	<div class="border-base-200 flex shrink-0 border-b">
		<button
			class="flex flex-1 items-center justify-center gap-1.5 py-2.5 text-xs font-medium transition
			{activeTab === 'inspector'
				? 'border-b-2 border-primary text-primary'
				: 'text-base-content/50 hover:text-base-content'}"
			onclick={() => (activeTab = 'inspector')}
		>
			<Settings2 size={13} />
			Inspector
		</button>
		<button
			class="flex flex-1 items-center justify-center gap-1.5 py-2.5 text-xs font-medium transition
			{activeTab === 'dsl'
				? 'border-b-2 border-primary text-primary'
				: 'text-base-content/50 hover:text-base-content'}"
			onclick={() => (activeTab = 'dsl')}
		>
			<Code2 size={13} />
			DSL
		</button>
	</div>

	<!-- Content -->
	<div class="min-h-0 flex-1 overflow-y-auto">
		{#if activeTab === 'inspector'}
			{#if selectedNode}
				<div class="flex flex-col gap-3 p-4">
					<!-- Header -->
					<div class="flex items-center gap-2.5">
						<div
							class="flex size-8 shrink-0 items-center justify-center rounded-lg"
							style:background="{meta.color}22"
							style:color={meta.color}
						>
							<HeaderIcon size={15} />
						</div>
						<div class="min-w-0">
							<p class="text-sm font-semibold">{meta.label}</p>
							<p class="text-base-content/40 truncate text-xs">{meta.description}</p>
						</div>
					</div>

					<div class="divider my-0"></div>

					<!-- Label (all types) -->
					<div class="flex flex-col gap-1">
						<label class="text-base-content/60 text-xs font-medium" for="f-label">Label</label>
						<input
							id="f-label"
							class="input input-sm w-full"
							value={field('label')}
							oninput={(e) => patch('label', (e.target as HTMLInputElement).value)}
						/>
					</div>

					<!-- call / task -->
					{#if nodeType === 'call' || nodeType === 'task'}
						<div class="flex flex-col gap-1">
							<label class="text-base-content/60 text-xs font-medium" for="f-method">Method</label>
							<select
								id="f-method"
								class="select select-sm w-full"
								value={field('method') || 'get'}
								onchange={(e) => patch('method', (e.target as HTMLSelectElement).value)}
							>
								{#each ['get', 'post', 'put', 'patch', 'delete'] as m (m)}
									<option value={m}>{m.toUpperCase()}</option>
								{/each}
							</select>
						</div>
						<div class="flex flex-col gap-1">
							<label class="text-base-content/60 text-xs font-medium" for="f-ep">Endpoint</label>
							<input
								id="f-ep"
								class="input input-sm w-full font-mono text-xs"
								placeholder="https://api.example.com/endpoint"
								value={field('endpoint')}
								oninput={(e) => patch('endpoint', (e.target as HTMLInputElement).value)}
							/>
						</div>
					{/if}

					{#if nodeType === 'task'}
						<div class="flex flex-col gap-1">
							<label class="text-base-content/60 text-xs font-medium" for="f-timeout">Timeout</label>
							<input
								id="f-timeout"
								class="input input-sm w-full"
								placeholder="30s"
								value={field('timeout')}
								oninput={(e) => patch('timeout', (e.target as HTMLInputElement).value)}
							/>
						</div>
					{/if}

					{#if nodeType === 'for'}
						<div class="flex flex-col gap-1">
							<label class="text-base-content/60 text-xs font-medium" for="f-each"
								>Each variable</label
							>
							<input
								id="f-each"
								class="input input-sm w-full font-mono text-xs"
								value={field('each') || 'item'}
								oninput={(e) => patch('each', (e.target as HTMLInputElement).value)}
							/>
						</div>
						<div class="flex flex-col gap-1">
							<label class="text-base-content/60 text-xs font-medium" for="f-coll">Collection</label>
							<input
								id="f-coll"
								class="input input-sm w-full font-mono text-xs"
								value={field('collection') || 'items'}
								oninput={(e) => patch('collection', (e.target as HTMLInputElement).value)}
							/>
						</div>
					{/if}

					{#if nodeType === 'listen' || nodeType === 'raise'}
						<div class="flex flex-col gap-1">
							<label class="text-base-content/60 text-xs font-medium" for="f-evt">Event type</label>
							<input
								id="f-evt"
								class="input input-sm w-full font-mono text-xs"
								placeholder="com.example.my-event"
								value={field('eventType')}
								oninput={(e) => patch('eventType', (e.target as HTMLInputElement).value)}
							/>
						</div>
					{/if}

					{#if nodeType === 'set'}
						<div class="flex flex-col gap-1">
							<label class="text-base-content/60 text-xs font-medium" for="f-var">Variable</label>
							<input
								id="f-var"
								class="input input-sm w-full font-mono text-xs"
								value={field('variable') || 'result'}
								oninput={(e) => patch('variable', (e.target as HTMLInputElement).value)}
							/>
						</div>
						<div class="flex flex-col gap-1">
							<label class="text-base-content/60 text-xs font-medium" for="f-val"
								>Value / expression</label
							>
							<input
								id="f-val"
								class="input input-sm w-full font-mono text-xs"
								placeholder={'${.output}'}
								value={field('value')}
								oninput={(e) => patch('value', (e.target as HTMLInputElement).value)}
							/>
						</div>
					{/if}

					{#if nodeType === 'wait'}
						<div class="flex flex-col gap-1">
							<label class="text-base-content/60 text-xs font-medium" for="f-dur"
								>Duration (seconds)</label
							>
							<input
								id="f-dur"
								type="number"
								min="1"
								class="input input-sm w-full"
								value={numField('duration', 30)}
								oninput={(e) => patch('duration', Number((e.target as HTMLInputElement).value))}
							/>
						</div>
					{/if}

					{#if nodeType === 'run'}
						<div class="flex flex-col gap-1">
							<label class="text-base-content/60 text-xs font-medium" for="f-tn">Task name</label>
							<input
								id="f-tn"
								class="input input-sm w-full"
								value={field('taskName')}
								oninput={(e) => patch('taskName', (e.target as HTMLInputElement).value)}
							/>
						</div>
					{/if}

					{#if nodeType === 'childWorkflow'}
						<div class="flex flex-col gap-1">
							<label class="text-base-content/60 text-xs font-medium" for="f-wf"
								>Workflow name</label
							>
							<input
								id="f-wf"
								class="input input-sm w-full"
								value={field('workflowName')}
								oninput={(e) => patch('workflowName', (e.target as HTMLInputElement).value)}
							/>
						</div>
					{/if}
				</div>
			{:else}
				<div class="flex flex-col items-center justify-center gap-2 p-8 pt-16 text-center">
					<Settings2 size={28} class="text-base-content/15" />
					<p class="text-base-content/40 text-xs">Select a node to inspect its properties</p>
				</div>
			{/if}
		{:else}
			<div class="flex h-full flex-col">
				<div class="bg-base-200/60 border-base-200 border-b px-3 py-1.5">
					<span class="text-base-content/40 font-mono text-[10px] uppercase tracking-wider"
						>zigflow dsl · yaml</span
					>
				</div>
				<pre
					class="flex-1 overflow-auto p-4 font-mono text-[11px] leading-relaxed whitespace-pre text-base-content/80">{dsl}</pre>
			</div>
		{/if}
	</div>
</aside>
